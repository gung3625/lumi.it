// Sprint 3.6 — 주문 마스킹 해제 (전체 보기) — 일시 노출 + audit 기록
// POST /api/order-unmask  body: { orderId, reason? }
// Headers: Authorization: Bearer <seller-jwt>
// 응답: 평문 buyer 정보 (60초 TTL 컨텍스트 가정 — 클라이언트 측 메모리에만 저장)
const { getAdminClient } = require('./_shared/supabase-admin');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { verifySellerToken } = require('./_shared/seller-jwt');
const audit = require('./_shared/audit-log');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const tok = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  // H4 — verifySellerToken은 throw 안 함, payload·error 객체 반환
  const { payload, error: jwtErr } = verifySellerToken(tok);
  if (jwtErr || !payload?.seller_id) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }
  const sellerId = payload.seller_id;

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* ignore */ }
  const orderId = (body.orderId || '').toString();
  const reason = (body.reason || '').toString().slice(0, 200) || null;
  if (!orderId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'orderId가 필요합니다.' }) };
  }

  let admin;
  try { admin = getAdminClient(); } catch (e) {
    console.error('[order-unmask] admin init 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류입니다.' }) };
  }

  // 본인 주문인지 확인
  const { data: order, error } = await admin
    .from('marketplace_orders')
    .select('id, seller_id, buyer_name, buyer_phone, buyer_address')
    .eq('id', orderId)
    .maybeSingle();
  if (error || !order || order.seller_id !== sellerId) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '주문 정보를 찾을 수 없습니다.' }) };
  }

  // 사장님 동의 + 반드시 audit 기록
  await audit.logUnmask(admin, {
    sellerId,
    resourceType: 'order',
    resourceId: orderId,
    field: 'all',
    reason,
    event,
  });

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      buyer: {
        name: order.buyer_name || null,
        phone: order.buyer_phone || null,
        address: order.buyer_address || null,
      },
      unmaskedAt: new Date().toISOString(),
      ttlSeconds: 60,
    }),
  };
};
