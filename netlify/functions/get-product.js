// 상품 조회 — Sprint 2
// GET /api/get-product?id=<productId>
// 또는 GET /api/get-product?recent=1 → 최근 상품 1건
//
// 응답: products 테이블 + product_market_registrations 합쳐서 반환

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error: authErr } = verifySellerToken(token);
  if (authErr || !payload) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  const params = event.queryStringParameters || {};
  const productId = params.id;
  const recent = params.recent === '1';

  const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';

  let admin;
  try { admin = getAdminClient(); } catch (e) {
    if (isSignupMock) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ success: true, product: null, registrations: [], mock: true }),
      };
    }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류입니다.' }) };
  }

  let query = admin.from('products').select('*').eq('seller_id', payload.seller_id);
  if (productId) query = query.eq('id', productId);
  else if (recent) query = query.order('created_at', { ascending: false }).limit(1);
  else query = query.order('created_at', { ascending: false }).limit(20);

  const { data: products, error: pErr } = await query;
  if (pErr) {
    console.error('[get-product] query 오류:', pErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '상품 조회에 실패했어요.' }) };
  }
  if (!products || products.length === 0) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, product: null, registrations: [] }) };
  }

  const target = (productId || recent) ? products[0] : null;
  const productList = (productId || recent) ? null : products;

  // product_market_registrations 일괄 조회
  const ids = (productId || recent) ? [target.id] : products.map((p) => p.id);
  const { data: regs } = await admin
    .from('product_market_registrations')
    .select('*')
    .in('product_id', ids);

  if (productId || recent) {
    const filteredRegs = (regs || []).filter((r) => r.product_id === target.id);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, product: target, registrations: filteredRegs }),
    };
  }

  // 리스트 모드
  const regsByProduct = {};
  for (const r of regs || []) {
    if (!regsByProduct[r.product_id]) regsByProduct[r.product_id] = [];
    regsByProduct[r.product_id].push(r);
  }
  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      products: productList.map((p) => ({ ...p, registrations: regsByProduct[p.id] || [] })),
    }),
  };
};
