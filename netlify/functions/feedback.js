const { getStore } = require('@netlify/blobs');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    // 토큰 인증
    const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: '로그인이 필요합니다.' }) };
    }

    const usersStore = getStore({
      name: 'users',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN,
    });

    const tokenData = await usersStore.get('token:' + token);
    if (!tokenData) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: '유효하지 않은 인증입니다.' }) };
    }

    const tokenParsed = JSON.parse(tokenData);
    const email = tokenParsed.email;

    // 입력 파싱
    const { category, message, rating } = JSON.parse(event.body || '{}');

    if (!message || !message.trim()) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '내용을 입력해주세요.' }) };
    }

    // 피드백 저장
    const feedbackStore = getStore({
      name: 'feedback',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN,
    });

    const feedbackId = 'fb_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    const feedbackData = {
      id: feedbackId,
      email,
      category: category || '기타',
      message: message.trim(),
      rating: rating || null,
      createdAt: new Date().toISOString(),
    };

    await feedbackStore.set(feedbackId, JSON.stringify(feedbackData));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, message: '소중한 의견 감사합니다!' }),
    };
  } catch (err) {
    console.error('feedback error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '피드백 전송 중 오류가 발생했어요.' }) };
  }
};
