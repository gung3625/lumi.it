// Sprint 3.6 — 해지 신청 (30일 유예 시작)
// POST /api/seller-cancellation-request
// body: { reason? }
// Headers: Authorization: Bearer <seller-jwt>
// 응답: { success, state: 'GRACE_PERIOD', graceUntil, daysRemaining }
const { getAdminClient } = require('./_shared/supabase-admin');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { verifySellerToken } = require('./_shared/seller-jwt');
const { computeGraceUntil, GRACE_DAYS } = require('./_shared/cancellation-state');
const audit = require('./_shared/audit-log');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const auth = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  let claims;
  try {
    claims = verifySellerToken(auth);
  } catch {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }
  const sellerId = claims.seller_id;
  if (!sellerId) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증 정보가 올바르지 않습니다.' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* ignore */ }
  const reason = (body.reason || '').toString().slice(0, 500) || null;

  let admin;
  try { admin = getAdminClient(); } catch (e) {
    console.error('[seller-cancellation-request] admin init 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류입니다.' }) };
  }

  const now = new Date();
  const grace = computeGraceUntil(now);

  // 이미 유예 중인지 체크
  const { data: seller, error: selErr } = await admin
    .from('sellers')
    .select('id, cancellation_requested_at, cancellation_completed_at')
    .eq('id', sellerId)
    .maybeSingle();
  if (selErr || !seller) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '셀러 정보를 찾을 수 없습니다.' }) };
  }
  if (seller.cancellation_completed_at) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '이미 해지가 완료된 계정입니다.' }) };
  }
  if (seller.cancellation_requested_at) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '이미 해지 유예 중입니다. 복원하려면 [복원] 버튼을 눌러주세요.' }) };
  }

  const { error: upErr } = await admin
    .from('sellers')
    .update({
      cancellation_requested_at: now.toISOString(),
      cancellation_grace_until: grace.toISOString(),
      cancellation_reason: reason,
      cancellation_completed_at: null,
      cancellation_restored_at: null,
      cancellation_warned_at: null,
    })
    .eq('id', sellerId);
  if (upErr) {
    console.error('[seller-cancellation-request] update 실패:', upErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '해지 신청 처리에 실패했습니다.' }) };
  }

  await audit.log(admin, {
    actorId: sellerId,
    actorType: 'seller',
    action: 'cancellation.request',
    resourceType: 'seller',
    resourceId: sellerId,
    metadata: { graceDays: GRACE_DAYS, hasReason: Boolean(reason) },
    event,
  });

  console.log(`[seller-cancellation-request] seller=${sellerId.slice(0, 8)} grace_until=${grace.toISOString()}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      state: 'GRACE_PERIOD',
      graceUntil: grace.toISOString(),
      daysRemaining: GRACE_DAYS,
    }),
  };
};
