const { getStore } = require('@netlify/blobs');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

// 인스타 아이디로 링크 페이지 데이터 공개 조회
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const rawId = event.queryStringParameters?.id;
  if (!rawId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id 파라미터 필요' }) };
  }

  // Instagram URL에서 '.' → '__' 인코딩 역변환 (예: lumi__it → lumi.it)
  const instaId = rawId.replace(/__/g, '.');

  try {
    const store = getStore({
      name: 'users', consistency: 'strong'
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

    // fallback 제거 — 전체 스캔은 DoS 위험. insta: 역인덱스가 없으면 404.
    // (역인덱스는 register.js, update-profile.js에서 자동 생성됨)

    if (!email) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '페이지를 찾을 수 없습니다.' }) };
    }

    // 유저 정보 조회
    let user = null;
    try {
      const userRaw = await store.get('user:' + email);
      if (userRaw) user = JSON.parse(userRaw);
    } catch(e) {}

    if (!user) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '페이지를 찾을 수 없습니다.' }) };
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
        ...CORS,
        'Cache-Control': 'public, max-age=60'
      },
      body: JSON.stringify(responseData)
    };
  } catch(err) {
    console.error('get-link-page error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '오류가 발생했습니다.' }) };
  }
};
