const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

// 메타 서명 검증
function verifySignature(payload, signature) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(payload)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// 메타 Graph API 호출
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
  return res.json();
}

// 고객 토큰 가져오기 (Blobs에서)
async function getUserToken(igUserId) {
  try {
    const store = getStore({
      name: 'users',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN
    });
    const raw = await store.get('ig:' + igUserId);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data.accessToken || null;
  } catch(e) {
    console.error('토큰 조회 오류:', e.message);
    return null;
  }
}

// 댓글 자동 답변
async function handleComment(entry, accessToken) {
  const change = entry.changes?.[0];
  if (!change || change.field !== 'comments') return;

  const commentId = change.value?.id;
  const commentText = change.value?.text || '';
  const mediaId = change.value?.media?.id;

  if (!commentId || !accessToken) return;

  // 댓글 내용에 따라 자동 답변 생성
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

// DM 자동 답변
async function handleMessage(entry, accessToken) {
  const messaging = entry.messaging?.[0];
  if (!messaging) return;

  const senderId = messaging.sender?.id;
  const messageText = messaging.message?.text || '';
  const igUserId = entry.id;

  if (!senderId || !accessToken || senderId === igUserId) return;

  // DM 내용에 따라 자동 답변 생성
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
  // GET: Webhook 인증 (메타 검증 요청)
  if (event.httpMethod === 'GET') {
    const params = new URLSearchParams(event.rawQuery || '');
    const mode = params.get('hub.mode');
    const token = params.get('hub.verify_token');
    const challenge = params.get('hub.challenge');

    const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;

    if (mode === 'subscribe' && token === verifyToken) {
      console.log('[lumi] Webhook 인증 성공');
      return { statusCode: 200, body: challenge };
    }
    return { statusCode: 403, body: 'Forbidden' };
  }

  // POST: Webhook 이벤트 수신
  if (event.httpMethod === 'POST') {
    // 서명 검증
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

    if (body.object !== 'instagram') {
      return { statusCode: 200, body: 'OK' };
    }

    // 각 entry 처리
    for (const entry of (body.entry || [])) {
      const igUserId = entry.id;

      // 고객 토큰 조회
      const accessToken = await getUserToken(igUserId);
      if (!accessToken) {
        console.log('[lumi] 토큰 없음:', igUserId);
        continue;
      }

      // 댓글 처리
      if (entry.changes) {
        await handleComment(entry, accessToken);
      }

      // DM 처리
      if (entry.messaging) {
        await handleMessage(entry, accessToken);
      }
    }

    return { statusCode: 200, body: 'OK' };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
