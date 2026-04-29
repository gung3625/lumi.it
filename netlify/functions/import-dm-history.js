// IG DM 과거 대화 가져오기 → 사장님 답변 샘플로 auto_reply_corrections에 저장
// POST /api/import-dm-history — Bearer 토큰 인증 필수
// 비즈니스 플랜 또는 관리자만 허용
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { isAdminEmail, isAdminUserId } = require('./_shared/admin');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const GRAPH_VERSION = 'v25.0';
const MAX_CONVERSATIONS = 25;
const MAX_MESSAGES_PER_CONVERSATION = 30;
const MAX_SAMPLES = 50;
const MIN_REPLY_LENGTH = 10;
const MAX_AGE_DAYS = 180;
const OPENAI_CONCURRENCY = 5;

// 6개월 컷오프 — ISO 시각 비교용
function isWithinMaxAge(isoTime) {
  if (!isoTime) return false;
  const t = Date.parse(isoTime);
  if (Number.isNaN(t)) return false;
  const ageMs = Date.now() - t;
  return ageMs >= 0 && ageMs <= MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

// Graph API 호출 — 토큰은 쿼리스트링으로 전달 (웹훅 파일 규칙 유지)
async function graphGet(path, accessToken) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://graph.facebook.com/${GRAPH_VERSION}${path}${sep}access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url, { method: 'GET' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    const code = data?.error?.code || res.status;
    const err = new Error(`Graph API 오류 (${code}): ${msg}`);
    err.graphError = data?.error || { message: msg };
    err.statusCode = res.status;
    throw err;
  }
  return data;
}

// 대화별 메시지에서 (고객 메시지 → 사장님 답변) 페어 추출
function extractPairs(messages, igUserId) {
  // messages는 최신순으로 옴 → 시간순으로 뒤집기
  const ordered = [...(messages || [])].reverse();
  const pairs = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const cur = ordered[i];
    const nxt = ordered[i + 1];
    const curFrom = cur?.from?.id;
    const nxtFrom = nxt?.from?.id;
    if (!curFrom || !nxtFrom) continue;
    // 고객 → 사장님 순서여야 함
    if (curFrom === igUserId) continue;
    if (nxtFrom !== igUserId) continue;
    const customerMsg = (cur.message || '').trim();
    const ownerReply = (nxt.message || '').trim();
    if (!customerMsg || !ownerReply) continue;
    if (ownerReply.length < MIN_REPLY_LENGTH) continue;
    if (!isWithinMaxAge(nxt.created_time || cur.created_time)) continue;
    pairs.push({
      customer_message: customerMsg,
      correct_reply: ownerReply,
      created_time: nxt.created_time || cur.created_time,
    });
  }
  return pairs;
}

// 완전히 동일한 사장님 답변 중복 제거 (첫 번째만 유지)
function dedupePairs(pairs) {
  const seen = new Set();
  const out = [];
  for (const p of pairs) {
    if (seen.has(p.correct_reply)) continue;
    seen.add(p.correct_reply);
    out.push(p);
  }
  return out;
}

// 정규식 기반 기본 PII 마스킹 — OpenAI 단계를 우회해도 원문이 저장되지 않게 belt-and-suspenders.
function maskPII(text) {
  if (!text) return text;
  return String(text)
    // 주민등록번호 (6자리-7자리)
    .replace(/\b\d{6}[-\s]?[1-4]\d{6}\b/g, '[주민번호]')
    // 신용카드 번호 (13~19자리 연속 또는 4자리-4자리 패턴)
    .replace(/\b\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{4}\b/g, '[카드]')
    .replace(/\b\d{13,19}\b/g, '[번호]')
    // 전화번호 (국내 휴대폰 + 국번)
    .replace(/\b01[016789][-\s]?\d{3,4}[-\s]?\d{4}\b/g, '[전화]')
    .replace(/\b0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}\b/g, '[전화]')
    // 이메일
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[이메일]');
}

// OpenAI gpt-4o-mini로 카테고리 분류 + 개인정보 마스킹
async function classifyAndSanitize(pair) {
  const sys = [
    '다음 IG DM 대화를 카테고리 분류하고 개인정보를 마스킹하라.',
    '카테고리는 menu/booking/price/location/hours/complaint/greeting/other 중 하나.',
    '전화번호·이름·주소·이메일·실명·주민번호·카드번호를 [전화]/[이름]/[주소]/[이메일]/[주민번호]/[카드]로 치환.',
    'JSON 반환: {category, customer_message_sanitized, correct_reply_sanitized}',
  ].join('\n');
  const safeMessage = maskPII(pair.customer_message);
  const safeReply = maskPII(pair.correct_reply);
  const user = `고객 메시지: ${safeMessage}\n사장님 답변: ${safeReply}`;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI 오류: ${res.status}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '{}';
  let parsed;
  try { parsed = JSON.parse(content); } catch { parsed = {}; }
  const allowed = ['menu','booking','price','location','hours','complaint','greeting','other'];
  const category = allowed.includes(parsed.category) ? parsed.category : 'other';
  // 2차 정규식 마스킹 — OpenAI 결과에 PII가 남아있을 가능성 차단 (belt-and-suspenders)
  const customer = maskPII((parsed.customer_message_sanitized || '').trim());
  const reply = maskPII((parsed.correct_reply_sanitized || '').trim());
  if (!customer || !reply) return null;
  return { category, customer_message: customer, correct_reply: reply };
}

// 병렬 처리 (최대 N개씩) — 실패한 페어는 스킵
async function classifyInBatches(pairs, concurrency) {
  const results = [];
  for (let i = 0; i < pairs.length; i += concurrency) {
    const batch = pairs.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map((p) => classifyAndSanitize(p)));
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) results.push(s.value);
    }
  }
  return results;
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // 1. Bearer 토큰 검증
  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  const admin = getAdminClient();

  try {
    // 2. 비즈니스 또는 관리자만 허용
    const { data: userData, error: userErr } = await admin
      .from('users')
      .select('plan, is_admin, email')
      .eq('id', user.id)
      .maybeSingle();
    if (userErr || !userData) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '사용자 조회 실패' }) };
    }
    const plan = userData.plan || 'trial';
    const isAdmin = isAdminEmail(user.email) || isAdminEmail(userData.email) || userData.is_admin === true || isAdminUserId(user.id);
    const effectivePlan = isAdmin ? 'business' : plan;
    if (effectivePlan !== 'business') {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: '비즈니스 플랜에서만 사용할 수 있어요.' }) };
    }

    // 3. IG 계정 조회 (평문 토큰은 ig_accounts_decrypted 뷰에서)
    //    /{ig_user}/conversations 는 page access token 필수 → page_access_token 우선.
    const { data: igAccount, error: igErr } = await admin
      .from('ig_accounts_decrypted')
      .select('ig_user_id, access_token, page_access_token')
      .eq('user_id', user.id)
      .maybeSingle();
    if (igErr) {
      console.error('[import-dm-history] ig_accounts 조회 오류:', igErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'IG 계정 조회 실패' }) };
    }
    if (!igAccount || !igAccount.ig_user_id || !(igAccount.page_access_token || igAccount.access_token)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'IG 연동 필요' }) };
    }

    const igUserId = igAccount.ig_user_id;
    const accessToken = igAccount.page_access_token || igAccount.access_token;

    // 4. conversations 목록 조회
    let conversations;
    try {
      const convResp = await graphGet(
        `/${igUserId}/conversations?platform=instagram&fields=id,updated_time&limit=${MAX_CONVERSATIONS}`,
        accessToken,
      );
      conversations = Array.isArray(convResp?.data) ? convResp.data : [];
    } catch (e) {
      const gErr = e.graphError || {};
      const code = Number(gErr.code);
      const subcode = Number(gErr.error_subcode);
      const gMsg = gErr.message || e.message || '';
      console.error(`[import-dm-history] conversations 실패 code=${code} subcode=${subcode} msg=${gMsg}`);

      let userMsg;
      let reason; // 내부 분류 태그
      if (code === 3 || /capability to make this API call/i.test(gMsg)) {
        userMsg = '루미가 아직 메타의 DM 접근 권한 심사를 받고 있어요. 심사 통과 후 자동으로 사용할 수 있어요.';
        reason = 'app_review_pending';
      } else if (code === 190) {
        userMsg = '인스타 토큰이 만료됐어요. 설정에서 재연동해주세요.';
        reason = 'token_expired';
      } else if (code === 10 || code === 200 || code === 803 || /permission|scope|messag(e|ing)/i.test(gMsg)) {
        userMsg = 'DM 조회 권한이 없어요. 재연동 시 메시지 권한(instagram_manage_messages)을 허용해주세요.';
        reason = 'permission_missing';
      } else if (code === 4 || code === 17 || code === 32 || code === 613) {
        userMsg = '메타 API 요청 한도를 초과했어요. 잠시 후 다시 시도해주세요.';
        reason = 'rate_limited';
      } else if (code === 100) {
        userMsg = '인스타 계정이 비즈니스 계정으로 전환되지 않았어요. 프로필 → 계정 유형 전환 후 재연동해주세요.';
        reason = 'not_business_account';
      } else {
        userMsg = `DM 불러오기에 실패했어요 (code=${code || '?'}).`;
        reason = 'graph_unknown';
      }

      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({ error: userMsg, reason, code: code || null, subcode: subcode || null }),
      };
    }

    console.log(`[import-dm-history] user=${user.id} conversations=${conversations.length}`);

    // 5. 각 대화의 메시지 병렬 조회 (부분 실패 허용)
    const convResults = await Promise.allSettled(
      conversations.map((c) =>
        graphGet(
          `/${c.id}?fields=messages.limit(${MAX_MESSAGES_PER_CONVERSATION}){from,message,created_time}`,
          accessToken,
        ),
      ),
    );

    // 6. 페어 추출 + 중복 제거
    let allPairs = [];
    for (const r of convResults) {
      if (r.status !== 'fulfilled') continue;
      const msgs = r.value?.messages?.data || [];
      const pairs = extractPairs(msgs, igUserId);
      allPairs = allPairs.concat(pairs);
    }
    allPairs = dedupePairs(allPairs);
    // 최신순 정렬 후 최대 N개
    allPairs.sort((a, b) => Date.parse(b.created_time || 0) - Date.parse(a.created_time || 0));
    allPairs = allPairs.slice(0, MAX_SAMPLES);

    console.log(`[import-dm-history] user=${user.id} candidate_pairs=${allPairs.length}`);

    if (allPairs.length === 0) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ success: true, imported: 0, by_category: {}, sample_ids: [] }),
      };
    }

    // 7. gpt-4o-mini 병렬 분류/마스킹 (실패 스킵)
    const classified = await classifyInBatches(allPairs, OPENAI_CONCURRENCY);

    if (classified.length === 0) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ success: true, imported: 0, by_category: {}, sample_ids: [] }),
      };
    }

    // 8. auto_reply_corrections insert
    const rows = classified.map((c) => ({
      user_id: user.id,
      category: c.category,
      customer_message: c.customer_message,
      correct_reply: c.correct_reply,
    }));

    const { data: inserted, error: insertErr } = await admin
      .from('auto_reply_corrections')
      .insert(rows)
      .select('id, category');

    if (insertErr) {
      console.error('[import-dm-history] insert 오류:', insertErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '샘플 저장 실패' }) };
    }

    const byCategory = {};
    for (const row of inserted || []) {
      byCategory[row.category] = (byCategory[row.category] || 0) + 1;
    }
    const sampleIds = (inserted || []).map((r) => r.id).slice(0, 20);

    console.log(`[import-dm-history] user=${user.id} imported=${inserted?.length || 0}`);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        imported: inserted?.length || 0,
        by_category: byCategory,
        sample_ids: sampleIds,
      }),
    };
  } catch (err) {
    console.error('[import-dm-history] 예외:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message || '서버 오류' }) };
  }
};
