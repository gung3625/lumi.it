const { getStore } = require('@netlify/blobs');

// 인스타 아이디로 링크 페이지 데이터 공개 조회
exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const rawId = event.queryStringParameters?.id;
  if (!rawId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'id 파라미터 필요' }) };
  }

  // Instagram URL에서 '.' → '__' 인코딩 역변환 (예: lumi__it → lumi.it)
  const instaId = rawId.replace(/__/g, '.');

  try {
    const store = getStore({
      name: 'users',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN
    });

    // 인스타 ID로 이메일 조회 (원본 + 역변환 둘 다 시도)
    let email = null;
    const candidates = [...new Set([instaId, rawId].map(s => s.replace('@', '').toLowerCase()))];
    for (const candidate of candidates) {
      try {
        const emailRaw = await store.get('insta:' + candidate);
        if (emailRaw) { email = emailRaw.trim(); break; }
      } catch(e) {}
    }

    // fallback: user 전체에서 instagram 필드 매칭
    if (!email) {
      try {
        const list = await store.list();
        for (const entry of list.blobs) {
          if (!entry.key.startsWith('user:')) continue;
          const raw = await store.get(entry.key);
          if (!raw) continue;
          const u = JSON.parse(raw);
          const uInsta = (u.instagram || '').replace('@', '').toLowerCase();
          const normalizedId = instaId.replace('@', '').toLowerCase();
          const normalizedRaw = rawId.replace('@', '').toLowerCase();
          if (uInsta === normalizedId || uInsta === normalizedRaw) {
            email = u.email;
            // 누락된 insta: 키 자동 복구
            await store.set('insta:' + uInsta, email);
            break;
          }
        }
      } catch(e) {}
    }

    if (!email) {
      return { statusCode: 404, body: JSON.stringify({ error: '페이지를 찾을 수 없습니다.' }) };
    }

    // 유저 정보 조회
    let user = null;
    try {
      const userRaw = await store.get('user:' + email);
      if (userRaw) user = JSON.parse(userRaw);
    } catch(e) {}

    if (!user) {
      return { statusCode: 404, body: JSON.stringify({ error: '페이지를 찾을 수 없습니다.' }) };
    }

    // 링크 페이지 설정 조회
    let linkPage = null;
    try {
      const linkRaw = await store.get('linkpage:' + email);
      if (linkRaw) linkPage = JSON.parse(linkRaw);
    } catch(e) {}

    const responseData = {
      storeName: user.storeName || '',
      storeDesc: user.storeDesc || '',
      instagram: user.instagram || instaId,
      region: user.region || '',
      bizCategory: user.bizCategory || '',
      links: linkPage?.links || [],
      theme: linkPage?.theme || 'pink',
      updatedAt: linkPage?.updatedAt || null
    };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60'
      },
      body: JSON.stringify(responseData)
    };
  } catch(err) {
    console.error('get-link-page error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: '오류가 발생했습니다.' }) };
  }
};
