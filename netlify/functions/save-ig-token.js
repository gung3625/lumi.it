const { getStore } = require('@netlify/blobs');

const SITE_ID = process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc';
const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // LUMI_SECRET 인증
  const secret = event.headers['x-lumi-secret'];
  if (secret !== process.env.LUMI_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: '인증 실패' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bad Request' }) };
  }

  const { igUserId, accessToken, email } = body;

  if (!igUserId || !accessToken) {
    return { statusCode: 400, body: JSON.stringify({ error: 'igUserId, accessToken 필수' }) };
  }

  try {
    const store = getStore({
      name: 'users',
      siteID: SITE_ID,
      token: NETLIFY_TOKEN
    });

    await store.set('ig:' + igUserId, JSON.stringify({
      igUserId,
      accessToken,
      email: email || '',
      savedAt: new Date().toISOString()
    }));

    // user:이메일 객체에도 igConnected 저장
    if (email) {
      let userRaw;
      try { userRaw = await store.get('user:' + email); } catch { userRaw = null; }
      if (userRaw) {
        const user = JSON.parse(userRaw);
        user.igConnected = true;
        user.igUserId = igUserId;
        await store.set('user:' + email, JSON.stringify(user));
      }
    }

    console.log('[lumi] Instagram 토큰 저장 완료:', igUserId);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, igUserId })
    };
  } catch(e) {
    console.error('[lumi] 토큰 저장 오류:', e.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: '저장 실패', message: e.message })
    };
  }
};
