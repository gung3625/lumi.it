const { getStore } = require('@netlify/blobs');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const authHeader = event.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  try {
    const store = getStore({
      name: 'users', consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN
    });

    // 토큰으로 이메일 조회
    let tokenRaw;
    try { tokenRaw = await store.get('token:' + token); if (tokenRaw) { const td = JSON.parse(tokenRaw); if (td.expiresAt && new Date(td.expiresAt) < new Date()) { tokenRaw = null; } } } catch { tokenRaw = null; }
    if (!tokenRaw) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '유효하지 않은 토큰입니다.' }) };
    }
    const { email } = JSON.parse(tokenRaw);

    // user:이메일 에서 igUserId 가져오기
    let igUserId = '';
    const userRaw = await store.get('user:' + email);
    if (userRaw) {
      const user = JSON.parse(userRaw);
      igUserId = user.igUserId || '';

      // user에서 ig 정보 제거
      user.igConnected = false;
      user.igUserId = '';
      await store.set('user:' + email, JSON.stringify(user));
    }

    // ig:igUserId 삭제
    if (igUserId) {
      try { await store.delete('ig:' + igUserId); } catch(e) {}
    }

    // email-ig:이메일 삭제
    try { await store.delete('email-ig:' + email); } catch(e) {}

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true })
    };
  } catch (err) {
    console.error('disconnect-ig error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '처리 중 오류가 발생했습니다.' }) };
  }
};
