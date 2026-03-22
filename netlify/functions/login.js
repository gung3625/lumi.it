const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const verify = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return verify === hash;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const { email, password } = body;
  if (!email || !password) return { statusCode: 400, body: JSON.stringify({ error: '이메일과 비밀번호를 입력하세요.' }) };

  try {
    const store = getStore({ name: 'users', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });
    let raw;
    try { raw = await store.get('user:' + email); } catch(e) { raw = null; }
    if (!raw) return { statusCode: 404, body: JSON.stringify({ error: '가입되지 않은 이메일입니다.' }) };

    const user = JSON.parse(raw);

    if (!user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      return { statusCode: 401, body: JSON.stringify({ error: '비밀번호가 올바르지 않습니다.' }) };
    }

    const token = Buffer.from(email + ':' + Date.now()).toString('base64');
    await store.set('token:' + token, JSON.stringify({ email, createdAt: new Date().toISOString() }));

    const { passwordHash, ...safeUser } = user;
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, token, user: safeUser }) };
  } catch (err) {
    console.error('login error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: '로그인 처리 중 오류가 발생했습니다.' }) };
  }
};
