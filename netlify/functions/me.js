// 현재 셀러 조회 — Sprint 1
// GET /api/me
// 헤더: Authorization: Bearer <jwt>
// 응답: { success: true, seller: { id, ownerName, plan, signupStep, ... } }
//
// 보안:
// - 응답에서 사업자번호/휴대폰/이메일은 마스킹된 형태만 노출
// - 평문 PII는 응답에 포함 금지
const { getAdminClient } = require('./_shared/supabase-admin');
const { signSellerToken, verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
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
  if (!token) {
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
    // SIGNUP_MOCK=true 면 seller-jwt payload 그대로 반환
    const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
    if (!isSignupMock) {
      console.error('[me] Supabase 클라이언트 초기화 실패:', e.message);
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: '서버 설정 오류입니다.' }),
      };
    }
    const { payload: mockPayload } = verifySellerToken(token);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        mock: true,
        seller: {
          id: mockPayload ? mockPayload.seller_id : 'mock',
          ownerName: '사장님',
          businessNumberMasked: (mockPayload && mockPayload.business_number_masked) || '***',
          phoneMasked: '***',
          emailMasked: null,
          signupStep: 5,
          signupCompleted: true,
          businessVerified: true,
          plan: 'trial',
          trialStart: new Date().toISOString(),
          marketingConsent: false,
          referralCode: null,
          createdAt: mockPayload ? new Date(mockPayload.iat * 1000).toISOString() : new Date().toISOString(),
        },
      }),
    };
  }

  // 1) Supabase JWT 우선 검증 (OAuth 사용자 — ES256)
  let sellerId = null;
  let sellerQueryField = null;
  let sellerQueryValue = null;

  const { data: supaAuthData } = await admin.auth.getUser(token);
  if (supaAuthData && supaAuthData.user && supaAuthData.user.email) {
    sellerQueryField = 'email';
    sellerQueryValue = supaAuthData.user.email;
    console.log('[me] Supabase JWT 검증 성공');
  } else {
    // 2) seller-jwt fallback (HS256 자체 발급)
    const { payload, error: authErr } = verifySellerToken(token);
    if (authErr || !payload) {
      return {
        statusCode: 401,
        headers: CORS,
        body: JSON.stringify({ error: '인증이 필요합니다. 다시 로그인해주세요.' }),
      };
    }
    sellerId = payload.seller_id;
    console.log('[me] seller-jwt 검증 성공');
  }

  // sellers 조회: Supabase JWT → email 매칭, seller-jwt → id 매칭
  const sellerQuery = admin
    .from('sellers')
    .select('id, business_number, owner_name, phone, email, store_name, signup_step, signup_completed_at, business_verified, business_verified_at, plan, trial_start, marketing_consent, referral_code, created_at, onboarded, signup_method, display_name, avatar_url, age_range, industry');

  let { data: seller, error: selErr } = sellerQueryField
    ? await sellerQuery.eq(sellerQueryField, sellerQueryValue).maybeSingle()
    : await sellerQuery.eq('id', sellerId).maybeSingle();

  if (selErr) {
    console.error('[me] select 오류:', selErr.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '셀러 정보 조회에 실패했습니다.' }),
    };
  }

  // 관리자 자동 sellers 행 생성 (signup 미완료라도 모든 기능 프리패스)
  // 카카오 로그인은 카카오 이메일이라 Gmail 매칭 안 됨 → user.id (UUID)로 매칭
  if (!seller && supaAuthData && supaAuthData.user) {
    const userEmail = String(supaAuthData.user.email || '').toLowerCase();
    const userId = String(supaAuthData.user.id || '').toLowerCase();
    const adminEmails = String(process.env.ADMIN_EMAIL || 'gung3625@gmail.com')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const adminUserIds = String(
      (process.env.LUMI_ADMIN_USER_IDS || '') + ',' + (process.env.LUMI_BRAND_USER_ID || '')
    )
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const isAdmin = adminEmails.includes(userEmail) || (userId && adminUserIds.includes(userId));
    if (isAdmin) {
      console.log('[me] 관리자 계정 — sellers 자동 생성:', userEmail);
      const now = new Date().toISOString();
      const adminBusinessNumber = '404-09-66416';
      const { data: created, error: insErr } = await admin
        .from('sellers')
        .insert({
          email: userEmail,
          business_number: adminBusinessNumber,
          owner_name: 'Admin',
          phone: '01000000000',
          store_name: 'Lumi Admin',
          signup_step: 5,
          signup_completed_at: now,
          business_verified: true,
          business_verified_at: now,
          plan: 'beta',
          trial_start: now,
          marketing_consent: false,
        })
        .select('id, business_number, owner_name, phone, email, store_name, signup_step, signup_completed_at, business_verified, business_verified_at, plan, trial_start, marketing_consent, referral_code, created_at, onboarded, signup_method, display_name, avatar_url, age_range, industry')
        .single();
      if (!insErr && created) {
        seller = created;
      } else {
        console.error('[me] 관리자 sellers 자동 생성 실패:', insErr && insErr.message);
      }
    }
  }

  if (!seller) {
    return {
      statusCode: 404,
      headers: CORS,
      body: JSON.stringify({ error: '셀러를 찾을 수 없습니다.' }),
    };
  }

  console.log(`[me] seller=${seller.id.slice(0, 8)} step=${seller.signup_step} plan=${seller.plan}`);

  // OAuth 재방문 사용자용 seller-jwt 발급 (클라이언트 localStorage 복원용)
  let sellerToken = null;
  try {
    sellerToken = signSellerToken({
      seller_id: seller.id,
      business_number_masked: maskBusinessNumber(seller.business_number),
    });
  } catch (e) {
    console.error('[me] sellerToken 발급 실패:', e.message);
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      sellerToken,
      seller: {
        id: seller.id,
        ownerName: seller.owner_name,
        displayName: seller.display_name || null,
        avatarUrl: seller.avatar_url || null,
        ageRange: seller.age_range || null,
        storeName: seller.store_name,
        businessNumberMasked: maskBusinessNumber(seller.business_number),
        phoneMasked: maskPhone(seller.phone),
        emailMasked: seller.email ? maskEmail(seller.email) : null,
        signupStep: seller.signup_step,
        signupCompleted: Boolean(seller.signup_completed_at),
        signupCompletedAt: seller.signup_completed_at,
        onboarded: Boolean(seller.onboarded),
        signupMethod: seller.signup_method || null,
        industry: seller.industry || null,
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
