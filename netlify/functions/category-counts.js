// category-counts.js — Linear/Canvas 도그마 위젯 데이터
// GET /api/category-counts
// 응답: { success, total, categories: [{ path, label, count, marketCounts }], marketTotals }
//
// 메모리 project_linear_canvas_ui_doctrine_0428.md 카테고리별 상품 카운트 위젯 사양

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const MARKETS = ['coupang', 'naver', 'toss'];

function pickCategoryPath(product) {
  // Sprint 2 schema: products.category_suggestions = { coupang:{tree:[]}, naver:{tree:[]} }
  // tree[0..N] = 대>중>소 카테고리. 여러 마켓 중 가장 긴 트리 우선
  const cs = product.category_suggestions || {};
  let best = [];
  for (const m of MARKETS) {
    const tree = (cs[m] && cs[m].tree) || [];
    if (Array.isArray(tree) && tree.length > best.length) best = tree;
  }
  if (best.length === 0) return { path: '미분류', label: '미분류' };
  // 최대 3단까지
  const path = best.slice(0, 3).join(' > ');
  const label = best[best.length - 1];
  return { path, label };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error: authErr } = verifySellerToken(token);
  if (authErr || !payload) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        total: 0,
        categories: [],
        marketTotals: { coupang: 0, naver: 0, toss: 0 },
        empty: true,
      }),
    };
  }

  try {
    // products: id, seller_id, category_suggestions, status
    const { data: products, error: pErr } = await admin
      .from('products')
      .select('id,category_suggestions,status,created_at')
      .eq('seller_id', payload.seller_id)
      .neq('status', 'deleted')
      .limit(2000);

    if (pErr) {
      console.error('[category-counts] query 오류:', pErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '카테고리 조회 실패' }) };
    }

    const items = products || [];
    const productIds = items.map((p) => p.id);

    // product_market_registrations에서 마켓별 등록 상태
    let regs = [];
    if (productIds.length > 0) {
      const { data: rData } = await admin
        .from('product_market_registrations')
        .select('product_id,marketplace,status')
        .in('product_id', productIds);
      regs = rData || [];
    }

    // product_id → markets[] 매핑 (등록 성공한 마켓만)
    const marketByProduct = {};
    for (const r of regs) {
      if (r.status === 'live' || r.status === 'success' || r.status === 'registered') {
        if (!marketByProduct[r.product_id]) marketByProduct[r.product_id] = new Set();
        marketByProduct[r.product_id].add(r.marketplace);
      }
    }

    // 카테고리별 집계
    const categoryMap = new Map(); // path → { path, label, count, marketCounts:{} }
    const marketTotals = { coupang: 0, naver: 0, toss: 0 };

    for (const p of items) {
      const { path, label } = pickCategoryPath(p);
      if (!categoryMap.has(path)) {
        categoryMap.set(path, { path, label, count: 0, marketCounts: { coupang: 0, naver: 0, toss: 0 }, productIds: [] });
      }
      const entry = categoryMap.get(path);
      entry.count += 1;
      entry.productIds.push(p.id);

      const markets = marketByProduct[p.id] || new Set();
      for (const m of markets) {
        if (entry.marketCounts[m] !== undefined) entry.marketCounts[m] += 1;
        if (marketTotals[m] !== undefined) marketTotals[m] += 1;
      }
    }

    // 정렬: 카운트 많은 순
    const categories = Array.from(categoryMap.values())
      .sort((a, b) => b.count - a.count)
      .map((c) => ({
        path: c.path,
        label: c.label,
        count: c.count,
        marketCounts: c.marketCounts,
        productIds: c.productIds.slice(0, 50), // Progressive Detail용 lazy fetch 방지, 최대 50개만
      }));

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        total: items.length,
        categories,
        marketTotals,
      }),
    };
  } catch (e) {
    console.error('[category-counts] 처리 오류:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
