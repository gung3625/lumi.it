const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const verify = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return verify === hash;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const { email, password } = body;
  if (!email || !password) {
    return { statusCode: 400, body: JSON.stringify({ error: '이메일과 비밀번호를 입력하세요.' }) };
  }

  try {
    const store = getStore({
      name: 'users', consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN
    });

    let raw;
    try { raw = await store.get('user:' + email); } catch(e) { raw = null; }
    if (!raw) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '가입되지 않은 이메일입니다.' }) };
    }

    const user = JSON.parse(raw);

    // 비밀번호 해시 없으면 반드시 로그인 차단
    if (!user.passwordHash) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '비밀번호를 다시 설정해주세요.' }) };
    }

    // 비밀번호 검증
    if (!verifyPassword(password, user.passwordHash)) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '비밀번호가 올바르지 않습니다.' }) };
    }

    const token = Buffer.from(email + ':' + Date.now()).toString('base64');
    await store.set('token:' + token, JSON.stringify({ email, createdAt: new Date().toISOString() }));

    const { passwordHash, ...safeUser } = user;

    // ig 연동 여부 — user 객체에 저장된 값 그대로 사용
    // (save-ig-token에서 user:이메일에 igConnected: true 저장함)
    if (!safeUser.igUserId) {
      safeUser.igConnected = false;
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, token, user: safeUser })
    };
  } catch (err) {
    console.error('login error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '로그인 처리 중 오류가 발생했습니다.' }) };
  }
};
