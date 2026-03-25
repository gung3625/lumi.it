const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return salt + ':' + hash;
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
  if (!email || !password) return { statusCode: 400, body: JSON.stringify({ error: '필수 정보가 없습니다.' }) };
  const pwRegex = /^(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{10,}$/;
  if (!pwRegex.test(password)) return { statusCode: 400, body: JSON.stringify({ error: '비밀번호는 특수문자를 포함한 10자 이상이어야 합니다.' }) };

  try {
    const store = getStore({ name: 'users', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });
    let raw;
    try { raw = await store.get('user:' + email); } catch(e) { raw = null; }
    if (!raw) return { statusCode: 404, body: JSON.stringify({ error: '가입되지 않은 이메일입니다.' }) };

    const user = JSON.parse(raw);
    user.passwordHash = hashPassword(password);
    user.passwordUpdatedAt = new Date().toISOString();
    await store.set('user:' + email, JSON.stringify(user));

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, message: '비밀번호가 변경됐어요.' }) };
  } catch (err) {
    console.error('reset-password error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: '비밀번호 변경 중 오류가 발생했습니다.' }) };
  }
};
