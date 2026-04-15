const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const authHeader = event.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증 필요' }) };
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  try {
    const userStore = getStore({
      name: 'users',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN,
    });

    // 토큰 → 이메일 조회
    let tokenRaw;
    try { tokenRaw = await userStore.get('token:' + token); } catch { tokenRaw = null; }
    if (!tokenRaw) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '유효하지 않은 토큰' }) };
    const { email } = JSON.parse(tokenRaw);

    const store = getStore({
      name: 'reservations',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN,
    });

    // 모든 예약 조회
    const { blobs } = await store.list({ prefix: 'reserve:' });
    const pending = [];

    for (const blob of blobs) {
      try {
        const raw = await store.get(blob.key);
        if (!raw) continue;
        const item = JSON.parse(raw);

        // 해당 유저의 것만 필터
        const ownerEmail = item.storeProfile?.ownerEmail || '';
        if (ownerEmail !== email) continue;

        // 이미 게시됐거나 취소된 건 제외
        if (item.isSent || item.cancelled) continue;

        // 캡션이 생성된 것만 (대기 중인 릴레이 항목)
        if (!item.generatedCaptions || item.generatedCaptions.length === 0) continue;

        pending.push({
          key: blob.key,
          captions: item.generatedCaptions,
          captionsGeneratedAt: item.captionsGeneratedAt,
          autoPostAt: item.autoPostAt || null,
          relayMode: item.relayMode || false,
          captionStatus: item.captionStatus || null,
          photoCount: (item.photos || []).length,
          imageKeys: (item.imageKeys || item.tempKeys || []).slice(0, 4),
          bizCategory: item.bizCategory,
          userMessage: item.userMessage || '',
        });
      } catch {}
    }

    // 최신순 정렬
    pending.sort((a, b) => (b.captionsGeneratedAt || '').localeCompare(a.captionsGeneratedAt || ''));

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ items: pending }),
    };
  } catch (err) {
    console.error('relay-list error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '오류가 발생했습니다.' }) };
  }
};
