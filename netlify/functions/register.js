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

  const { name, storeName, instagram, email, phone, password, birthdate, storeDesc, region, bizCategory, captionTone, tagStyle } = body;

  if (!name || !storeName || !instagram || !email || !phone || !password || !birthdate) {
    return { statusCode: 400, body: JSON.stringify({ error: '필수 정보가 누락됐습니다.' }) };
  }

  // 생년월일 형식 검사 (YYYY-MM-DD)
  const bdRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!bdRegex.test(birthdate)) {
    return { statusCode: 400, body: JSON.stringify({ error: '생년월일 형식이 올바르지 않습니다. (YYYY-MM-DD)' }) };
  }

  const pwRegex = /^(?=.*[!@#$%^&*()_+\-=\[\]{};':"\|,.<>\/?]).{10,}$/;
  if (!pwRegex.test(password)) {
    return { statusCode: 400, body: JSON.stringify({ error: '비밀번호는 특수문자를 포함한 10자리 이상이어야 합니다.' }) };
  }

  try {
    const store = getStore({
      name: 'users',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN
    });

    let existing;
    try { existing = await store.get('user:' + email); } catch(e) { existing = null; }
    if (existing) {
      return { statusCode: 409, body: JSON.stringify({ error: '이미 가입된 이메일입니다.' }) };
    }

    const user = {
      name,
      storeName,
      instagram: instagram.replace('@', ''),
      email,
      phone,
      birthdate,
      passwordHash: hashPassword(password),
      storeDesc: storeDesc || '',
      region: region || '',
      bizCategory: bizCategory || 'cafe',
      captionTone: captionTone || 'warm',
      tagStyle: tagStyle || 'mid',
      plan: 'trial',
      trialStart: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      autoRenew: true
    };

    await store.set('user:' + email, JSON.stringify(user));

    const token = Buffer.from(email + ':' + Date.now()).toString('base64');
    await store.set('token:' + token, JSON.stringify({ email, createdAt: new Date().toISOString() }));

    const { passwordHash, ...safeUser } = user;
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, token, user: safeUser })
    };
  } catch (err) {
    console.error('register error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: '가입 처리 중 오류가 발생했습니다.' }) };
  }
};
