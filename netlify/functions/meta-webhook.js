// Meta (Facebook/Instagram) Webhook — DM/댓글 수신 & 자동 응답
// 토큰은 ig_accounts_decrypted 뷰(service_role)에서만 조회. 평문 저장/로그 금지.
// 플랜별 분기: standard=응답 없음 / pro=키워드 매칭 / business=AI 자동응답
// Shadow mode 기본값=true (발송 없이 로그만 기록)
const crypto = require('crypto');
const { getAdminClient } = require('./_shared/supabase-admin');

const TEST_IG_USER_ID = process.env.TEST_IG_USER_ID || '';
const TEST_ACCESS_TOKEN = process.env.TEST_ACCESS_TOKEN || '';

// fail-closed: appSecret 미설정 시 false (모든 요청 차단).
// "환경변수 부재"는 프로덕션 설정 오류로 간주하고 상위에서 503 반환.
function verifySignature(payload, signature) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) return false;
  if (!signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(payload).digest('hex');
  try {
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch (e) {
    return false;
  }
}

async function callGraphAPI(path, method, body, accessToken) {
  const url = `https://graph.facebook.com/v25.0${path}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  // 시크릿/토큰이 포함될 수 있는 응답은 로그에서 제외 — 경로와 상태만 기록
  console.log(`[meta-webhook] Graph API ${method} ${path}`, data?.error ? 'error' : 'ok');
  return data;
}

// ig_accounts_decrypted 뷰에서 access_token + user_id 한 번에 조회 (service_role 전용)
async function getIgContext(supabase, igUserId) {
  if (igUserId === TEST_IG_USER_ID) {
    return {
      accessToken: TEST_ACCESS_TOKEN,
      userId: null,
      email: process.env.OWNER_EMAIL || 'gung3625@gmail.com',
    };
  }
  try {
    const { data, error } = await supabase
      .from('ig_accounts_decrypted')
      .select('access_token, user_id')
      .eq('ig_user_id', igUserId)
      .maybeSingle();
    if (error || !data) return null;

    let email = null;
    if (data.user_id) {
      const { data: user } = await supabase
        .from('users')
        .select('email')
        .eq('id', data.user_id)
        .maybeSingle();
      email = user?.email || null;
    }
    return { accessToken: data.access_token || null, userId: data.user_id || null, email };
  } catch (e) {
    console.error('[meta-webhook] getIgContext 실패:', e.message);
    return null;
  }
}

// users 테이블에서 plan 조회
async function getUserPlan(supabase, userId) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('plan, store_name, store_desc')
      .eq('id', userId)
      .maybeSingle();
    if (error || !data) return { plan: null, storeName: null, storeDesc: null };
    return { plan: data.plan || null, storeName: data.store_name || null, storeDesc: data.store_desc || null };
  } catch (e) {
    console.error('[meta-webhook] getUserPlan 실패:', e.message);
    return { plan: null, storeName: null, storeDesc: null };
  }
}

// store_context 조회. 없으면 빈 객체 반환.
async function getStoreContext(supabase, userId) {
  try {
    const { data, error } = await supabase
      .from('store_context')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      console.error('[meta-webhook] getStoreContext 오류:', error.message);
      return {};
    }
    return data || {};
  } catch (e) {
    console.error('[meta-webhook] getStoreContext 실패:', e.message);
    return {};
  }
}

// auto_reply_settings 조회. 없으면 기본값 insert 후 반환.
async function getOrCreateAutoReplySettings(supabase, userId) {
  try {
    const { data, error } = await supabase
      .from('auto_reply_settings')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      console.error('[meta-webhook] auto_reply_settings 조회 오류:', error.message);
      return null;
    }
    if (data) return data;

    // 없으면 기본값 insert
    const defaults = {
      user_id: userId,
      enabled: false,
      shadow_mode: true,
      keyword_rules: [],
      default_comment_reply: '감사합니다 😊 궁금한 점은 DM으로 문의해 주세요!',
      default_dm_reply: '안녕하세요! 메시지 감사해요 😊',
      negative_keyword_blocklist: ['비싸','별로','불만','환불','최악','맛없','이상해','짜증','실망'],
      ai_mode: false,
      ai_confidence_threshold: 0.85,
    };
    const { data: inserted, error: insertErr } = await supabase
      .from('auto_reply_settings')
      .insert(defaults)
      .select()
      .single();
    if (insertErr) {
      console.error('[meta-webhook] auto_reply_settings insert 실패:', insertErr.message);
      return defaults;
    }
    return inserted;
  } catch (e) {
    console.error('[meta-webhook] getOrCreateAutoReplySettings 실패:', e.message);
    return null;
  }
}

// auto_reply_log에 수신/판정/응답 기록
async function writeLog(supabase, logEntry) {
  try {
    await supabase.from('auto_reply_log').insert(logEntry);
  } catch (e) {
    console.error('[meta-webhook] writeLog 실패:', e.message);
  }
}

// 키워드 매칭 — pro 플랜용
function matchKeyword(text, keywordRules) {
  for (const item of (keywordRules || [])) {
    if (item.keyword && text.includes(item.keyword)) return item.reply;
  }
  return null;
}

// 부정 키워드 블록리스트 검사
function hasNegativeKeyword(text, blocklist) {
  return (blocklist || []).some((kw) => text.includes(kw));
}

// OpenAI 4o-mini 호출 — business 플랜 전용
// userId + supabase를 받아 auto_reply_corrections에서 최근 10개 샘플을 few-shot으로 주입
async function callAIReply(receivedText, eventType, storeName, storeDesc, storeCtx, userId, supabase) {
  const ctx = storeCtx || {};
  const storeBlock = [
    '[매장 정보]',
    `- 매장명: ${ctx.store_name || storeName || ''}`,
    `- 주소: ${ctx.address || ''}`,
    `- 전화: ${ctx.phone || ''}`,
    `- 영업시간: ${ctx.hours ? JSON.stringify(ctx.hours) : ''}`,
    `- 메뉴/서비스: ${ctx.menu_or_services || storeDesc || ''}`,
    `- 주차: ${ctx.parking || ''}`,
    `- 예약: ${ctx.reservation_url || ''}`,
    `- 오시는 길: ${ctx.directions || ''}`,
    `- 응대 말투: ${ctx.tone || '친근'}`,
    `- 특이사항: ${ctx.custom_notes || ''}`,
    '이 정보만 근거로 답변하고, 정보에 없는 내용은 "확인 후 답변드릴게요"로 회피.',
  ].join('\n');

  // 사장님이 과거에 직접 답한 샘플 조회 (few-shot learning)
  let learningBlock = '';
  if (userId && supabase) {
    try {
      const { data: corrections } = await supabase
        .from('auto_reply_corrections')
        .select('category, customer_message, correct_reply')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(10);

      const fewShot = (corrections || []).map((c) =>
        `[category=${c.category}] 고객: "${c.customer_message}" → 사장님 정답: "${c.correct_reply}"`
      ).join('\n');

      if (fewShot) {
        learningBlock = `\n\n## 사장님이 과거에 직접 답한 모범 예시 (반드시 이 톤·정보를 따를 것)\n${fewShot}\n`;
      }
    } catch (e) {
      console.error('[meta-webhook] corrections 조회 실패:', e.message);
    }
  }

  const systemPrompt = `당신은 인스타그램 매장 자동응답 AI입니다.
${storeBlock}${learningBlock}

수신된 ${eventType === 'comment' ? '댓글' : 'DM'}에 대해 아래 JSON 형식으로만 응답하세요.
답변은 친절하고 자연스러운 한국어로 작성하고, 30~80자 이내로 간결하게 작성하세요.
부정적이거나 민감한 내용은 escalate=true로 표시하고 reply는 빈 문자열로 두세요.

{
  "category": "spam|faq|booking|complaint|feedback|other",
  "sub_category": "string",
  "sentiment": "positive|negative|neutral",
  "confidence": 0.0~1.0,
  "escalate": true|false,
  "reply": "답변 텍스트 또는 빈 문자열"
}`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 300,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: receivedText },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API 오류: ${response.status}`);
  }

  const result = await response.json();
  const content = result.choices?.[0]?.message?.content || '{}';
  return JSON.parse(content);
}

// store_context 플레이스홀더 치환 — 값이 null/undefined면 플레이스홀더 삭제
function applyStoreContextPlaceholders(text, ctx) {
  if (!text || !ctx) return text;
  const hoursStr = ctx.hours ? JSON.stringify(ctx.hours) : null;
  return text
    .replace(/\{store_name\}/g, ctx.store_name || '')
    .replace(/\{address\}/g, ctx.address || '')
    .replace(/\{phone\}/g, ctx.phone || '')
    .replace(/\{hours\}/g, hoursStr || '')
    .replace(/\{reservation_url\}/g, ctx.reservation_url || '')
    .replace(/\{directions\}/g, ctx.directions || '');
}

// pro 플랜: 키워드 매칭 처리
async function handleKeywordReply(supabase, receivedText, eventType, senderId, igUserId, userId, settings, accessToken, storeCtx) {
  const matched = matchKeyword(receivedText, settings.keyword_rules);
  const rawReply = matched || (eventType === 'comment' ? settings.default_comment_reply : settings.default_dm_reply);
  const replyText = applyStoreContextPlaceholders(rawReply, storeCtx);

  const logEntry = {
    user_id: userId,
    ig_user_id: igUserId,
    event_type: eventType,
    received_text: receivedText,
    sender_id: senderId,
    category: matched ? 'faq' : 'other',
    sub_category: matched ? 'keyword_match' : 'default',
    sentiment: null,
    confidence: matched ? 1.0 : null,
    replied: false,
    reply_text: replyText,
    escalated: false,
    escalation_reason: null,
    shadow_mode: settings.shadow_mode,
  };

  if (!settings.shadow_mode) {
    await sendReply(eventType, igUserId, senderId, replyText, accessToken);
    logEntry.replied = true;
  }

  await writeLog(supabase, logEntry);
  console.log(`[meta-webhook] pro keyword reply — shadow=${settings.shadow_mode} matched=${!!matched}`);
}

// business 플랜: AI 자동응답 처리
// ai_mode=false면 키워드 매칭으로 폴백 (사장님이 AI 토글 끈 상태)
async function handleAIReply(supabase, receivedText, eventType, senderId, igUserId, userId, settings, accessToken, storeName, storeDesc, storeCtx) {
  if (!settings.ai_mode) {
    console.log('[meta-webhook] business plan but ai_mode=false — 키워드 폴백');
    await handleKeywordReply(supabase, receivedText, eventType, senderId, igUserId, userId, settings, accessToken, storeCtx);
    return;
  }

  let aiResult = null;
  let escalated = false;
  let escalationReason = null;
  let replyText = '';
  let category = 'other';
  let subCategory = null;
  let sentiment = null;
  let confidence = null;

  try {
    aiResult = await callAIReply(receivedText, eventType, storeName, storeDesc, storeCtx, userId, supabase);
    category = aiResult.category || 'other';
    subCategory = aiResult.sub_category || null;
    sentiment = aiResult.sentiment || null;
    confidence = typeof aiResult.confidence === 'number' ? aiResult.confidence : null;
    escalated = aiResult.escalate || false;
    replyText = aiResult.reply || '';
  } catch (e) {
    console.error('[meta-webhook] AI 호출 실패:', e.message);
    escalated = true;
    escalationReason = 'ai_error';
  }

  // 3단 안전장치
  if (!escalated && sentiment === 'negative') {
    escalated = true;
    escalationReason = 'negative_sentiment';
    replyText = '';
  }
  if (!escalated && hasNegativeKeyword(receivedText, settings.negative_keyword_blocklist)) {
    escalated = true;
    escalationReason = 'negative_keyword';
    replyText = '';
  }
  if (!escalated && confidence !== null && confidence < settings.ai_confidence_threshold) {
    escalated = true;
    escalationReason = 'low_confidence';
    replyText = '';
  }

  const logEntry = {
    user_id: userId,
    ig_user_id: igUserId,
    event_type: eventType,
    received_text: receivedText,
    sender_id: senderId,
    category,
    sub_category: subCategory,
    sentiment,
    confidence,
    replied: false,
    reply_text: replyText || null,
    escalated,
    escalation_reason: escalationReason,
    shadow_mode: settings.shadow_mode,
  };

  if (!escalated && replyText && !settings.shadow_mode) {
    await sendReply(eventType, igUserId, senderId, replyText, accessToken);
    logEntry.replied = true;
  }

  await writeLog(supabase, logEntry);
  console.log(`[meta-webhook] business AI reply — shadow=${settings.shadow_mode} escalated=${escalated} category=${category}`);
}

// Graph API 실발송 공통
async function sendReply(eventType, igUserId, senderId, replyText, accessToken) {
  if (eventType === 'comment') {
    await callGraphAPI(`/${senderId}/replies`, 'POST', { message: replyText }, accessToken);
  } else {
    await callGraphAPI(`/${igUserId}/messages`, 'POST', {
      recipient: { id: senderId },
      message: { text: replyText },
    }, accessToken);
  }
}

// 단일 이벤트(댓글 또는 DM) 처리 진입점
async function processEvent(supabase, entry, igUserId, userId, accessToken, planInfo) {
  const { plan, storeName, storeDesc } = planInfo;

  // standard 플랜: 자동응답 없음
  if (!plan || plan === 'standard' || plan === 'trial' || plan === 'free') {
    console.log(`[meta-webhook] plan=${plan} — 자동응답 건너뜀`);
    return;
  }

  const settings = await getOrCreateAutoReplySettings(supabase, userId);
  if (!settings) {
    console.error('[meta-webhook] settings 조회 실패 — 건너뜀');
    return;
  }

  // enabled=false: 로그 없이 종료 (아직 활성화 전)
  if (!settings.enabled) {
    console.log('[meta-webhook] auto_reply disabled — 건너뜀');
    return;
  }

  const storeCtx = await getStoreContext(supabase, userId);

  // 댓글 처리
  if (entry.changes) {
    for (const change of (entry.changes || [])) {
      if (change.field !== 'comments') continue;
      const commentId = change.value?.id;
      const commentText = change.value?.text || '';
      if (!commentId) continue;

      if (plan === 'pro') {
        await handleKeywordReply(supabase, commentText, 'comment', commentId, igUserId, userId, settings, accessToken, storeCtx);
      } else if (plan === 'business') {
        await handleAIReply(supabase, commentText, 'comment', commentId, igUserId, userId, settings, accessToken, storeName, storeDesc, storeCtx);
      }
    }
  }

  // DM 처리
  if (entry.messaging) {
    for (const messaging of (entry.messaging || [])) {
      const senderId = messaging.sender?.id;
      const messageText = messaging.message?.text || '';
      if (!senderId) continue;

      if (plan === 'pro') {
        await handleKeywordReply(supabase, messageText, 'dm', senderId, igUserId, userId, settings, accessToken, storeCtx);
      } else if (plan === 'business') {
        await handleAIReply(supabase, messageText, 'dm', senderId, igUserId, userId, settings, accessToken, storeName, storeDesc, storeCtx);
      }
    }
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'GET') {
    const params = new URLSearchParams(event.rawQuery || '');
    const mode = params.get('hub.mode');
    const token = params.get('hub.verify_token');
    const challenge = params.get('hub.challenge');
    const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;

    if (mode === 'subscribe' && token === verifyToken) {
      return { statusCode: 200, body: challenge };
    }
    return { statusCode: 403, body: 'Forbidden' };
  }

  if (event.httpMethod === 'POST') {
    // META_APP_SECRET 미설정은 프로덕션 설정 오류 — 503 반환 (fail-closed)
    if (!process.env.META_APP_SECRET) {
      console.error('[meta-webhook] META_APP_SECRET 미설정 — 요청 차단');
      return { statusCode: 503, body: 'Service Unavailable' };
    }
    const signature = event.headers['x-hub-signature-256'] || '';
    if (!verifySignature(event.body, signature)) {
      console.log('[meta-webhook] 서명 검증 실패');
      return { statusCode: 401, body: 'Invalid signature' };
    }

    let body;
    try { body = JSON.parse(event.body); } catch (e) {
      return { statusCode: 400, body: 'Bad Request' };
    }
    console.log('[meta-webhook] object=', body.object, 'entries=', body.entry?.length || 0);

    if (body.object && body.object !== 'instagram' && body.object !== 'page') {
      return { statusCode: 200, body: 'OK' };
    }

    const supabase = getAdminClient();

    for (const entry of (body.entry || [])) {
      try {
        const igUserId = entry.id;
        const ctx = await getIgContext(supabase, igUserId);
        if (!ctx?.accessToken || !ctx.userId) continue;

        const planInfo = await getUserPlan(supabase, ctx.userId);
        await processEvent(supabase, entry, igUserId, ctx.userId, ctx.accessToken, planInfo);
      } catch (e) {
        console.error('[meta-webhook] entry 처리 실패:', e.message);
      }
    }
    return { statusCode: 200, body: 'OK' };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
