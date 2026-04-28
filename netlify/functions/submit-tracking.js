// 송장 입력 + 마켓 전송 — Sprint 3
// POST /api/submit-tracking
// Body: { order_id, tracking_number, courier_code }
// 또는 일괄: { items: [{ order_id, tracking_number, courier_code }] }  (PC 일괄용)
//
// 동작:
// 1. orders 조회 + 셀러 검증
// 2. 마켓 어댑터.submitTracking 호출
// 3. 실패 시 retry_queue 적재
// 4. orders.tracking_number/shipped_at 갱신

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { recordAudit } = require('./_shared/onboarding-utils');
const { isValidCourierCode } = require('./_shared/courier-codes');
const { translateMarketError } = require('./_shared/market-errors');
const { tryAcquire } = require('./_shared/throttle');
const retryEngine = require('./_shared/retry-engine');
const coupangOrders = require('./_shared/market-adapters/coupang-orders-adapter');
const naverOrders = require('./_shared/market-adapters/naver-orders-adapter');

const ADAPTERS = { coupang: coupangOrders, naver: naverOrders };

async function processItem(admin, sellerId, item, mock) {
  if (!item.order_id || !item.tracking_number || !item.courier_code) {
    return { order_id: item.order_id, success: false, error: '주문번호·송장번호·택배사 모두 필요해요.' };
  }
  if (!isValidCourierCode(item.courier_code)) {
    return { order_id: item.order_id, success: false, error: '지원하지 않는 택배사예요.' };
  }
  if (!/^[A-Z0-9-]{4,30}$/i.test(String(item.tracking_number).trim())) {
    return { order_id: item.order_id, success: false, error: '송장번호 형식을 확인해주세요.' };
  }

  // 주문 조회
  let order = null;
  if (admin) {
    const { data, error } = await admin
      .from('marketplace_orders')
      .select('id, seller_id, market, market_order_id, status, tracking_number')
      .eq('id', item.order_id)
      .eq('seller_id', sellerId)
      .single();
    if (error || !data) {
      return { order_id: item.order_id, success: false, error: '주문을 찾을 수 없어요.' };
    }
    order = data;
  } else {
    // 모킹
    order = { id: item.order_id, seller_id: sellerId, market: item.market || 'coupang', market_order_id: item.market_order_id || `CP_${item.order_id}`, status: 'paid' };
  }

  if (order.status === 'shipping' || order.status === 'delivered') {
    return { order_id: item.order_id, success: false, error: '이미 출고된 주문이에요.' };
  }

  const adapter = ADAPTERS[order.market];
  if (!adapter) {
    return { order_id: item.order_id, success: false, error: '지원하지 않는 마켓이에요.' };
  }

  // throttle
  const throttle = tryAcquire(order.market);
  if (!throttle.allowed) {
    return { order_id: item.order_id, success: false, error: '잠시 후 다시 시도해주세요.', retryable: true };
  }

  // 자격증명 조회
  let creds = null;
  if (admin) {
    const { data } = await admin
      .from('market_credentials')
      .select('credentials_encrypted, access_token_encrypted, token_expires_at, market_seller_id')
      .eq('seller_id', sellerId)
      .eq('market', order.market)
      .single();
    creds = data || null;
  }

  const result = await adapter.submitTracking({
    market_order_id: order.market_order_id,
    tracking_number: String(item.tracking_number).trim(),
    courier_code: item.courier_code,
    credentials: creds?.credentials_encrypted,
    access_token_encrypted: creds?.access_token_encrypted,
    token_expires_at: creds?.token_expires_at,
    market_seller_id: creds?.market_seller_id,
    mock,
  });

  if (admin && result.ok) {
    await admin
      .from('marketplace_orders')
      .update({
        tracking_number: String(item.tracking_number).trim(),
        courier_code: item.courier_code,
        status: 'shipping',
        shipped_at: new Date().toISOString(),
      })
      .eq('id', order.id);
  }

  if (admin && !result.ok && result.retryable) {
    await retryEngine.enqueue(admin, {
      seller_id: sellerId,
      task_type: 'send_invoice',
      market: order.market,
      payload: { order_id: order.id, tracking_number: item.tracking_number, courier_code: item.courier_code },
      last_error: { message: result.error, status: result.status },
    });
  }

  const friendly = result.ok ? null : translateMarketError(order.market, result.status || 500, result.error);
  return {
    order_id: order.id,
    success: !!result.ok,
    market: order.market,
    tracking_number: result.ok ? item.tracking_number : null,
    mocked: !!result.mocked,
    error: friendly,
  };
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error } = verifySellerToken(token);
  if (error || !payload) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요해요.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청 형식이에요.' }) };
  }
  const items = Array.isArray(body.items) && body.items.length > 0
    ? body.items
    : (body.order_id ? [{ order_id: body.order_id, tracking_number: body.tracking_number, courier_code: body.courier_code }] : []);

  if (items.length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '입력값이 없어요.' }) };
  }
  if (items.length > 200) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '한 번에 최대 200건까지 처리할 수 있어요.' }) };
  }

  const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
  const adapterMock = (process.env.COUPANG_VERIFY_MOCK || 'true').toLowerCase() !== 'false'
    || (process.env.NAVER_VERIFY_MOCK || 'true').toLowerCase() !== 'false';

  let admin = null;
  try { admin = getAdminClient(); } catch {
    if (!isSignupMock) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
    }
  }

  const results = [];
  for (const item of items) {
    results.push(await processItem(admin, payload.seller_id, item, adapterMock));
  }

  if (admin) {
    await recordAudit(admin, {
      actor_id: payload.seller_id,
      actor_type: 'seller',
      action: 'submit_tracking',
      resource_type: 'marketplace_orders',
      resource_id: items.map((i) => i.order_id).join(','),
      metadata: { count: items.length, success: results.filter((r) => r.success).length },
      event,
    });
  }

  console.log(`[submit-tracking] seller=${payload.seller_id.slice(0,8)} count=${items.length} success=${results.filter((r)=>r.success).length}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: results.some((r) => r.success),
      total: results.length,
      results,
      mocked: adapterMock || isSignupMock,
    }),
  };
};
