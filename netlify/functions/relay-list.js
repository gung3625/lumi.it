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
    const tokenData = JSON.parse(tokenRaw);
    if (tokenData.expiresAt && new Date(tokenData.expiresAt) < new Date()) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '세션이 만료됐습니다. 다시 로그인해주세요.' }) };
    }
    const { email } = tokenData;

    const store = getStore({
      name: 'reservations',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN,
    });

    // 모든 예약 조회 (병렬 fetch — 시퀀셜 대비 대폭 단축)
    // 예약 key는 'reserve:{timestamp}' 이므로 내림차순 정렬 후 최근 50건만 fetch
    const { blobs: allBlobs } = await store.list({ prefix: 'reserve:' });
    const sortedBlobs = (allBlobs || []).slice().sort((a, b) => (b.key || '').localeCompare(a.key || '')).slice(0, 50);
    const rawResults = await Promise.all(sortedBlobs.map(b =>
      store.get(b.key).then(v => ({ key: b.key, raw: v })).catch(() => ({ key: b.key, raw: null }))
    ));
    const pending = [];
    for (const { key, raw } of rawResults) {
      if (!raw) continue;
      let item;
      try { item = JSON.parse(raw); } catch { continue; }
      const ownerEmail = item.storeProfile?.ownerEmail || '';
      if (ownerEmail !== email) continue;
      if (item.isSent || item.cancelled) continue;
      if (item.postMode === 'immediate') continue;
      if (!item.generatedCaptions || item.generatedCaptions.length === 0) continue;
      pending.push({
        key,
        captions: item.generatedCaptions,
        captionsGeneratedAt: item.captionsGeneratedAt,
        scheduledAt: item.scheduledAt || null,
        autoPostAt: item.autoPostAt || null,
        relayMode: item.relayMode || false,
        captionStatus: item.captionStatus || null,
        photoCount: (item.photos || []).length,
        imageKeys: (item.imageKeys || item.tempKeys || []).slice(0, 4),
        bizCategory: item.bizCategory,
        userMessage: item.userMessage || '',
        submittedAt: item.submittedAt || null,
      });
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
