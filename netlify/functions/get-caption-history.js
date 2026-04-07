const { getStore } = require('@netlify/blobs');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const authHeader = event.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증 필요' }) };

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청' }) };
  }

  try {
    const store = getStore({
      name: 'users', consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN
    });

    // 토큰으로 이메일 확인
    let tokenRaw;
    try { tokenRaw = await store.get('token:' + token); } catch { tokenRaw = null; }
    if (!tokenRaw) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '유효하지 않은 토큰' }) };

    const { email } = JSON.parse(tokenRaw);

    let history = [];
    try {
      const raw = await store.get('caption-history:' + email);
      if (raw) history = JSON.parse(raw);
    } catch { history = []; }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, history })
    };
  } catch (err) {
    console.error('get-caption-history error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '오류 발생' }) };
  }
};
