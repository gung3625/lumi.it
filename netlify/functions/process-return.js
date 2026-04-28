// 반품 처리 + 재고 가산 — Sprint 3 역방향 파이프라인
// POST /api/process-return
// Body: { order_id, reason? }   또는 일괄 { items: [{ order_id, reason }] }
//
// 동작:
// 1. orders.status = 'returned' / return_completed_at = now()
// 2. inventory_movements에 양수 가산 기록
// 3. orders.stock_restored = TRUE
// 4. 셀러용 알림 hook ("반품 처리됐어요. 재고 +1 자동 갱신")
//
// 환불 자체는 마켓 처리 — 루미는 추적·재고만.

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { recordAudit } = require('./_shared/onboarding-utils');
const { restoreStockForReturn } = require('./_shared/inventory-engine');

async function processOne(admin, sellerId, orderId, reason, mock) {
  if (!orderId) return { order_id: orderId, success: false, error: '주문 ID가 필요해요.' };

  let order = null;
  if (admin) {
    const { data, error } = await admin
      .from('marketplace_orders')
      .select('id, seller_id, market, product_id, quantity, status, stock_restored, return_requested_at')
      .eq('id', orderId)
      .eq('seller_id', sellerId)
      .single();
    if (error || !data) {
      return { order_id: orderId, success: false, error: '주문을 찾을 수 없어요.' };
    }
    order = data;
  } else {
    // 모킹
    order = { id: orderId, seller_id: sellerId, market: 'coupang', product_id: null, quantity: 1, status: 'returned', stock_restored: false };
  }

  // 상태 정정 (마켓에서 반품 접수가 안 된 주문은 셀러가 강제 처리도 가능)
  if (admin && order.status !== 'returned') {
    await admin.from('marketplace_orders').update({
      status: 'returned',
      return_requested_at: order.return_requested_at || new Date().toISOString(),
      return_reason: reason || order.return_reason || '셀러 처리',
    }).eq('id', order.id);
    order.status = 'returned';
  }

  if (order.stock_restored) {
    return { order_id: orderId, success: true, alreadyRestored: true, message: '이미 처리된 반품이에요.' };
  }

  const result = admin
    ? await restoreStockForReturn(admin, order)
    : { ok: true, movement_id: 'mock-mv-' + Date.now(), quantity_delta: order.quantity || 1 };

  if (!result.ok) {
    return { order_id: orderId, success: false, error: result.error || '재고 가산에 실패했어요.' };
  }

  return {
    order_id: orderId,
    success: true,
    quantity_restored: result.quantity_delta || order.quantity || 1,
    movement_id: result.movement_id,
    mocked: !!mock,
    message: `반품 처리됐어요. 재고 +${result.quantity_delta || order.quantity || 1} 자동 갱신.`,
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
    : (body.order_id ? [{ order_id: body.order_id, reason: body.reason }] : []);
  if (items.length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '주문이 지정되지 않았어요.' }) };
  }
  if (items.length > 100) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '한 번에 최대 100건까지 처리할 수 있어요.' }) };
  }

  const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
  let admin = null;
  try { admin = getAdminClient(); } catch {
    if (!isSignupMock) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
    }
  }

  const results = [];
  for (const item of items) {
    results.push(await processOne(admin, payload.seller_id, item.order_id, item.reason, !admin));
  }

  if (admin) {
    await recordAudit(admin, {
      actor_id: payload.seller_id,
      actor_type: 'seller',
      action: 'process_return',
      resource_type: 'marketplace_orders',
      resource_id: items.map((i) => i.order_id).join(','),
      metadata: { count: items.length, success: results.filter((r) => r.success).length },
      event,
    });
  }

  console.log(`[process-return] seller=${payload.seller_id.slice(0,8)} count=${items.length} success=${results.filter((r)=>r.success).length}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: results.some((r) => r.success),
      total: results.length,
      results,
      mocked: !admin,
    }),
  };
};
