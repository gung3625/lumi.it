const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const { name, storeName, instagram, email, phone, storeDesc, region, bizCategory, captionTone, tagStyle } = body;

  // 필수값 검증
  if (!name || !storeName || !instagram || !email || !phone) {
    return { statusCode: 400, body: JSON.stringify({ error: '필수 정보가 누락됐습니다.' }) };
  }

  try {
    const store = getStore('users');

    // 이미 가입된 이메일인지 확인
    let existing;
    try {
      existing = await store.get('user:' + email);
    } catch(e) {
      existing = null;
    }

    if (existing) {
      return { statusCode: 409, body: JSON.stringify({ error: '이미 가입된 이메일입니다.' }) };
    }

    // 회원 정보 저장
    const user = {
      name,
      storeName,
      instagram: instagram.replace('@', ''),
      email,
      phone,
      storeDesc: storeDesc || '',
      region: region || '',
      bizCategory: bizCategory || 'cafe',
      captionTone: captionTone || 'warm',
      tagStyle: tagStyle || 'mid',
      plan: 'trial',        // 무료체험
      trialStart: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };

    await store.set('user:' + email, JSON.stringify(user));

    // 간단한 세션 토큰 발급 (email + timestamp base64)
    const token = Buffer.from(email + ':' + Date.now()).toString('base64');
    await store.set('token:' + token, JSON.stringify({ email, createdAt: new Date().toISOString() }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, token, user })
    };
  } catch (err) {
    console.error('register error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: '가입 처리 중 오류가 발생했습니다.' }) };
  }
};
