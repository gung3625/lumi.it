const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const SITE_ID = process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc';
const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN;

const TEST_IG_USER_ID = process.env.TEST_IG_USER_ID || '';
const TEST_ACCESS_TOKEN = process.env.TEST_IG_ACCESS_TOKEN || '';

// --- [기존 헬퍼 함수 유지] ---
function verifySignature(payload, signature) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) return true;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(payload).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); } 
  catch(e) { return false; }
}

async function callGraphAPI(path, method, body, accessToken) {
  const url = `https://graph.facebook.com/v25.0${path}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  console.log(`[lumi] Graph API ${method} ${path}:`, JSON.stringify(data));
  return data;
}

async function getUserToken(igUserId) {
  if (igUserId === TEST_IG_USER_ID) return TEST_ACCESS_TOKEN;
  try {
    const store = getStore({ name: 'users', siteID: SITE_ID, token: NETLIFY_TOKEN });
    const raw = await store.get('ig:' + igUserId);
    return raw ? JSON.parse(raw).accessToken : null;
  } catch(e) { return null; }
}

async function getAutoReplySettings(email) {
  try {
    const store = getStore({ name: 'auto-replies', siteID: SITE_ID, token: NETLIFY_TOKEN });
    const raw = await store.get('reply:' + email);
    return raw ? JSON.parse(raw) : null;
  } catch(e) { return null; }
}

async function getEmailByIgId(igUserId) {
  if (igUserId === TEST_IG_USER_ID) return 'gung3625@gmail.com';
  try {
    const store = getStore({ name: 'users', siteID: SITE_ID, token: NETLIFY_TOKEN });
    const raw = await store.get('ig:' + igUserId);
    return raw ? JSON.parse(raw).email : null;
  } catch(e) { return null; }
}

function matchKeyword(text, keywords) {
  for (const item of keywords) {
    if (item.keyword && text.includes(item.keyword)) return item.reply;
  }
  return null;
}

// --- [이벤트 핸들러 유지] ---
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
    message: { text: replyText }
  }, accessToken);
}

// --- [메인 핸들러: 수정된 핵심 로직] ---
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
    // [중요] 모든 신호를 가감 없이 로그로 남깁니다.
    console.log('[lumi] Webhook RAW DATA:', event.body);

    let body;
    try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400 }; }

    // Instagram 데이터가 아니어도 '성공' 응답은 보내서 Meta의 재전송을 막습니다.
    if (body.object && (body.object !== 'instagram' && body.object !== 'page')) {
      return { statusCode: 200, body: 'OK' };
    }

    for (const entry of (body.entry || [])) {
      const igUserId = entry.id;
      const accessToken = await getUserToken(igUserId);
      
      // 토큰이 있는 실제 사용자 이벤트만 처리
      if (accessToken) {
        const email = await getEmailByIgId(igUserId);
        const settings = email ? await getAutoReplySettings(email) : null;
        if (entry.changes) await handleComment(entry, accessToken, settings);
        if (entry.messaging) await handleMessage(entry, accessToken, settings);
      }
    }
    return { statusCode: 200, body: 'OK' };
  }
  return { statusCode: 405, body: 'Method Not Allowed' };
};
