// Sprint 3.6 — 해지 유예 중 복원 (cancellation_requested_at 클리어)
// POST /api/seller-cancellation-restore
// Headers: Authorization: Bearer <seller-jwt>
const { getAdminClient } = require('./_shared/supabase-admin');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { verifySellerToken } = require('./_shared/seller-jwt');
const { getState } = require('./_shared/cancellation-state');
const audit = require('./_shared/audit-log');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const tok = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  let claims;
  try { claims = verifySellerToken(tok); } catch {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }
  const sellerId = claims.seller_id;

  let admin;
  try { admin = getAdminClient(); } catch (e) {
    console.error('[seller-cancellation-restore] admin init 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류입니다.' }) };
  }

  const { data: seller } = await admin
    .from('sellers')
    .select('id, cancellation_requested_at, cancellation_completed_at, cancellation_grace_until')
    .eq('id', sellerId)
    .maybeSingle();

  if (!seller) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '셀러 정보를 찾을 수 없습니다.' }) };
  }
  const state = getState(seller);
  if (state === 'COMPLETED') {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '이미 해지가 완료되어 복원할 수 없습니다.' }) };
  }
  if (state === 'ACTIVE') {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '해지 유예 상태가 아닙니다.' }) };
  }
  if (state === 'AUTO_DESTROY_PENDING') {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '유예 기간이 만료되어 복원할 수 없습니다.' }) };
  }

  const now = new Date().toISOString();
  const { error: upErr } = await admin
    .from('sellers')
    .update({
      cancellation_requested_at: null,
      cancellation_grace_until: null,
      cancellation_warned_at: null,
      cancellation_restored_at: now,
      cancellation_reason: null,
    })
    .eq('id', sellerId);
  if (upErr) {
    console.error('[seller-cancellation-restore] update 실패:', upErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '복원 처리에 실패했습니다.' }) };
  }

  await audit.log(admin, {
    actorId: sellerId,
    actorType: 'seller',
    action: 'cancellation.restore',
    resourceType: 'seller',
    resourceId: sellerId,
    metadata: {},
    event,
  });

  console.log(`[seller-cancellation-restore] seller=${sellerId.slice(0, 8)} restored`);
  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ success: true, state: 'ACTIVE', restoredAt: now }),
  };
};
