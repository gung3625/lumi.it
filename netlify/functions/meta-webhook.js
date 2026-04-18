// Meta (Facebook/Instagram) Webhook — DM/댓글 수신 & 자동 응답
// 토큰은 ig_accounts_decrypted 뷰(service_role)에서만 조회. 평문 저장/로그 금지.
const crypto = require('crypto');
const { getAdminClient } = require('./_shared/supabase-admin');

const TEST_IG_USER_ID = process.env.TEST_IG_USER_ID || '';
const TEST_ACCESS_TOKEN = process.env.TEST_IG_ACCESS_TOKEN || '';

function verifySignature(payload, signature) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) return true;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
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

    // user_id로 email 조회 (알림톡 등에 필요 시 확장)
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

// 자동응답 설정 조회 (auto_replies 테이블은 현재 스키마에 없음 → 환경에 따라 안전 반환)
// 향후 테이블이 추가되면 이 함수만 확장하면 됨.
async function getAutoReplySettings(/* supabase, userId */) {
  return null;
}

function matchKeyword(text, keywords) {
  for (const item of keywords) {
    if (item.keyword && text.includes(item.keyword)) return item.reply;
  }
  return null;
}

async function handleComment(entry, accessToken, settings) {
  const change = entry.changes?.[0];
  if (!change || change.field !== 'comments') return;
  const commentId = change.value?.id;
  const commentText = change.value?.text || '';
  if (!commentId || !accessToken) return;

  let replyText = settings?.comment?.defaultReply || '감사합니다 😊 궁금한 점은 DM으로 문의해 주세요!';
  if (settings?.comment?.keywords?.length > 0) {
    const matched = matchKeyword(commentText, settings.comment.keywords);
    if (matched) replyText = matched;
  }
  await callGraphAPI(`/${commentId}/replies`, 'POST', { message: replyText }, accessToken);
}

async function handleMessage(entry, accessToken, settings) {
  const messaging = entry.messaging?.[0];
  if (!messaging) return;
  const senderId = messaging.sender?.id;
  const messageText = messaging.message?.text || '';
  const igUserId = entry.id;
  if (!senderId || !accessToken) return;

  let replyText = settings?.dm?.defaultReply || '안녕하세요! 메시지 감사해요 😊';
  if (settings?.dm?.keywords?.length > 0) {
    const matched = matchKeyword(messageText, settings.dm.keywords);
    if (matched) replyText = matched;
  }
  await callGraphAPI(`/${igUserId}/messages`, 'POST', {
    recipient: { id: senderId },
    message: { text: replyText },
  }, accessToken);
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
        if (ctx?.accessToken) {
          const settings = ctx.userId ? await getAutoReplySettings(supabase, ctx.userId) : null;
          if (entry.changes) await handleComment(entry, ctx.accessToken, settings);
          if (entry.messaging) await handleMessage(entry, ctx.accessToken, settings);
        }
      } catch (e) {
        console.error('[meta-webhook] entry 처리 실패:', e.message);
      }
    }
    return { statusCode: 200, body: 'OK' };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
