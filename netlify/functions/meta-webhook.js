const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const SITE_ID = process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc';
const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN;

const TEST_IG_USER_ID = '17841471744588526';
const TEST_ACCESS_TOKEN = 'EAARhZCSGf1s4BRMPGzLKLxKncviHIaYW6EflYeZBloZAo2X39Epx0wH7TKChFChcarm93qhc05lZBKGZAWb43hTTWKEXO9OQvCZAIL6KkylFJWWggEf6ZBadMcZAGgC30xY0yEXKwGiSIHEHGAwtB3ZAR7s58WHKY3u2ZCuarSOQ2OuKhF7zIkZBNmgbs4WIYQEo4ZBSNkJQZAzcRdy7ES4yUotZAGffQmNA4IYVlFIkDIQL54GhLeLX3ErqjH6lTpALO1p9ItkSUmXDrhhM9gLZClcOHZB6BD5BIXTc';

function verifySignature(payload, signature) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) return true;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(payload)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch(e) { return false; }
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
    if (!raw) return null;
    return JSON.parse(raw).accessToken || null;
  } catch(e) {
    console.error('[lumi] 토큰 조회 오류:', e.message);
    return null;
  }
}

async function getAutoReplySettings(email) {
  try {
    const store = getStore({ name: 'auto-replies', siteID: SITE_ID, token: NETLIFY_TOKEN });
    const raw = await store.get('reply:' + email);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch(e) {
    console.error('[lumi] 자동응답 설정 조회 오류:', e.message);
    return null;
  }
}

async function getEmailByIgId(igUserId) {
  if (igUserId === TEST_IG_USER_ID) return 'gung3625@gmail.com';
  try {
    const store = getStore({ name: 'users', siteID: SITE_ID, token: NETLIFY_TOKEN });
    const raw = await store.get('ig:' + igUserId);
    if (!raw) return null;
    return JSON.parse(raw).email || null;
  } catch(e) { return null; }
}

function matchKeyword(text, keywords) {
  for (const item of keywords) {
    if (item.keyword && text.includes(item.keyword)) {
      return item.reply;
    }
  }
  return null;
}

async function handleComment(entry, accessToken, settings) {
  const change = entry.changes?.[0];
  if (!change || change.field !== 'comments') return;

  const commentId = change.value?.id;
  const commentText = change.value?.text || '';
  const fromId = change.value?.from?.id;
  const igUserId = entry.id;

  if (!commentId || !accessToken) return;
  if (fromId === igUserId) return;

  console.log('[lumi] 댓글 수신:', commentText);

  let replyText = settings?.comment?.defaultReply || '감사합니다 😊 궁금한 점은 DM으로 문의해 주세요!';

  if (settings?.comment?.keywords?.length > 0) {
    const matched = matchKeyword(commentText, settings.comment.keywords);
    if (matched) replyText = matched;
  }

  await callGraphAPI(`/${commentId}/replies`, 'POST', { message: replyText }, accessToken);
  console.log('[lumi] 댓글 자동 답변 완료:', commentId, '->', replyText);
}

async function handleMessage(entry, accessToken, settings) {
  const messaging = entry.messaging?.[0];
  if (!messaging) return;

  const senderId = messaging.sender?.id;
  const messageText = messaging.message?.text || '';
  const igUserId = entry.id;

  if (!senderId || !accessToken) return;
  if (senderId === igUserId) return;

  console.log('[lumi] DM 수신:', messageText, '발신자:', senderId);

  let replyText = settings?.dm?.defaultReply || '안녕하세요! 메시지 감사해요 😊 빠르게 확인 후 답변드릴게요!';

  if (settings?.dm?.keywords?.length > 0) {
    const matched = matchKeyword(messageText, settings.dm.keywords);
    if (matched) replyText = matched;
  }

  await callGraphAPI(`/${igUserId}/messages`, 'POST', {
    recipient: { id: senderId },
    message: { text: replyText }
  }, accessToken);
  console.log('[lumi] DM 자동 답변 완료:', senderId, '->', replyText);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'GET') {
    const params = new URLSearchParams(event.rawQuery || '');
    const mode = params.get('hub.mode');
    const token = params.get('hub.verify_token');
    const challenge = params.get('hub.challenge');
    const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;

    console.log('[lumi] Webhook 인증 요청:', { mode, token, challenge });

    if (mode === 'subscribe' && token === verifyToken) {
      console.log('[lumi] Webhook 인증 성공');
      return { statusCode: 200, body: challenge };
    }
    return { statusCode: 403, body: 'Forbidden' };
  }

  if (event.httpMethod === 'POST') {
    const signature = event.headers['x-hub-signature-256'] || '';
    if (signature && !verifySignature(event.body, signature)) {
      console.error('[lumi] 서명 검증 실패');
      return { statusCode: 401, body: 'Unauthorized' };
    }

    let body;
    try { body = JSON.parse(event.body); }
    catch(e) { return { statusCode: 400, body: 'Bad Request' }; }

    console.log('[lumi] Webhook 수신:', JSON.stringify(body));

    if (body.object !== 'instagram') return { statusCode: 200, body: 'OK' };

    for (const entry of (body.entry || [])) {
      const igUserId = entry.id;
      const accessToken = await getUserToken(igUserId);
      if (!accessToken) { console.log('[lumi] 토큰 없음:', igUserId); continue; }

      // 고객 자동 응답 설정 불러오기
      const email = await getEmailByIgId(igUserId);
      const settings = email ? await getAutoReplySettings(email) : null;

      if (entry.changes) await handleComment(entry, accessToken, settings);
      if (entry.messaging) await handleMessage(entry, accessToken, settings);
    }

    return { statusCode: 200, body: 'OK' };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
