// process-return-claim.js — 반품 클레임 처리
// POST /api/process-return-claim
// body: { claim_id, action: 'received'|'refund'|'reject', refund_amount?, tracking_number? }

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const VALID_ACTIONS = new Set(['received', 'refund', 'reject']);

/**
 * 마켓별 반품 환불 API 호출
 * TODO: 실제 마켓 API 연동 시 market-adapters에 refundReturn() 추가 필요
 * - 쿠팡: POST /v2/providers/seller_api/.../return/{returnId}/approve-return
 * - 네이버: POST /external/v1/pay-user/claim/return/approve
 * - 토스: POST /v1/claim/return/confirm
 */
async function callMarketReturnApi(market, marketClaimId, action, refundAmount) {
  // TODO: 실 연동 전 placeholder
  console.log(`[process-return-claim] market=${market} claimId=${marketClaimId} action=${action} refundAmount=${refundAmount}`);
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

  const { claim_id, action, refund_amount, tracking_number } = body;
  if (!claim_id || typeof claim_id !== 'string') {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'claim_id가 필요해요.' }) };
  }
  if (!VALID_ACTIONS.has(action)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'action은 received, refund, reject 중 하나여야 해요.' }) };
  }
  if (action === 'refund' && (refund_amount === undefined || refund_amount === null)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '환불 처리 시 refund_amount가 필요해요.' }) };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[process-return-claim] supabase init error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
  }

  try {
    // 클레임 조회 + 셀러 소유권 확인
    const { data: claim, error: fetchErr } = await admin
      .from('marketplace_claims')
      .select('id, market, market_claim_id, claim_type, status, seller_id')
      .eq('id', claim_id)
      .eq('seller_id', payload.seller_id)
      .eq('claim_type', 'return')
      .single();

    if (fetchErr || !claim) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '클레임을 찾을 수 없어요.' }) };
    }

    if (['completed', 'rejected'].includes(claim.status)) {
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: '이미 처리된 클레임이에요.' }) };
    }

    // 단계별 상태 전이
    // received → in_progress (수령 확인)
    // refund   → completed  (환불 처리 완료)
    // reject   → rejected   (거부)
    const statusMap = { received: 'in_progress', refund: 'completed', reject: 'rejected' };
    const newStatus = statusMap[action];

    // 환불/거부 시 마켓 API 호출
    let mocked = false;
    if (action === 'refund' || action === 'reject') {
      const marketResult = await callMarketReturnApi(claim.market, claim.market_claim_id, action, refund_amount);
      if (!marketResult.ok) {
        return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: '마켓 API 호출에 실패했어요.' }) };
      }
      mocked = marketResult.mocked || false;
    }

    const now = new Date().toISOString();
    const updateFields = {
      status: newStatus,
      updated_at: now,
    };
    if (tracking_number) updateFields.return_tracking_number = tracking_number;
    if (refund_amount !== undefined && refund_amount !== null) updateFields.refund_amount = refund_amount;
    if (newStatus === 'completed' || newStatus === 'rejected') updateFields.resolved_at = now;

    const { error: updateErr } = await admin
      .from('marketplace_claims')
      .update(updateFields)
      .eq('id', claim_id);

    if (updateErr) {
      console.error('[process-return-claim] update error:', updateErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '상태 업데이트에 실패했어요.' }) };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, claim_id, action, status: newStatus, mocked }),
    };
  } catch (e) {
    console.error('[process-return-claim] unexpected error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류가 발생했어요.' }) };
  }
};
