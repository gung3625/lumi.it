// 반품·교환 요청 목록 — 사장님 검토 대기 큐
// GET /api/return-request-list?status=pending|approved|all&limit=30
//
// 응답: { success, requests: [...], total, mocked? }
// - 우선순위 큐(priority-queue.js)에서 노출되는 카드의 상세
// - 모든 요청은 사장님 [예/아니오] 1탭만 진행 (자동 처리 X)

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const VALID_STATUS = new Set(['pending', 'approved', 'processing', 'completed', 'rejected', 'failed', 'all']);

function mockRequests(sellerId) {
  const base = new Date('2026-04-28T08:00:00Z').getTime();
  return [
    {
      id: 'mock-req-1',
      seller_id: sellerId,
      order_id: 'mock-order-3',
      marketplace: 'coupang',
      request_type: 'refund',
      reason: '단순 변심 — 색상이 다름',
      reason_category: 'change_of_mind',
      partial_amount: null,
      exchange_product_id: null,
      status: 'pending',
      is_high_risk: false,
      risk_reason: null,
      requested_at: new Date(base - 3600000).toISOString(),
      product_title: '봄 시폰 원피스 베이지',
      total_price: 39000,
      quantity: 1,
    },
    {
      id: 'mock-req-2',
      seller_id: sellerId,
      order_id: 'mock-order-4',
      marketplace: 'naver',
      request_type: 'exchange',
      reason: '사이즈 교환 (S → M)',
      reason_category: 'size_issue',
      partial_amount: null,
      exchange_product_id: null,
      status: 'pending',
      is_high_risk: false,
      risk_reason: null,
      requested_at: new Date(base - 7200000).toISOString(),
      product_title: '베이직 코튼 후드 티셔츠',
      total_price: 29000,
      quantity: 1,
    },
    {
      id: 'mock-req-3',
      seller_id: sellerId,
      order_id: 'mock-order-5',
      marketplace: 'coupang',
      request_type: 'partial_refund',
      reason: '하자 (단추 1개 누락)',
      reason_category: 'defect',
      partial_amount: 5000,
      exchange_product_id: null,
      status: 'pending',
      is_high_risk: true,
      risk_reason: '부분환불은 사장님 직접 확인 필수',
      requested_at: new Date(base - 1800000).toISOString(),
      product_title: '데일리 셔츠',
      total_price: 32000,
      quantity: 1,
    },
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
  const status = VALID_STATUS.has(q.status) ? q.status : 'pending';
  const limit = Math.max(1, Math.min(100, parseInt(q.limit || '30', 10)));

  const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
  let admin = null;
  try { admin = getAdminClient(); } catch { /* */ }

  if (!admin && isSignupMock) {
    let all = mockRequests(payload.seller_id);
    if (status !== 'all') all = all.filter((r) => r.status === status);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, requests: all.slice(0, limit), total: all.length, mocked: true }),
    };
  }

  if (!admin) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
  }

  // 요청 + 주문 조인 — 상품 정보 포함
  let query = admin
    .from('return_requests')
    .select(`
      id, seller_id, order_id, marketplace, request_type, reason, reason_category,
      partial_amount, exchange_product_id, status, is_high_risk, risk_reason,
      requested_at, approved_at, processed_at, completed_at, rejected_at,
      seller_note, market_response,
      marketplace_orders!inner(id, product_title, quantity, total_price, market_order_id)
    `, { count: 'exact' })
    .eq('seller_id', payload.seller_id)
    .order('requested_at', { ascending: false })
    .limit(limit);

  if (status !== 'all') query = query.eq('status', status);

  const { data, error: dbErr, count } = await query;
  if (dbErr) {
    console.error('[return-request-list] db error:', dbErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '요청 목록을 불러오지 못했어요.' }) };
  }

  const requests = (data || []).map((r) => ({
    id: r.id,
    order_id: r.order_id,
    marketplace: r.marketplace,
    request_type: r.request_type,
    reason: r.reason,
    reason_category: r.reason_category,
    partial_amount: r.partial_amount,
    exchange_product_id: r.exchange_product_id,
    status: r.status,
    is_high_risk: r.is_high_risk,
    risk_reason: r.risk_reason,
    requested_at: r.requested_at,
    approved_at: r.approved_at,
    processed_at: r.processed_at,
    completed_at: r.completed_at,
    rejected_at: r.rejected_at,
    seller_note: r.seller_note,
    product_title: r.marketplace_orders?.product_title,
    total_price: r.marketplace_orders?.total_price,
    quantity: r.marketplace_orders?.quantity,
    market_order_id: r.marketplace_orders?.market_order_id,
  }));

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ success: true, requests, total: count || requests.length }),
  };
};
