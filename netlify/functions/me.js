// 현재 셀러 조회
// GET /api/me
// 헤더: Authorization: Bearer <jwt>
// 응답: { success: true, seller: { id, ownerName, plan, signupStep, ... } }
//
// 보안:
// - 응답에서 휴대폰/이메일은 마스킹된 형태만 노출
// - 평문 PII는 응답에 포함 금지
const { getAdminClient } = require('./_shared/supabase-admin');
const { signSellerToken, verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const {
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
          phoneMasked: '***',
          emailMasked: null,
          signupStep: 5,
          signupCompleted: true,
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
  //    카카오 가입자의 lumi_token (HS256) 을 넘기면 getUser 가 throw 할 수도 있어
  //    try/catch 로 감싸서 throw 시 곧바로 seller-jwt fallback 으로 이어지게 한다.
  let sellerId = null;
  let sellerQueryField = null;
  let sellerQueryValue = null;

  let supaAuthData = null;
  try {
    const { data } = await admin.auth.getUser(token);
    supaAuthData = data || null;
  } catch (e) {
    console.log('[me] Supabase JWT 검증 예외 — seller-jwt fallback:', e && e.message);
  }
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
    .select('id, owner_name, phone, email, store_name, signup_step, signup_completed_at, plan, trial_start, marketing_consent, referral_code, created_at, onboarded, signup_method, display_name, avatar_url, age_range, industry, region, store_desc, tone_sample_1, tone_sample_2, tone_sample_3, tone_request, deletion_requested_at, deletion_scheduled_at, deletion_cancelled_at, publish_prefs');

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
      const { data: created, error: insErr } = await admin
        .from('sellers')
        .insert({
          email: userEmail,
          owner_name: 'Admin',
          // I-C (2026-05-15): 더미 phone hardcode 제거. nullable.
          // 알림 발송 로직이 phone null 인 관리자 row 를 skip 하도록.
          phone: null,
          store_name: 'Lumi Admin',
          signup_step: 5,
          signup_completed_at: now,
          plan: 'beta',
          trial_start: now,
          marketing_consent: false,
        })
        .select('id, owner_name, phone, email, store_name, signup_step, signup_completed_at, plan, trial_start, marketing_consent, referral_code, created_at, onboarded, signup_method, display_name, avatar_url, age_range, industry, region, store_desc, tone_sample_1, tone_sample_2, tone_sample_3, tone_request, deletion_requested_at, deletion_scheduled_at, deletion_cancelled_at, publish_prefs')
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
    sellerToken = signSellerToken({ seller_id: seller.id });
  } catch (e) {
    console.error('[me] sellerToken 발급 실패:', e.message);
  }

  // IG 연동 + 토큰 만료 상태 (대시보드/설정의 "재연동 필요" 카드용).
  // 응답 키 통일 — 모든 IG 토큰 만료 응답은 tokenExpired 사용 (PR #169).
  // tokenInvalid 는 dashboard.html 옛 호환용 alias 로 유지.
  // M3.1 — 같은 row 에서 threads_user_id / threads_token_invalid_at 도 동시 조회.
  let igStatus      = { connected: false, tokenExpired: false, tokenInvalid: false };
  let threadsStatus = { connected: false, tokenExpired: false };
  try {
    const { data: igRow } = await admin
      .from('ig_accounts')
      .select('ig_user_id, token_invalid_at, threads_user_id, threads_token_invalid_at')
      .eq('user_id', seller.id)
      .maybeSingle();
    if (igRow && igRow.ig_user_id) {
      const expired = !!igRow.token_invalid_at;
      igStatus = { connected: true, tokenExpired: expired, tokenInvalid: expired };
    }
    if (igRow && igRow.threads_user_id) {
      threadsStatus = { connected: true, tokenExpired: !!igRow.threads_token_invalid_at };
    }
  } catch (e) {
    console.warn('[me] ig_accounts 조회 경고:', e && e.message);
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
        hasPhone: Boolean(seller.phone && /^010\d{7,8}$/.test(seller.phone)),
        phoneMasked: maskPhone(seller.phone),
        emailMasked: seller.email ? maskEmail(seller.email) : null,
        signupStep: seller.signup_step,
        signupCompleted: Boolean(seller.signup_completed_at),
        signupCompletedAt: seller.signup_completed_at,
        onboarded: Boolean(seller.onboarded),
        signupMethod: seller.signup_method || null,
        industry: seller.industry || null,
        region: seller.region || null,
        storeDesc: seller.store_desc || null,
        toneSample1: seller.tone_sample_1 || null,
        toneSample2: seller.tone_sample_2 || null,
        toneSample3: seller.tone_sample_3 || null,
        toneRequest: seller.tone_request || '',
        plan: seller.plan,
        trialStart: seller.trial_start,
        marketingConsent: seller.marketing_consent,
        referralCode: seller.referral_code,
        createdAt: seller.created_at,
        deletionRequestedAt: seller.deletion_requested_at || null,
        deletionScheduledAt: seller.deletion_scheduled_at || null,
        deletionCancelledAt: seller.deletion_cancelled_at || null,
        deletionPending: Boolean(seller.deletion_requested_at && !seller.deletion_cancelled_at),
        publishPrefs: seller.publish_prefs && typeof seller.publish_prefs === 'object' ? seller.publish_prefs : {},
      },
      igStatus,
      threadsStatus,
    }),
  };
};
