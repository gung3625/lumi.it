// 주문서 메모 수정 — POST /api/update-order-memo
// Body: { orderId: string, memo: string }
// 인증: verifySellerToken, 본인 주문만 수정
// 보안: 메모 내용 로그 X, SQL 파라미터화

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const audit = require('./_shared/audit-log');

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
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '요청 형식이 잘못됐어요.' }) };
  }

  const { orderId, memo } = body;
  if (!orderId || typeof orderId !== 'string') {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'orderId가 필요해요.' }) };
  }
  // memo는 null(삭제) 또는 string(최대 2000자)
  const memoValue = memo === null || memo === undefined ? null : String(memo).slice(0, 2000);

  let admin;
  try { admin = getAdminClient(); } catch {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
  }

  // 본인 주문인지 확인 후 업데이트 (seller_id 검증 포함)
  const now = new Date().toISOString();
  const { data, error: upErr } = await admin
    .from('marketplace_orders')
    .update({ seller_memo: memoValue, seller_memo_updated_at: now })
    .eq('id', orderId)
    .eq('seller_id', payload.seller_id)
    .select('id, seller_memo, seller_memo_updated_at')
    .single();

  if (upErr || !data) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '주문을 찾을 수 없어요.' }) };
  }

  // audit_logs 기록 (메모 내용은 로그 X — 개인정보 가능)
  await audit.log(admin, {
    actorId: payload.seller_id,
    actorType: 'seller',
    action: 'order.memo_updated',
    resourceType: 'marketplace_orders',
    resourceId: orderId,
    metadata: { has_memo: memoValue !== null },
    event,
  });

  console.log(`[update-order-memo] seller=${payload.seller_id.slice(0, 8)} order=${orderId.slice(0, 8)}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      seller_memo: data.seller_memo,
      seller_memo_updated_at: data.seller_memo_updated_at,
    }),
  };
};
