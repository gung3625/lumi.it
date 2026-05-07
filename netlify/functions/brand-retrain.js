// 셀러 말투 프로파일 재학습 — brand-admin.html "재학습 시작" 버튼 백엔드.
// POST /api/brand-retrain
// 헤더: Authorization: Bearer <jwt> (관리자 only)
// Body: { sellerId?: "uuid", userId?: "uuid" }
//        - 둘 다 미전달 시 호출자 본인 (Bearer JWT 사용자)을 기본 대상으로.
//
// 동작:
//   1) admin-guard 통과 (users.is_admin = true 또는 환경변수 폴백 admin)
//   2) 대상 셀러 행 조회 (sellers.id 또는 sellers.email = users.email)
//   3) 학습 소스 수집:
//      - sellers.tone_sample_1/2/3 (NULL 허용)
//      - caption_history 최근 20개 (user_id = sellers.user_link)
//      - tone_feedback 최근 20개
//   4) OpenAI gpt-4o-mini로 프로파일 JSON 요약 (timeout 10초, 실패 시 통계 fallback)
//   5) sellers.tone_profile / tone_retrained_at 갱신
//   6) 결과 + sourceCount 응답
//
// 반환:
//   200 { ok:true, data:{ sellerId, profile, sourceCount, retrainedAt, source:'openai|fallback' } }
//   400 sellerId 형식 오류 / body 파싱 실패
//   401 미인증
//   403 비관리자
//   404 셀러 없음
//   500 서버 오류
//
// 주의:
//   - 이모지·해시태그 정량 가격 노출 없음 (셀러향 카피 룰).
//   - 캡션 raw 텍스트는 로그에 출력하지 않음 (개인정보 마스킹 룰).

const { getAdminClient } = require('./_shared/supabase-admin');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { requireAdmin } = require('./_shared/admin-guard');

const OPENAI_TIMEOUT_MS = 10_000;
const SOURCE_LIMIT = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ──────────────────────────────────────────────
// 학습 소스 수집
// ──────────────────────────────────────────────

// sellers row + (이메일이 매칭되는) users.id 조회.
// 반환: { seller, userId } | { error, status }
async function loadSellerAndUser(admin, target) {
  // target = { sellerId } | { userId }
  let sellerRow = null;

  if (target.sellerId) {
    const { data, error } = await admin
      .from('sellers')
      .select('id, email, tone_sample_1, tone_sample_2, tone_sample_3')
      .eq('id', target.sellerId)
      .maybeSingle();
    if (error) {
      console.error('[brand-retrain] sellers select 오류:', error.message);
      return { error: '셀러 조회 실패', status: 500 };
    }
    sellerRow = data;
  } else if (target.userId) {
    // userId(=users.id)로 시작 → users.email 거쳐 sellers row 매칭
    const { data: u, error: uErr } = await admin
      .from('users')
      .select('id, email')
      .eq('id', target.userId)
      .maybeSingle();
    if (uErr) {
      console.error('[brand-retrain] users select 오류:', uErr.message);
      return { error: '사용자 조회 실패', status: 500 };
    }
    if (!u) return { error: '사용자를 찾을 수 없습니다.', status: 404 };

    const { data: s, error: sErr } = await admin
      .from('sellers')
      .select('id, email, tone_sample_1, tone_sample_2, tone_sample_3')
      .eq('email', u.email)
      .maybeSingle();
    if (sErr) {
      console.error('[brand-retrain] sellers by email 오류:', sErr.message);
      return { error: '셀러 조회 실패', status: 500 };
    }
    sellerRow = s;
  }

  if (!sellerRow) {
    return { error: '셀러를 찾을 수 없습니다.', status: 404 };
  }

  // sellers.email → users.id 매칭 (caption_history/tone_feedback이 user_id 기반)
  let userId = null;
  if (sellerRow.email) {
    const { data: linkedUser, error: luErr } = await admin
      .from('users')
      .select('id')
      .eq('email', sellerRow.email)
      .maybeSingle();
    if (luErr) {
      console.warn('[brand-retrain] users by email 경고:', luErr.message);
    } else if (linkedUser) {
      userId = linkedUser.id;
    }
  }

  return { seller: sellerRow, userId };
}

// caption_history 최근 N개
async function fetchCaptionHistory(admin, userId, limit = SOURCE_LIMIT) {
  if (!userId) return [];
  try {
    const { data, error } = await admin
      .from('caption_history')
      .select('caption, caption_type, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.warn('[brand-retrain] caption_history 경고:', error.message);
      return [];
    }
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[brand-retrain] caption_history 예외:', e && e.message);
    return [];
  }
}

// tone_feedback 최근 N개 (kind, caption)
async function fetchToneFeedback(admin, userId, limit = SOURCE_LIMIT) {
  if (!userId) return [];
  try {
    const { data, error } = await admin
      .from('tone_feedback')
      .select('kind, caption, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.warn('[brand-retrain] tone_feedback 경고:', error.message);
      return [];
    }
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('[brand-retrain] tone_feedback 예외:', e && e.message);
    return [];
  }
}

// ──────────────────────────────────────────────
// 통계 기반 fallback 프로파일 (OpenAI 실패 시)
// ──────────────────────────────────────────────
function statsFallbackProfile(samples, captions, feedback) {
  const allTexts = [
    ...samples.filter(Boolean),
    ...captions.map((c) => c && c.caption).filter(Boolean),
  ];
  const totalLen = allTexts.reduce((a, t) => a + (t ? t.length : 0), 0);
  const avgLength = allTexts.length ? Math.round(totalLen / allTexts.length) : 0;

  // 이모지 비율 (대략적 — Unicode emoji 범위 일부)
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
  const emojiTotal = allTexts.reduce((a, t) => a + ((t.match(emojiRe) || []).length), 0);
  const emojiPerCaption = allTexts.length ? emojiTotal / allTexts.length : 0;
  const emojiUsage = emojiPerCaption < 0.3 ? 'rare' : emojiPerCaption < 1.5 ? 'often' : 'often';

  // 키워드 빈도 (한·영 단어, 2자 이상)
  const freq = new Map();
  const wordRe = /[\p{L}\p{N}_]{2,}/gu;
  for (const t of allTexts) {
    const ws = t.match(wordRe) || [];
    for (const w of ws) {
      const k = w.toLowerCase();
      freq.set(k, (freq.get(k) || 0) + 1);
    }
  }
  const preferredKeywords = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map((e) => e[0]);

  // 정중/캐주얼 — '습니다/세요' 비율 vs '~요/!' 빈도
  const formal = allTexts.reduce(
    (a, t) => a + (t.match(/(습니다|드립니다|세요|입니다)/g) || []).length,
    0
  );
  const casual = allTexts.reduce((a, t) => a + (t.match(/(!{1,}|ㅎ{2,}|ㅋ{2,}|굿|짱)/g) || []).length, 0);
  const tone = formal > casual * 1.5 ? '정중' : casual > formal * 1.2 ? '친근' : '중립';

  const likes = feedback.filter((f) => f && f.kind === 'like').length;
  const dislikes = feedback.filter((f) => f && f.kind === 'dislike').length;

  return {
    tone,
    avgLength,
    emojiUsage,
    preferredKeywords,
    notes: `통계 기반 fallback. like=${likes} dislike=${dislikes}.`,
  };
}

// ──────────────────────────────────────────────
// OpenAI gpt-4o-mini로 프로파일 요약
// ──────────────────────────────────────────────
async function summarizeWithOpenAI(samples, captions, feedback) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY 미설정');
  }

  const sampleBlock = samples
    .map((s, i) => (s ? `샘플${i + 1}: ${String(s).slice(0, 400)}` : null))
    .filter(Boolean)
    .join('\n');

  const captionBlock = captions
    .map((c, i) => `#${i + 1} [${c.caption_type || 'posted'}] ${String(c.caption || '').slice(0, 400)}`)
    .join('\n');

  const feedbackBlock = feedback
    .map((f, i) => `#${i + 1} [${f.kind}] ${String(f.caption || '').slice(0, 240)}`)
    .join('\n');

  const userInput = [
    sampleBlock && `# 셀러가 직접 입력한 말투 샘플\n${sampleBlock}`,
    captionBlock && `# 최근 캡션 이력 (최신 ${captions.length}개)\n${captionBlock}`,
    feedbackBlock && `# 최근 피드백 (like=좋아요/dislike=싫어요)\n${feedbackBlock}`,
  ].filter(Boolean).join('\n\n');

  const systemPrompt =
    '너는 한국 SNS 셀러의 캡션을 분석해서 말투 프로파일을 JSON으로 요약하는 분석가다.\n' +
    '반드시 valid JSON 객체 하나만 출력해. 설명·markdown·코드펜스 금지.\n' +
    '키:\n' +
    '- tone: "정중" | "친근" | "유머" | "중립" 중 하나\n' +
    '- avgLength: 평균 캡션 길이 (정수, 글자 수)\n' +
    '- emojiUsage: "never" | "rare" | "often" 중 하나\n' +
    '- preferredKeywords: 자주 쓰는 한국어 단어/짧은 표현 상위 10개 배열\n' +
    '- notes: 특이사항·말투 한 줄 요약 (한국어, 80자 이내)';

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), OPENAI_TIMEOUT_MS);

  let res;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userInput || '입력 데이터 없음. 기본값으로 응답.' },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(tid);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`openai HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const json = await res.json();
  const raw = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!raw || typeof raw !== 'string') {
    throw new Error('openai 응답 본문 없음');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('openai JSON 파싱 실패');
  }

  // 안전한 정규화
  const out = {
    tone: typeof parsed.tone === 'string' ? parsed.tone.slice(0, 20) : '중립',
    avgLength: Number.isFinite(parsed.avgLength) ? Math.round(parsed.avgLength) : 0,
    emojiUsage: ['never', 'rare', 'often'].includes(parsed.emojiUsage) ? parsed.emojiUsage : 'rare',
    preferredKeywords: Array.isArray(parsed.preferredKeywords)
      ? parsed.preferredKeywords.slice(0, 10).map((s) => String(s).slice(0, 30))
      : [],
    notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 200) : '',
  };
  return out;
}

// ──────────────────────────────────────────────
// 핸들러
// ──────────────────────────────────────────────
exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: 'Method not allowed' }),
    };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[brand-retrain] admin client 초기화 실패:', e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: '서버 설정 오류입니다.' }),
    };
  }

  // 관리자 권한 체크
  const guard = await requireAdmin(event, admin);
  if (!guard.ok) {
    return {
      statusCode: guard.status,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: guard.error }),
    };
  }

  // body 파싱
  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: '잘못된 요청 형식입니다.' }),
    };
  }

  // 대상 결정
  const target = {};
  if (body.sellerId) {
    if (!UUID_RE.test(String(body.sellerId))) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ ok: false, error: 'sellerId 형식이 올바르지 않습니다.' }),
      };
    }
    target.sellerId = String(body.sellerId);
  } else if (body.userId) {
    if (!UUID_RE.test(String(body.userId))) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ ok: false, error: 'userId 형식이 올바르지 않습니다.' }),
      };
    }
    target.userId = String(body.userId);
  } else {
    // 본인 (호출 admin의 user.id) → users.email → sellers.email 매칭
    target.userId = guard.user.id;
  }

  // 셀러 + user 매칭
  const found = await loadSellerAndUser(admin, target);
  if (found.error) {
    return {
      statusCode: found.status,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: found.error }),
    };
  }

  const seller = found.seller;
  const userId = found.userId;

  // 학습 소스 수집
  const samples = [seller.tone_sample_1, seller.tone_sample_2, seller.tone_sample_3].filter(
    (s) => typeof s === 'string' && s.trim().length > 0
  );
  const [captions, feedback] = await Promise.all([
    fetchCaptionHistory(admin, userId, SOURCE_LIMIT),
    fetchToneFeedback(admin, userId, SOURCE_LIMIT),
  ]);

  // 프로파일 산출 — OpenAI 우선, 실패 시 통계 fallback
  let profile = null;
  let profileSource = 'openai';
  try {
    profile = await summarizeWithOpenAI(samples, captions, feedback);
  } catch (e) {
    console.warn('[brand-retrain] openai 실패 → fallback:', e && e.message);
    profile = statsFallbackProfile(samples, captions, feedback);
    profileSource = 'fallback';
  }

  // sellers 갱신 (best-effort 저장 — 실패해도 응답은 정상)
  const retrainedAt = new Date().toISOString();
  let savedOk = true;
  try {
    const { error: upErr } = await admin
      .from('sellers')
      .update({ tone_profile: profile, tone_retrained_at: retrainedAt })
      .eq('id', seller.id);
    if (upErr) {
      console.error('[brand-retrain] sellers UPDATE 오류:', upErr.message);
      savedOk = false;
    }
  } catch (e) {
    console.error('[brand-retrain] sellers UPDATE 예외:', e && e.message);
    savedOk = false;
  }

  console.log(
    `[brand-retrain] admin=${String(guard.user.id).slice(0, 8)} seller=${String(seller.id).slice(0, 8)} ` +
      `samples=${samples.length} captions=${captions.length} feedback=${feedback.length} src=${profileSource} saved=${savedOk}`
  );

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      data: {
        sellerId: seller.id,
        profile,
        sourceCount: {
          captions: captions.length,
          feedback: feedback.length,
          samples: samples.length,
        },
        retrainedAt,
        source: profileSource,
        saved: savedOk,
      },
    }),
  };
};
