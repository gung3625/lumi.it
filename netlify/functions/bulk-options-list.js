// 옵션 목록 조회 — Sprint 5 (대량 편집 테이블용)
// GET /api/bulk-options-list?product_id=&market=&zero_stock=1&min_price=&max_price=
//
// 응답: { options: [...], total: N }

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const MAX_ROWS = 5000;

exports.handler = async (event) => {
  const origin = getOrigin(event);
  const CORS = corsHeaders(origin, { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error: authErr } = verifySellerToken(token);
  if (authErr || !payload) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요해요.' }) };
  }

  let admin;
  try { admin = getAdminClient(); } catch {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
  }

  const params = event.queryStringParameters || {};
  const sellerId = payload.seller_id;

  // ── 상품 조회 ──────────────────────────────────────────────────────────
  let productQuery = admin
    .from('products')
    .select('id, title, price_suggested, status')
    .eq('seller_id', sellerId)
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS);

  if (params.product_id) productQuery = productQuery.eq('id', params.product_id);
  if (params.min_price)  productQuery = productQuery.gte('price_suggested', Number(params.min_price));
  if (params.max_price)  productQuery = productQuery.lte('price_suggested', Number(params.max_price));

  const { data: products, error: pErr } = await productQuery;
  if (pErr) {
    console.error('[bulk-options-list] products error:', pErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '상품 조회 실패' }) };
  }

  if (!products || products.length === 0) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ options: [], total: 0 }) };
  }

  const productIds = products.map((p) => p.id);
  const productMap = Object.fromEntries(products.map((p) => [p.id, p]));

  // ── 마켓 필터 ──────────────────────────────────────────────────────────
  let marketFilterSet = null;
  if (params.market) {
    const { data: regs } = await admin
      .from('product_market_registrations')
      .select('product_id')
      .eq('seller_id', sellerId)
      .eq('market', params.market)
      .in('product_id', productIds);
    marketFilterSet = new Set((regs || []).map((r) => r.product_id));
  }

  // ── 옵션 조회 ──────────────────────────────────────────────────────────
  let optQuery = admin
    .from('product_options')
    .select('id, product_id, option_name, option_values, sku, price, stock, extra_price, market_mapping, display_order')
    .in('product_id', productIds)
    .order('display_order', { ascending: true })
    .limit(MAX_ROWS);

  if (params.zero_stock === '1') optQuery = optQuery.eq('stock', 0);

  const { data: options, error: oErr } = await optQuery;
  if (oErr) {
    console.error('[bulk-options-list] options error:', oErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '옵션 조회 실패' }) };
  }

  let filtered = (options || []);
  if (marketFilterSet) filtered = filtered.filter((o) => marketFilterSet.has(o.product_id));

  // 응답 형태 가공
  const result = filtered.map((opt) => {
    const prod = productMap[opt.product_id] || {};
    return {
      id:             opt.id,
      product_id:     opt.product_id,
      product_title:  prod.title || '',
      product_price:  prod.price_suggested || 0,
      option_name:    opt.option_name || '',
      option_values:  opt.option_values,
      sku:            opt.sku || '',
      price:          opt.price,           // null 가능 (상품가 상속)
      stock:          opt.stock ?? 0,
      extra_price:    opt.extra_price ?? 0,
      market_mapping: opt.market_mapping || {},
    };
  });

  console.log(`[bulk-options-list] seller=${sellerId.slice(0,8)} count=${result.length}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ options: result, total: result.length }),
  };
};
