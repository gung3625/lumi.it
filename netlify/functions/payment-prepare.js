// 결제 준비 - PortOne v2
// 프론트 결제 시작 전 호출 → orderId 발급 + public.orders 사전 등록
const crypto = require('crypto');
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

// 플랜별 금액 (현 요금제: 스탠다드/프로)
const PLANS = {
  standard: { amount: 19900, name: 'lumi 스탠다드', durationDays: 31 },
  pro:      { amount: 29900, name: 'lumi 프로',     durationDays: 31 },
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const { planType } = body;
  if (!planType) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '필수 정보가 없습니다.' }) };
  }

  const plan = PLANS[planType];
  if (!plan) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 플랜입니다.' }) };
  }

  // Supabase Bearer 토큰 검증
  const token = extractBearerToken(event);
  if (!token) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '로그인이 필요합니다.' }) };
  }
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    console.warn('[payment-prepare] 토큰 검증 실패');
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증에 실패했습니다.' }) };
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
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '주문 생성에 실패했습니다.' }) };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        orderId,
        amount: plan.amount,
        orderName: plan.name,
        email: userEmail,
        name: userName,
      }),
    };
  } catch (err) {
    console.error('[payment-prepare] error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '주문 생성에 실패했습니다.' }) };
  }
};
