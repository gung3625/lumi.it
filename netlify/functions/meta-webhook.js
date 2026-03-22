const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const SITE_ID = process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc';
const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN;

// 테스트 계정 토큰 (심사 통과 전까지 하드코딩)
const TEST_IG_USER_ID = '17841471744588526';
const TEST_ACCESS_TOKEN = 'EAARhZCSGf1s4BRNUkXnJx1w60ZCFo2i5CvpL7uUOT7FldR7kAjDNSauXyFEk8t5bGxjkHW94LmnPNdt9Npxd6H3pl68xyyQcssZC7ZAy2AtaHbCaZC5L8THHI95swG1gM6u86TwqZAzVkCLaFRmBvakWZAxDxPRXa2GTYCtH30xb3Klyn4Dw1FFZCO616yslgkXGFGPFr6sFTNuOGMaI4ENa1idFC9igmPChTT8LrdEcoV47ikgkZB1HvaXpCjFBCjKB458B5Yol7MdMlbnDuH5um5LlZBCoP9';

function verifySignature(payload, signature) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) return true; // 개발 모드에서는 스킵
  const expected = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(payload)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch(e) {
    return false;
  }
}

async function callGraphAPI(path, method, body, accessToken) {
  const url = `https://graph.facebook.com/v25.0${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  console.log(`[lumi] Graph API ${method} ${path}:`, JSON.stringify(data));
  return data;
}

async function getUserToken(igUserId) {
  // 테스트 계정이면 하드코딩 토큰 사용
  if (igUserId === TEST_IG_USER_ID) {
    return TEST_ACCESS_TOKEN;
  }
  // 실제 고객은 Blobs에서 조회
  try {
    const store = getStore({
      name: 'users',
      siteID: SITE_ID,
      token: NETLIFY_TOKEN
    });
    const raw = await store.get('ig:' + igUserId);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data.accessToken || null;
  } catch(e) {
    console.error('[lumi] 토큰 조회 오류:', e.message);
    return null;
  }
}

async function handleComment(entry, accessToken) {
  const change = entry.changes?.[0];
  if (!change || change.field !== 'comments') return;

  const commentId = change.value?.id;
  const commentText = change.value?.text || '';
  const fromId = change.value?.from?.id;
  const igUserId = entry.id;

  if (!commentId || !accessToken) return;
  if (fromId === igUserId) return; // 자기 댓글은 스킵

  console.log('[lumi] 댓글 수신:', commentText);

  let replyText = '감사합니다 😊 궁금한 점은 DM으로 문의해 주세요!';
  if (commentText.includes('가격') || commentText.includes('얼마')) {
    replyText = '가격 문의는 DM으로 편하게 연락 주세요 🙏';
  } else if (commentText.includes('예약') || commentText.includes('주문')) {
    replyText = '예약/주문 문의는 DM으로 연락 주세요! 빠르게 답변드릴게요 ✨';
  } else if (commentText.includes('위치') || commentText.includes('어디')) {
    replyText = '위치 정보는 프로필 링크에서 확인하실 수 있어요 📍';
  }

  await callGraphAPI(`/${commentId}/replies`, 'POST', {
    message: replyText
  }, accessToken);

  console.log('[lumi] 댓글 자동 답변 완료:', commentId);
}

async function handleMessage(entry, accessToken) {
  const messaging = entry.messaging?.[0];
  if (!messaging) return;

  const senderId = messaging.sender?.id;
  const messageText = messaging.message?.text || '';
  const igUserId = entry.id;

  if (!senderId || !accessToken) return;
  if (senderId === igUserId) return; // 자기 메시지 스킵

  console.log('[lumi] DM 수신:', messageText, '발신자:', senderId);

  let replyText = '안녕하세요! 메시지 감사해요 😊 빠르게 확인 후 답변드릴게요!';
  if (messageText.includes('가격') || messageText.includes('얼마')) {
    replyText = '안녕하세요! 가격 문의 주셨군요. 잠시 후 자세히 안내드릴게요 🙏';
  } else if (messageText.includes('예약') || messageText.includes('주문')) {
    replyText = '예약/주문 문의 감사해요! 확인 후 빠르게 답변드릴게요 ✨';
  } else if (messageText.includes('영업') || messageText.includes('시간')) {
    replyText = '영업시간 문의 감사해요! 확인 후 안내드릴게요 📋';
  }

  await callGraphAPI(`/${igUserId}/messages`, 'POST', {
    recipient: { id: senderId },
    message: { text: replyText }
  }, accessToken);

  console.log('[lumi] DM 자동 답변 완료:', senderId);
}

exports.handler = async (event) => {
  // GET: Webhook 인증
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

  // POST: Webhook 이벤트 수신
  if (event.httpMethod === 'POST') {
    const signature = event.headers['x-hub-signature-256'] || '';
    if (signature && !verifySignature(event.body, signature)) {
      console.error('[lumi] 서명 검증 실패');
      return { statusCode: 401, body: 'Unauthorized' };
    }

    let body;
    try {
      body = JSON.parse(event.body);
    } catch(e) {
      return { statusCode: 400, body: 'Bad Request' };
    }

    console.log('[lumi] Webhook 수신:', JSON.stringify(body));

    if (body.object !== 'instagram') {
      return { statusCode: 200, body: 'OK' };
    }

    for (const entry of (body.entry || [])) {
      const igUserId = entry.id;
      const accessToken = await getUserToken(igUserId);

      if (!accessToken) {
        console.log('[lumi] 토큰 없음:', igUserId);
        continue;
      }

      if (entry.changes) await handleComment(entry, accessToken);
      if (entry.messaging) await handleMessage(entry, accessToken);
    }

    return { statusCode: 200, body: 'OK' };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
