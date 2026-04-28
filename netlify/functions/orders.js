// 주문 리스트·상세 조회 — Sprint 3
// GET /api/orders                — 주문 리스트 (filter, limit)
// GET /api/orders?id=<uuid>       — 주문 상세
//
// 모바일 selective + PC 풀 (반응형은 클라이언트). 응답은 동일.

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const VALID_FILTERS = new Set(['all', 'pending_shipping', 'in_transit', 'delivered', 'returned', 'pending_return', 'cancelled']);

function applyFilter(query, filter) {
  switch (filter) {
    case 'pending_shipping':
      return query.eq('status', 'paid').is('tracking_number', null);
    case 'in_transit':
      return query.eq('status', 'shipping');
    case 'delivered':
      return query.eq('status', 'delivered');
    case 'returned':
      return query.eq('status', 'returned');
    case 'pending_return':
      return query.eq('status', 'returned').eq('stock_restored', false);
    case 'cancelled':
      return query.eq('status', 'cancelled');
    case 'all':
    default:
      return query;
  }
}

function mockOrders(sellerId) {
  // 결정론적 ID — 리스트와 상세 호출이 같은 ID 사용
  const baseTime = new Date('2026-04-28T08:00:00Z').getTime();
  return [
    { id: `mock-order-1`, seller_id: sellerId, market: 'coupang', market_order_id: `CP_M1`, product_title: '봄 시폰 원피스 베이지', quantity: 1, total_price: 39000, option_text: '베이지 / M', status: 'paid', tracking_number: null, courier_code: null, buyer_name_masked: '김**', buyer_phone_masked: '010-****-5678', buyer_address_masked: '서울특별시 강남구 ***', created_at: new Date(baseTime - 60000).toISOString() },
    { id: `mock-order-2`, seller_id: sellerId, market: 'naver',   market_order_id: `NV_M2`, product_title: '베이직 코튼 후드 티셔츠', quantity: 2, total_price: 58000, option_text: '블랙 / L', status: 'shipping', tracking_number: '4321987650', courier_code: 'CJGLS', buyer_name_masked: '이**', buyer_phone_masked: '010-****-1234', buyer_address_masked: '경기도 성남시 ***', created_at: new Date(baseTime - 120000).toISOString() },
    { id: `mock-order-3`, seller_id: sellerId, market: 'coupang', market_order_id: `CP_M3`, product_title: '봄 시폰 원피스 베이지', quantity: 1, total_price: 39000, option_text: '화이트 / S', status: 'returned', tracking_number: '1111222233', courier_code: 'LOGEN', buyer_name_masked: '박**', buyer_phone_masked: '010-****-9999', buyer_address_masked: '서울특별시 마포구 ***', stock_restored: false, return_requested_at: new Date(baseTime - 3600000).toISOString(), created_at: new Date(baseTime - 86400000).toISOString() },
  ];
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error } = verifySellerToken(token);
  if (error || !payload) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요해요.' }) };
  }

  const q = event.queryStringParameters || {};
  const filter = VALID_FILTERS.has(q.filter) ? q.filter : 'all';
  const limit = Math.max(1, Math.min(100, parseInt(q.limit || '30', 10)));
  const orderId = q.id || null;

  const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
  let admin = null;
  try { admin = getAdminClient(); } catch { /* */ }

  if (!admin && isSignupMock) {
    const all = mockOrders(payload.seller_id);
    if (orderId) {
      const o = all.find((x) => x.id === orderId) || null;
      return { statusCode: o ? 200 : 404, headers: CORS, body: JSON.stringify({ success: !!o, order: o, mocked: true }) };
    }
    let filtered = all;
    if (filter === 'pending_shipping') filtered = all.filter((o) => o.status === 'paid' && !o.tracking_number);
    else if (filter === 'in_transit') filtered = all.filter((o) => o.status === 'shipping');
    else if (filter === 'delivered') filtered = all.filter((o) => o.status === 'delivered');
    else if (filter === 'returned') filtered = all.filter((o) => o.status === 'returned');
    else if (filter === 'pending_return') filtered = all.filter((o) => o.status === 'returned' && !o.stock_restored);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, orders: filtered.slice(0, limit), total: filtered.length, mocked: true }) };
  }

  if (!admin) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
  }

  if (orderId) {
    const { data, error: ferr } = await admin
      .from('marketplace_orders')
      .select('*')
      .eq('seller_id', payload.seller_id)
      .eq('id', orderId)
      .single();
    if (ferr || !data) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '주문을 찾을 수 없어요.' }) };
    }
    // 추적 이벤트 동봉
    const { data: events } = await admin
      .from('tracking_events')
      .select('status, description, location, occurred_at')
      .eq('order_id', orderId)
      .order('occurred_at', { ascending: true });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, order: data, tracking_events: events || [] }) };
  }

  let query = admin
    .from('marketplace_orders')
    .select('id, market, market_order_id, product_title, quantity, total_price, option_text, status, tracking_number, courier_code, buyer_name_masked, buyer_phone_masked, buyer_address_masked, return_requested_at, stock_restored, shipped_at, delivered_at, created_at', { count: 'exact' })
    .eq('seller_id', payload.seller_id)
    .order('created_at', { ascending: false })
    .limit(limit);
  query = applyFilter(query, filter);

  const { data, error: lerr, count } = await query;
  if (lerr) {
    console.error('[orders] list error:', lerr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '주문을 불러오지 못했어요.' }) };
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ success: true, orders: data || [], total: count || (data || []).length, filter }),
  };
};
