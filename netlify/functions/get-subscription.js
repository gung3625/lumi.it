// get-subscription.js — 셀러 구독 상태 조회 (subscribe 페이지 렌더용).
// GET /api/get-subscription   Auth: Bearer (셀러)
// 응답: { status, nextBillingDate, startedAt, hasRebill, price }
'use strict';

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { extractBearerToken, verifySellerToken } = require('./_shared/seller-jwt');
const { verifyBearerToken } = require('./_shared/supabase-auth');
const { getAdminClient } = require('./_shared/supabase-admin');
const { SUBSCRIPTION_PRICE } = require('./_shared/payapp');

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'GET only' }) };

  const token = extractBearerToken(event);
  const { user } = await verifyBearerToken(token);
  let sellerId = user && user.id ? user.id : null;
  if (!sellerId) {
    const { payload } = verifySellerToken(token);
    if (payload && payload.seller_id) sellerId = payload.seller_id;
  }
  if (!sellerId) return { statusCode: 401, headers, body: JSON.stringify({ error: '인증이 필요합니다.' }) };

  let admin;
  try { admin = getAdminClient(); }
  catch (e) { console.error('[get-subscription] admin:', e.message); return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 설정 오류' }) }; }

  const { data: seller, error } = await admin
    .from('sellers')
    .select('subscription_status, next_billing_date, subscription_started_at, payapp_rebill_no')
    .eq('id', sellerId)
    .maybeSingle();
  if (error || !seller) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: '셀러를 찾을 수 없습니다.' }) };
  }

  return {
    statusCode: 200,
    headers: { ...headers, 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      status: seller.subscription_status || 'none',
      nextBillingDate: seller.next_billing_date || null,
      startedAt: seller.subscription_started_at || null,
      hasRebill: Boolean(seller.payapp_rebill_no),
      price: SUBSCRIPTION_PRICE,
    }),
  };
};
