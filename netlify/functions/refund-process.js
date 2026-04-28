// 반품·환불 처리 — Sprint 5 기본기
// POST /api/refund-process
// Body: { orderId, reason, type: 'refund'|'exchange', confirm?: true }
//
// 위험 작업 = 사장님 [예/아니오] 승인 필수 (confirm=true 없으면 dry-run preview)
//
// 동작:
// 1. 셀러 JWT 검증
// 2. 주문 조회 + 소유자 검증
// 3. confirm=true 아니면 preview만 (위험 작업 승인 게이트)
// 4. 마켓 어댑터 processRefund 호출
// 5. orders.status 갱신, inventory_movements 가산 (refund=stock 복원)
// 6. Audit Log 모든 변경 기록

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { recordAudit } = require('./_shared/onboarding-utils');
const { translateMarketError } = require('./_shared/market-errors');
const { tryAcquire } = require('./_shared/throttle');
const retryEngine = require('./_shared/retry-engine');
const { restoreStockForReturn } = require('./_shared/inventory-engine');
const coupangOrders = require('./_shared/market-adapters/coupang-orders-adapter');
const naverOrders = require('./_shared/market-adapters/naver-orders-adapter');

const ADAPTERS = { coupang: coupangOrders, naver: naverOrders };
const VALID_TYPES = new Set(['refund', 'exchange']);

function adapterMockEnabled() {
  return (process.env.COUPANG_VERIFY_MOCK || 'true').toLowerCase() !== 'false'
    || (process.env.NAVER_VERIFY_MOCK || 'true').toLowerCase() !== 'false';
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error: authErr } = verifySellerToken(token);
  if (authErr || !payload) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요해요.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청 형식이에요.' }) };
  }

  const orderId = String(body.orderId || body.order_id || '').trim();
  if (!orderId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '주문 ID가 필요해요.' }) };
  }
  const reason = String(body.reason || '').trim().slice(0, 500);
  const type = VALID_TYPES.has(body.type) ? body.type : 'refund';
  const confirm = body.confirm === true;

  const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
  const mock = adapterMockEnabled();
  let admin = null;
  try { admin = getAdminClient(); } catch {
    if (!isSignupMock) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
    }
  }

  // 주문 조회
  let order = null;
  if (admin) {
    const { data, error: oErr } = await admin
      .from('marketplace_orders')
      .select('id, seller_id, market, market_order_id, product_id, product_title, quantity, total_price, status, stock_restored, return_requested_at, return_reason')
      .eq('id', orderId)
      .eq('seller_id', payload.seller_id)
      .single();
    if (oErr || !data) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '주문을 찾을 수 없어요.' }) };
    }
    order = data;
  } else {
    // 모킹: 결정론적 주문
    order = {
      id: orderId,
      seller_id: payload.seller_id,
      market: 'coupang',
      market_order_id: `CP_MOCK_${orderId}`,
      product_id: null,
      product_title: '모킹 상품',
      quantity: 1,
      total_price: 10000,
      status: 'paid',
      stock_restored: false,
    };
  }

  if (!ADAPTERS[order.market]) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '지원하지 않는 마켓이에요.' }) };
  }

  // 위험 작업 게이트 — confirm=true 없으면 preview
  if (!confirm) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        preview: true,
        confirmRequired: true,
        order: {
          id: order.id,
          market: order.market,
          market_order_id: order.market_order_id,
          product_title: order.product_title,
          quantity: order.quantity,
          total_price: order.total_price,
          status: order.status,
        },
        action: type,
        reason,
        message: type === 'refund'
          ? `이 주문을 환불 처리하시겠어요? 환불금 ${order.total_price.toLocaleString()}원이 구매자에게 반환되고, 재고 ${order.quantity}개가 자동 복원돼요. 확인하시려면 confirm=true로 다시 호출해주세요.`
          : `이 주문을 교환 처리하시겠어요? 새 송장이 필요하고, 기존 재고는 복원돼요. 확인하시려면 confirm=true로 다시 호출해주세요.`,
      }),
    };
  }

  // 이미 처리된 주문
  if (order.status === 'returned' && order.stock_restored) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        alreadyProcessed: true,
        message: '이미 처리된 환불이에요.',
        order: { id: order.id, status: order.status, stock_restored: order.stock_restored },
      }),
    };
  }

  // 자격증명 조회
  let creds = null;
  if (admin) {
    const { data } = await admin
      .from('market_credentials')
      .select('credentials_encrypted, access_token_encrypted, token_expires_at, market_seller_id')
      .eq('seller_id', payload.seller_id)
      .eq('market', order.market)
      .single();
    creds = data || null;
  }

  // throttle
  const throttle = tryAcquire(order.market, creds?.market_seller_id);
  if (!throttle.allowed) {
    return {
      statusCode: 429,
      headers: CORS,
      body: JSON.stringify({ error: '잠시 후 다시 시도해주세요.', retryAfterMs: throttle.retryAfterMs }),
    };
  }

  // 마켓 어댑터 호출
  const adapter = ADAPTERS[order.market];
  const apiResult = await adapter.processRefund({
    market_order_id: order.market_order_id,
    reason,
    type,
    credentials: creds?.credentials_encrypted,
    access_token_encrypted: creds?.access_token_encrypted,
    token_expires_at: creds?.token_expires_at,
    market_seller_id: creds?.market_seller_id,
    mock,
  });

  // 재고 복원 (refund 성공 시)
  let stockResult = null;
  if (admin && apiResult.ok && type === 'refund') {
    stockResult = await restoreStockForReturn(admin, {
      id: order.id,
      seller_id: order.seller_id,
      product_id: order.product_id,
      market: order.market,
      quantity: order.quantity,
    });
  }

  // 주문 상태 갱신
  if (admin && apiResult.ok) {
    const update = {
      return_reason: reason || '셀러 처리',
      return_requested_at: order.return_requested_at || new Date().toISOString(),
    };
    if (type === 'refund') {
      update.status = 'returned';
      update.return_completed_at = new Date().toISOString();
    }
    await admin.from('marketplace_orders').update(update).eq('id', order.id);
  }

  // 실패 시 retry queue
  if (admin && !apiResult.ok && apiResult.retryable) {
    await retryEngine.enqueue(admin, {
      seller_id: payload.seller_id,
      task_type: 'refund_process',
      market: order.market,
      payload: { order_id: order.id, market_order_id: order.market_order_id, type, reason },
      last_error: { message: apiResult.error, status: apiResult.status },
    });
  }

  // Audit Log
  if (admin) {
    await recordAudit(admin, {
      actor_id: payload.seller_id,
      actor_type: 'seller',
      action: 'refund_process',
      resource_type: 'marketplace_orders',
      resource_id: order.id,
      metadata: {
        market: order.market,
        type,
        reason: reason ? '제공됨' : '미제공',
        api_ok: !!apiResult.ok,
        stock_restored: !!(stockResult && stockResult.ok),
        amount: order.total_price,
      },
      event,
    });
  }

  console.log(`[refund-process] seller=${payload.seller_id.slice(0,8)} order=${orderId.slice(0,8)} type=${type} api_ok=${apiResult.ok}`);

  const friendly = apiResult.ok ? null : translateMarketError(order.market, apiResult.status || 500, apiResult.error);

  return {
    statusCode: apiResult.ok ? 200 : (apiResult.status || 500),
    headers: CORS,
    body: JSON.stringify({
      success: !!apiResult.ok,
      orderId: order.id,
      type,
      market: order.market,
      refund_id: apiResult.refund_id || null,
      stock_restored: !!(stockResult && stockResult.ok),
      mocked: !!apiResult.mocked,
      error: friendly,
      retryable: !!apiResult.retryable,
    }),
  };
};
