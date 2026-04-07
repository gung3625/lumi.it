const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const authHeader = event.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  try {
    const store = getStore({
      name: 'users', consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN
    });

    // 토큰으로 이메일 조회
    let tokenRaw;
    try { tokenRaw = await store.get('token:' + token); } catch { tokenRaw = null; }
    if (!tokenRaw) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '유효하지 않은 토큰입니다.' }) };
    }
    const { email } = JSON.parse(tokenRaw);

    // 기존 user 불러오기
    let userRaw;
    try { userRaw = await store.get('user:' + email); } catch { userRaw = null; }
    if (!userRaw) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '사용자를 찾을 수 없습니다.' }) };
    }
    const user = JSON.parse(userRaw);

    // 허용된 필드만 업데이트
    const allowed = ['name', 'storeName', 'instagram', 'phone', 'birthdate', 'storeDesc', 'sidoCode', 'sigunguCode', 'storeSido', 'region', 'bizCategory', 'captionTone', 'tagStyle', 'customCaptions', 'autoStory', 'autoFestival', 'relayMode', 'retentionUnsubscribed'];
    allowed.forEach(key => {
      if (body[key] !== undefined) user[key] = body[key];
    });

    await store.set('user:' + email, JSON.stringify(user));

    const { passwordHash, ...safeUser } = user;
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, user: safeUser })
    };
  } catch (err) {
    console.error('update-profile error:', err.message || err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '저장 중 오류가 발생했습니다.' }) };
  }
};
