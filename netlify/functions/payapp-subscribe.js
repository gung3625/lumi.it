// payapp-subscribe.js — Pro 월 구독 시작(PayApp 정기결제 등록).
//
// POST /api/payapp-subscribe   Auth: Bearer (셀러)
// body: { phone? }  — 셀러 전화번호가 DB 에 없을 때만 사용
// 응답: { success: true, payurl }  — 프론트가 payurl 로 리다이렉트(PayApp 결제창서 카드 입력+최초 승인)
//
// 흐름: rebillRegist → rebill_no + payurl 수신 → seller 'pending' + rebill_no 저장 → payurl 반환.
//       이후 결제 승인은 payapp-webhook(feedbackurl)이 'active' 로 전환.
'use strict';

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { extractBearerToken, verifySellerToken } = require('./_shared/seller-jwt');
const { verifyBearerToken } = require('./_shared/supabase-auth');
const { getAdminClient } = require('./_shared/supabase-admin');
const { callPayApp, SUBSCRIPTION_PRICE, GOOD_NAME } = require('./_shared/payapp');

const SITE = 'https://lumi.it.kr';

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  // 인증 → seller_id (supabase JWT 또는 seller-jwt — quota-status 패턴)
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
  catch (e) { console.error('[payapp-subscribe] admin client:', e.message); return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 설정 오류' }) }; }

  const { data: seller, error: selErr } = await admin
    .from('sellers')
    .select('id, phone, subscription_status')
    .eq('id', sellerId)
    .maybeSingle();
  if (selErr || !seller) {
    console.error('[payapp-subscribe] seller 조회 실패:', selErr && selErr.message);
    return { statusCode: 404, headers, body: JSON.stringify({ error: '셀러를 찾을 수 없습니다.' }) };
  }
  if (seller.subscription_status === 'active') {
    return { statusCode: 409, headers, body: JSON.stringify({ error: '이미 구독 중입니다.' }) };
  }

  // recvphone — 셀러 전화 우선, 없으면 요청 body 의 phone
  let phone = String(seller.phone || '').replace(/[^0-9]/g, '');
  if (!phone) {
    try {
      let raw = event.body || '';
      if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
      const b = JSON.parse(raw || '{}');
      if (b.phone) phone = String(b.phone).replace(/[^0-9]/g, '');
    } catch (_) { /* noop */ }
  }
  if (!/^010\d{7,8}$/.test(phone)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '연락 가능한 휴대폰 번호가 필요합니다.', code: 'phone_required' }) };
  }

  let result;
  try {
    result = await callPayApp({
      cmd: 'rebillRegist',
      goodname: GOOD_NAME,
      goodprice: SUBSCRIPTION_PRICE,
      recvphone: phone,
      rebillCycleType: 'Month',
      rebillCycleMonth: '1',
      rebillExpire: '2099-12-31',
      feedbackurl: `${SITE}/api/payapp-webhook`,
      failurl: `${SITE}/api/payapp-webhook`,
      returnurl: `${SITE}/dashboard?subscribed=1`,
      openpaytype: 'card',
      var1: sellerId,
      checkretry: 'y',
    });
  } catch (e) {
    console.error('[payapp-subscribe] PayApp 호출 실패:', e && e.message);
    return { statusCode: 502, headers, body: JSON.stringify({ error: '결제 등록 요청에 실패했습니다. 잠시 후 다시 시도해주세요.' }) };
  }

  if (!result.ok || !result.data.payurl) {
    console.error('[payapp-subscribe] rebillRegist 실패:', result.data.errno);
    return { statusCode: 502, headers, body: JSON.stringify({ error: '결제 등록에 실패했습니다.' }) };
  }

  const rebillNo = result.data.rebill_no || null;
  const { error: upErr } = await admin
    .from('sellers')
    .update({ subscription_status: 'pending', payapp_rebill_no: rebillNo })
    .eq('id', sellerId);
  if (upErr) {
    // pending 기록 실패 → 결제 진행 차단(돈만 빠지고 미활성 방지). 재시도 유도.
    console.error('[payapp-subscribe] pending 저장 실패:', upErr.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '구독 준비 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' }) };
  }

  console.log(`[payapp-subscribe] seller=${String(sellerId).slice(0, 8)} rebill_no=${rebillNo} pending`);
  return { statusCode: 200, headers, body: JSON.stringify({ success: true, payurl: result.data.payurl }) };
};
