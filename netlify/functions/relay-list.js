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

    // 토큰 → 이메일 조회 — 3회 재시도 (동시 호출 시 Blobs 401 throw → 프론트 자동 로그아웃 방지)
    let tokenRaw = null;
    let tokenBlobError = false;
    for (let i = 0; i < 3; i++) {
      tokenBlobError = false;
      try { tokenRaw = await userStore.get('token:' + token); }
      catch(e) { tokenBlobError = true; console.error('[relay-list] token blob fetch error:', e.message); }
      if (tokenRaw) break;
      if (!tokenBlobError) break;
      if (i < 2) await new Promise(r => setTimeout(r, 300));
    }
    if (!tokenRaw) {
      if (tokenBlobError) return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: '일시적 서버 오류입니다. 잠시 후 다시 시도해주세요.' }) };
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '유효하지 않은 토큰' }) };
    }
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

    // per-user 인덱스에서 reserveKey 목록 조회 (풀스캔 제거 — PAT rate limit 근본 해결)
    let userIndex = [];
    try {
      const indexRaw = await store.get('user-index:' + email);
      if (indexRaw) {
        const parsed = JSON.parse(indexRaw);
        if (Array.isArray(parsed)) userIndex = parsed;
      }
    } catch (idxErr) {
      console.warn('[relay-list] user-index 조회 실패:', idxErr.message);
    }

    // 내림차순 정렬 후 최근 50건만 병렬 fetch (key는 'reserve:{timestamp}')
    const sortedKeys = userIndex.slice().sort((a, b) => (b || '').localeCompare(a || '')).slice(0, 50);
    const rawResults = await Promise.all(sortedKeys.map(key =>
      store.get(key).then(v => ({ key, raw: v })).catch(() => ({ key, raw: null }))
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
