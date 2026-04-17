const { getStore } = require('@netlify/blobs');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

// 링크 페이지 저장 (인증 필요)
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const authHeader = event.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증 필요' }) };

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청' }) };
  }

  try {
    const store = getStore({
      name: 'users', consistency: 'strong'
    });

    // 토큰으로 이메일 조회
    let tokenRaw;
    try { tokenRaw = await store.get('token:' + token); if (tokenRaw) { const td = JSON.parse(tokenRaw); if (td.expiresAt && new Date(td.expiresAt) < new Date()) { tokenRaw = null; } } } catch { tokenRaw = null; }
    if (!tokenRaw) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '유효하지 않은 토큰' }) };
    const { email } = JSON.parse(tokenRaw);

    // 유저 정보 조회
    const userRaw = await store.get('user:' + email);
    if (!userRaw) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '사용자 없음' }) };
    const user = JSON.parse(userRaw);

    // 링크 최대 10개 제한
    const links = (body.links || []).slice(0, 10).map(link => ({
      icon: link.icon || '🔗',
      label: link.label || '',
      url: link.url || ''
    })).filter(l => l.label && l.url);

    const linkPage = {
      links,
      theme: body.theme || 'pink',
      updatedAt: new Date().toISOString()
    };

    await store.set('linkpage:' + email, JSON.stringify(linkPage));

    // insta: 키로 이메일 역조회 가능하도록 저장
    const instaId = (user.instagram || '').replace('@', '').toLowerCase();
    if (instaId) {
      await store.set('insta:' + instaId, email);
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, url: `https://lumi.it.kr/p/${instaId}` })
    };
  } catch(err) {
    console.error('update-link-page error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '저장 실패' }) };
  }
};
