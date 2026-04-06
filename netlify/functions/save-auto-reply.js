const { getStore } = require('@netlify/blobs');

const SITE_ID = process.env.NETLIFY_SITE_ID;
const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN;

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const store = getStore({
    name: 'auto-replies', consistency: 'strong',
    siteID: SITE_ID,
    token: NETLIFY_TOKEN
  });

  // GET: 설정 불러오기
  if (event.httpMethod === 'GET') {
    try {
      // 토큰으로 이메일 확인
      const authHeader = event.headers['authorization'] || '';
      const token = authHeader.replace('Bearer ', '');
      if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 필요' }) };

      const tokenStore = getStore({ name: 'users', consistency: 'strong', siteID: SITE_ID, token: NETLIFY_TOKEN });
      const tokenData = await tokenStore.get('token:' + token);
      if (!tokenData) return { statusCode: 401, headers, body: JSON.stringify({ error: '유효하지 않은 토큰' }) };

      const { email } = JSON.parse(tokenData);
      const raw = await store.get('reply:' + email);
      const data = raw ? JSON.parse(raw) : { comment: { keywords: [], defaultReply: '' }, dm: { keywords: [], defaultReply: '' } };

      return { statusCode: 200, headers, body: JSON.stringify(data) };
    } catch(e) {
      console.error('save-auto-reply GET error:', e);
      return { statusCode: 500, headers, body: JSON.stringify({ error: '오류가 발생했습니다.' }) };
    }
  }

  // POST: 설정 저장
  if (event.httpMethod === 'POST') {
    try {
      const authHeader = event.headers['authorization'] || '';
      const token = authHeader.replace('Bearer ', '');
      if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 필요' }) };

      const tokenStore = getStore({ name: 'users', consistency: 'strong', siteID: SITE_ID, token: NETLIFY_TOKEN });
      const tokenData = await tokenStore.get('token:' + token);
      if (!tokenData) return { statusCode: 401, headers, body: JSON.stringify({ error: '유효하지 않은 토큰' }) };

      const { email } = JSON.parse(tokenData);
      const body = JSON.parse(event.body);

      await store.set('reply:' + email, JSON.stringify(body));

      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    } catch(e) {
      console.error('save-auto-reply POST error:', e);
      return { statusCode: 500, headers, body: JSON.stringify({ error: '저장 중 오류가 발생했습니다.' }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
};
