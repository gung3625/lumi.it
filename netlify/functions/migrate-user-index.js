// 관리자용 일회성 마이그레이션 — 기존 reservations 전체 스캔 후 ownerEmail별 user-index 생성
// LUMI_SECRET 인증 필수. 한 번만 실행.
const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-token',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // 인증: LUMI_SECRET
  const token = event.headers['x-admin-token'] || (event.headers['authorization'] || '').replace('Bearer ', '');
  if (!process.env.LUMI_SECRET || token !== process.env.LUMI_SECRET) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증 실패' }) };
  }

  try {
    const store = getStore({
      name: 'reservations',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN,
    });

    // 전체 예약 스캔
    const { blobs: allBlobs } = await store.list({ prefix: 'reserve:' });
    const keys = (allBlobs || []).map(b => b.key).filter(Boolean);

    // 이메일별 그룹핑
    const byEmail = {};
    const CHUNK = 20;
    for (let i = 0; i < keys.length; i += CHUNK) {
      const batch = keys.slice(i, i + CHUNK);
      const results = await Promise.all(batch.map(k =>
        store.get(k).then(v => ({ key: k, raw: v })).catch(() => ({ key: k, raw: null }))
      ));
      for (const { key, raw } of results) {
        if (!raw) continue;
        let item;
        try { item = JSON.parse(raw); } catch { continue; }
        const ownerEmail = item.storeProfile && item.storeProfile.ownerEmail;
        if (!ownerEmail) continue;
        if (!byEmail[ownerEmail]) byEmail[ownerEmail] = [];
        byEmail[ownerEmail].push(key);
      }
    }

    // 각 user-index 저장 (기존 인덱스와 병합해 중복 제거)
    const summary = {};
    for (const [ownerEmail, newKeys] of Object.entries(byEmail)) {
      const indexKey = 'user-index:' + ownerEmail;
      let existing = [];
      try {
        const existingRaw = await store.get(indexKey);
        if (existingRaw) {
          const parsed = JSON.parse(existingRaw);
          if (Array.isArray(parsed)) existing = parsed;
        }
      } catch {}
      const merged = Array.from(new Set([...existing, ...newKeys]));
      await store.set(indexKey, JSON.stringify(merged));
      summary[ownerEmail] = merged.length;
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        scannedReservations: keys.length,
        usersIndexed: Object.keys(byEmail).length,
        counts: summary,
      }),
    };
  } catch (err) {
    console.error('[migrate-user-index] 에러:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '마이그레이션 실패' }) };
  }
};
