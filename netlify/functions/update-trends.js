const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Make에서 호출 시 간단한 인증 (환경변수로 시크릿 키 확인)
  const authHeader = event.headers['x-lumi-secret'];
  if (process.env.LUMI_SECRET && authHeader !== process.env.LUMI_SECRET) {
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
    const updated = [];

    for (const [category, tags] of Object.entries(trends)) {
      if (!Array.isArray(tags) || tags.length === 0) continue;
      await store.set('trends:' + category, JSON.stringify({ tags, updatedAt, source: 'last30days' }));
      updated.push(category);
    }

    // last30days 상세 데이터 저장 (keywords with scores, sources, findingsCount)
    if (body.last30days && typeof body.last30days === 'object') {
      for (const [category, data] of Object.entries(body.last30days)) {
        await store.set('l30d:' + category, JSON.stringify(data));
      }
    }

    // GPT 분류 결과: 국내 트렌드 (현재→prev 백업 후 저장)
    if (body.domestic && typeof body.domestic === 'object') {
      for (const [category, data] of Object.entries(body.domestic)) {
        try {
          const cur = await store.get('l30d-domestic:' + category);
          if (cur) await store.set('l30d-domestic-prev:' + category, cur);
        } catch(e) {}
        await store.set('l30d-domestic:' + category, JSON.stringify(data));
      }
    }

    // GPT 분류 결과: 해외 트렌드 (현재→prev 백업 후 저장)
    if (body.global && typeof body.global === 'object') {
      for (const [category, data] of Object.entries(body.global)) {
        try {
          const cur = await store.get('l30d-global:' + category);
          if (cur) await store.set('l30d-global-prev:' + category, cur);
        } catch(e) {}
        await store.set('l30d-global:' + category, JSON.stringify(data));
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
    console.error('update-trends error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: '트렌드 업데이트 중 오류가 발생했습니다.' })
    };
  }
};
