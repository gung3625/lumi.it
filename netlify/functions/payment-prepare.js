// 결제 준비 - PortOne v2
// 프론트 결제 시작 전 호출 → orderId 발급 + public.orders 사전 등록
const crypto = require('crypto');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');


// 플랜별 금액 (베타 단일 플랜 · amount 0 = PortOne 결제 스킵)
const PLANS = {
  beta: { amount: 0, name: 'lumi 베타', durationDays: 7 },
};

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const { planType } = body;
  if (!planType) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: '필수 정보가 없습니다.' }) };
  }

  const plan = PLANS[planType];
  if (!plan) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: '잘못된 플랜입니다.' }) };
  }

  // Supabase Bearer 토큰 검증
  const token = extractBearerToken(event);
  if (!token) {
    return { statusCode: 401, headers: headers, body: JSON.stringify({ error: '로그인이 필요합니다.' }) };
  }
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    console.warn('[payment-prepare] 토큰 검증 실패');
    return { statusCode: 401, headers: headers, body: JSON.stringify({ error: '인증에 실패했습니다.' }) };
  }

  const admin = getAdminClient();

  // 사용자 정보 조회 (결제창에 이름/이메일 전달용)
  let userName = '고객';
  let userEmail = user.email || '';
  try {
    const { data: profile } = await admin
      .from('users')
      .select('name, store_name, email')
      .eq('id', user.id)
      .single();
    if (profile) {
      userName = profile.name || profile.store_name || '고객';
      userEmail = profile.email || userEmail;
    }
  } catch (e) {
    console.error('[payment-prepare] 사용자 조회 오류:', e.message);
  }

  // 고유 주문 ID 생성 (PortOne v2 paymentId = 클라이언트 생성)
  const orderId = 'lumi_' + Date.now() + '_' + crypto.randomBytes(12).toString('hex');

  try {
    // public.orders 사전 등록
    const { error: insertErr } = await admin
      .from('orders')
      .insert({
        user_id: user.id,
        portone_payment_id: orderId,
        amount: plan.amount,
        plan: planType,
        status: 'prepared',
        raw: {
          orderName: plan.name,
          durationDays: plan.durationDays,
          createdAt: new Date().toISOString(),
        },
      });

    if (insertErr) {
      console.error('[payment-prepare] orders insert 오류:', insertErr.message);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '주문 생성에 실패했습니다.' }) };
    }

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({
        success: true,
        orderId,
        amount: plan.amount,
        orderName: plan.name,
        email: userEmail,
        name: userName,
        // amount가 0이면 PortOne 결제 호출 없이 바로 confirm 단계로 진행
        skipPayment: plan.amount === 0,
      }),
    };
  } catch (err) {
    console.error('[payment-prepare] error:', err.message);
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '주문 생성에 실패했습니다.' }) };
  }
};
