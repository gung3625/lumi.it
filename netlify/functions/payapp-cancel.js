// payapp-cancel.js — Pro 구독 해지(PayApp rebillCancel). 복구 불가(일시정지가 아니라 완전 해지).
//
// POST /api/payapp-cancel   Auth: Bearer (셀러)
// 응답: { success: true }
'use strict';

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { extractBearerToken, verifySellerToken } = require('./_shared/seller-jwt');
const { verifyBearerToken } = require('./_shared/supabase-auth');
const { getAdminClient } = require('./_shared/supabase-admin');
const { callPayApp } = require('./_shared/payapp');

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

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
  catch (e) { console.error('[payapp-cancel] admin client:', e.message); return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 설정 오류' }) }; }

  const { data: seller } = await admin
    .from('sellers')
    .select('id, payapp_rebill_no, subscription_status')
    .eq('id', sellerId)
    .maybeSingle();
  if (!seller || !seller.payapp_rebill_no) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '활성 구독이 없습니다.' }) };
  }

  let result;
  try {
    result = await callPayApp({ cmd: 'rebillCancel', rebill_no: seller.payapp_rebill_no });
  } catch (e) {
    console.error('[payapp-cancel] PayApp 호출 실패:', e && e.message);
    return { statusCode: 502, headers, body: JSON.stringify({ error: '해지 요청에 실패했습니다.' }) };
  }
  if (!result.ok) {
    console.error('[payapp-cancel] rebillCancel 실패:', result.data.errno);
    return { statusCode: 502, headers, body: JSON.stringify({ error: '해지에 실패했습니다.' }) };
  }

  const { error: upErr } = await admin
    .from('sellers')
    .update({ subscription_status: 'cancelled', subscription_cancelled_at: new Date().toISOString() })
    .eq('id', sellerId);
  if (upErr) {
    // PayApp 해지는 완료(비가역) — DB 반영만 실패. 클라이언트에 알려 수동 복구 가능하게.
    console.error('[payapp-cancel] 상태 업데이트 실패:', upErr.message);
    return { statusCode: 200, headers, body: JSON.stringify({
      success: true,
      warning: '해지는 완료됐으나 상태 반영에 실패했습니다. 새로고침 후에도 같으면 고객센터에 문의해주세요.',
    }) };
  }

  console.log(`[payapp-cancel] seller=${String(sellerId).slice(0, 8)} cancelled`);
  return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
};
