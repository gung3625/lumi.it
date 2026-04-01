const { getStore } = require('@netlify/blobs');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const { name, phone, birthdate } = body;

  if (!name || !phone || !birthdate) {
    return { statusCode: 400, body: JSON.stringify({ error: '이름, 전화번호, 생년월일을 모두 입력해주세요.' }) };
  }

  try {
    const store = getStore({
      name: 'users', consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN
    });

    const { blobs } = await store.list({ prefix: 'user:' });

    for (const blob of blobs) {
      let user;
      try {
        const raw = await store.get(blob.key);
        user = JSON.parse(raw);
      } catch {
        continue;
      }

      if (
        user.name === name &&
        user.phone === phone &&
        user.birthdate === birthdate
      ) {
        // 이메일 일부 마스킹 처리 (예: ab***@gmail.com)
        const [localPart, domain] = user.email.split('@');
        const maskedLocal = localPart.slice(0, 2) + '***';
        const maskedEmail = maskedLocal + '@' + domain;

        return {
          statusCode: 200,
          headers: CORS,
          body: JSON.stringify({ success: true, email: maskedEmail })
        };
      }
    }

    return {
      statusCode: 404,
      body: JSON.stringify({ error: '일치하는 회원 정보를 찾을 수 없습니다.' })
    };

  } catch (err) {
    console.error('find-id error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '처리 중 오류가 발생했습니다.' }) };
  }
};
