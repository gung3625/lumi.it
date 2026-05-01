// process-cancel-claim.js — 취소 클레임 처리
// POST /api/process-cancel-claim
// body: { claim_id, action: 'approve'|'reject', reason? }

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const VALID_ACTIONS = new Set(['approve', 'reject']);

/**
 * 마켓별 취소 확정 API 호출
 * TODO: 실제 마켓 API 연동 시 market-adapters의 각 어댑터에 cancelOrder() 추가 필요
 * - 쿠팡: PATCH /v2/providers/seller_api/apis/api/v1/orders/{orderId}/cancel-complete
 * - 네이버: POST /external/v1/pay-user/claim/cancel/approve
 * - 토스: POST /v1/claim/cancel/confirm
 */
async function callMarketCancelApi(market, marketClaimId, action, reason) {
  // TODO: 실 연동 전 placeholder — 마켓 어댑터 구현 시 교체
  console.log(`[process-cancel-claim] market=${market} claimId=${marketClaimId} action=${action}`);
  return { ok: true, mocked: true };
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error } = verifySellerToken(token);
  if (error || !payload) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요해요.' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청 형식이에요.' }) };
  }

  const { claim_id, action, reason } = body;
  if (!claim_id || typeof claim_id !== 'string') {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'claim_id가 필요해요.' }) };
  }
  if (!VALID_ACTIONS.has(action)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'action은 approve 또는 reject여야 해요.' }) };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[process-cancel-claim] supabase init error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
  }

  try {
    // 클레임 조회 + 셀러 소유권 확인
    const { data: claim, error: fetchErr } = await admin
      .from('marketplace_claims')
      .select('id, market, market_claim_id, claim_type, status, seller_id')
      .eq('id', claim_id)
      .eq('seller_id', payload.seller_id)
      .eq('claim_type', 'cancel')
      .single();

    if (fetchErr || !claim) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '클레임을 찾을 수 없어요.' }) };
    }

    if (['completed', 'rejected'].includes(claim.status)) {
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: '이미 처리된 클레임이에요.' }) };
    }

    // 마켓 API 호출
    const marketResult = await callMarketCancelApi(claim.market, claim.market_claim_id, action, reason);
    if (!marketResult.ok) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: '마켓 API 호출에 실패했어요.' }) };
    }

    // DB 상태 업데이트
    const newStatus = action === 'approve' ? 'completed' : 'rejected';
    const now = new Date().toISOString();
    const { error: updateErr } = await admin
      .from('marketplace_claims')
      .update({
        status: newStatus,
        seller_response: reason || null,
        resolved_at: now,
        updated_at: now,
      })
      .eq('id', claim_id);

    if (updateErr) {
      console.error('[process-cancel-claim] update error:', updateErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '상태 업데이트에 실패했어요.' }) };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        claim_id,
        action,
        status: newStatus,
        mocked: marketResult.mocked || false,
      }),
    };
  } catch (e) {
    console.error('[process-cancel-claim] unexpected error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류가 발생했어요.' }) };
  }
};
