const { getStore } = require('@netlify/blobs');

// 오늘 날짜를 YYYY-MM-DD 형식으로 반환
function getDateStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

// 180일 이전 날짜별 키를 삭제 (best-effort)
async function cleanupOldKeys(store, prefix) {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 180);
    const result = await store.list({ prefix });
    const blobs = (result && result.blobs) ? result.blobs : [];
    for (const blob of blobs) {
      // 키 끝부분에서 날짜(YYYY-MM-DD) 추출
      const match = blob.key.match(/:(\d{4}-\d{2}-\d{2})$/);
      if (!match) continue;
      const keyDate = new Date(match[1]);
      if (keyDate < cutoff) {
        try {
          await store.delete(blob.key);
          console.log('[cleanup] 삭제:', blob.key);
        } catch(e) {
          console.warn('[cleanup] 삭제 실패:', blob.key);
        }
      }
    }
  } catch(e) {
    console.warn('[cleanup] list 실패, prefix:', prefix);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Make에서 호출 시 간단한 인증 (환경변수로 시크릿 키 확인)
  const authHeader = event.headers['x-lumi-secret'];
  if (!process.env.LUMI_SECRET || authHeader !== process.env.LUMI_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: '인증 실패' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  // body.trends = { cafe: [...], food: [...], beauty: [...], other: [...] }
  const { trends } = body;
  if (!trends || typeof trends !== 'object') {
    return { statusCode: 400, body: JSON.stringify({ error: 'trends 데이터가 없습니다.' }) };
  }

  try {
    const store = getStore({ name: 'trends', consistency: 'strong', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });
    const updatedAt = new Date().toISOString();
    const dateStr = getDateStr();
    const updated = [];

    for (const [category, tags] of Object.entries(trends)) {
      if (!Array.isArray(tags) || tags.length === 0) continue;
      const payload = JSON.stringify({ tags, updatedAt, source: 'last30days' });
      await store.set('trends:' + category, payload);
      await store.set('trends:' + category + ':' + dateStr, payload);
      updated.push(category);
    }
    // trends 날짜별 키 cleanup (best-effort)
    for (const category of updated) {
      cleanupOldKeys(store, 'trends:' + category + ':').catch(() => {});
    }

    // last30days 상세 데이터 저장 (keywords with scores, sources, findingsCount)
    if (body.last30days && typeof body.last30days === 'object') {
      for (const [category, data] of Object.entries(body.last30days)) {
        const payload = JSON.stringify(data);
        await store.set('l30d:' + category, payload);
        await store.set('l30d:' + category + ':' + dateStr, payload);
      }
      // l30d 날짜별 키 cleanup (best-effort)
      for (const category of Object.keys(body.last30days)) {
        cleanupOldKeys(store, 'l30d:' + category + ':').catch(() => {});
      }
    }

    // GPT 분류 결과: 국내 트렌드 (현재→prev 백업 후 저장)
    if (body.domestic && typeof body.domestic === 'object') {
      for (const [category, data] of Object.entries(body.domestic)) {
        try {
          const cur = await store.get('l30d-domestic:' + category);
          if (cur) await store.set('l30d-domestic-prev:' + category, cur);
        } catch(e) {}
        const payload = JSON.stringify(data);
        await store.set('l30d-domestic:' + category, payload);
        await store.set('l30d-domestic:' + category + ':' + dateStr, payload);
      }
      // l30d-domestic 날짜별 키 cleanup (best-effort)
      for (const category of Object.keys(body.domestic)) {
        cleanupOldKeys(store, 'l30d-domestic:' + category + ':').catch(() => {});
      }
    }

    // GPT 분류 결과: 해외 트렌드 (현재→prev 백업 후 저장)
    if (body.global && typeof body.global === 'object') {
      for (const [category, data] of Object.entries(body.global)) {
        try {
          const cur = await store.get('l30d-global:' + category);
          if (cur) await store.set('l30d-global-prev:' + category, cur);
        } catch(e) {}
        const payload = JSON.stringify(data);
        await store.set('l30d-global:' + category, payload);
        await store.set('l30d-global:' + category + ':' + dateStr, payload);
      }
      // l30d-global 날짜별 키 cleanup (best-effort)
      for (const category of Object.keys(body.global)) {
        cleanupOldKeys(store, 'l30d-global:' + category + ':').catch(() => {});
      }
    }

    // 캡션뱅크 (업종별 참고 캡션) — 날짜별 보관 불필요
    if (body.captionBank && typeof body.captionBank === 'object') {
      for (const [category, captions] of Object.entries(body.captionBank)) {
        await store.set('caption-bank:' + category, JSON.stringify(captions));
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        updated,
        updatedAt
      })
    };
  } catch (err) {
    console.error('update-trends error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: '트렌드 업데이트 중 오류가 발생했습니다.' })
    };
  }
};
