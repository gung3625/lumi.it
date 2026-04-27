// 현재 셀러 조회 — Sprint 1
// GET /api/me
// 헤더: Authorization: Bearer <jwt>
// 응답: { success: true, seller: { id, ownerName, plan, signupStep, ... } }
//
// 보안:
// - 응답에서 사업자번호/휴대폰/이메일은 마스킹된 형태만 노출
// - 평문 PII는 응답에 포함 금지
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const {
  maskBusinessNumber,
  maskPhone,
  maskEmail,
} = require('./_shared/onboarding-utils');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error: authErr } = verifySellerToken(token);
  if (authErr || !payload) {
    return {
      statusCode: 401,
      headers: CORS,
      body: JSON.stringify({ error: '인증이 필요합니다. 다시 로그인해주세요.' }),
    };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    // SIGNUP_MOCK=true 면 JWT payload 그대로 반환
    const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
    if (!isSignupMock) {
      console.error('[me] Supabase 클라이언트 초기화 실패:', e.message);
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: '서버 설정 오류입니다.' }),
      };
    }
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        mock: true,
        seller: {
          id: payload.seller_id,
          ownerName: '사장님',
          businessNumberMasked: payload.business_number_masked || '***',
          phoneMasked: '***',
          emailMasked: null,
          signupStep: 5,
          signupCompleted: true,
          businessVerified: true,
          plan: 'trial',
          trialStart: new Date().toISOString(),
          marketingConsent: false,
          referralCode: null,
          createdAt: new Date(payload.iat * 1000).toISOString(),
        },
      }),
    };
  }

  const { data: seller, error: selErr } = await admin
    .from('sellers')
    .select('id, business_number, owner_name, phone, email, store_name, signup_step, signup_completed_at, business_verified, business_verified_at, plan, trial_start, marketing_consent, referral_code, created_at')
    .eq('id', payload.seller_id)
    .maybeSingle();

  if (selErr) {
    console.error('[me] select 오류:', selErr.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '셀러 정보 조회에 실패했습니다.' }),
    };
  }

  if (!seller) {
    return {
      statusCode: 404,
      headers: CORS,
      body: JSON.stringify({ error: '셀러를 찾을 수 없습니다.' }),
    };
  }

  console.log(`[me] seller=${seller.id.slice(0, 8)} step=${seller.signup_step} plan=${seller.plan}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      seller: {
        id: seller.id,
        ownerName: seller.owner_name,
        storeName: seller.store_name,
        businessNumberMasked: maskBusinessNumber(seller.business_number),
        phoneMasked: maskPhone(seller.phone),
        emailMasked: seller.email ? maskEmail(seller.email) : null,
        signupStep: seller.signup_step,
        signupCompleted: Boolean(seller.signup_completed_at),
        signupCompletedAt: seller.signup_completed_at,
        businessVerified: seller.business_verified,
        plan: seller.plan,
        trialStart: seller.trial_start,
        marketingConsent: seller.marketing_consent,
        referralCode: seller.referral_code,
        createdAt: seller.created_at,
      },
    }),
  };
};
