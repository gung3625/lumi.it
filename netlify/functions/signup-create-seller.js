// 셀러 가입 (5단계 마지막) — Sprint 1
// POST /api/signup-create-seller
// body: { businessNumber, ownerName, phone, email, birthDate, storeName,
//         marketingConsent, privacyConsent, termsConsent, signupStep,
//         licenseFileUrl? }
// 응답: { success: true, token, seller: { id, ownerName, plan, signupStep } }
//
// 동작:
// - 사업자번호 + 형식 검증
// - sellers 테이블 upsert (business_number 기준)
// - JWT 발급
// - audit_logs 기록
const { getAdminClient } = require('./_shared/supabase-admin');
const { signSellerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const {
  isValidBusinessNumber,
  normalizeBusinessNumber,
  maskBusinessNumber,
  isValidPhone,
  normalizePhone,
  maskPhone,
  maskEmail,
  normalizeBirthDate,
  recordAudit,
  generateReferralCode,
} = require('./_shared/onboarding-utils');

const VALID_STEPS = [1, 2, 3, 4, 5];

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청 형식입니다.' }) };
  }

  const businessNumber = normalizeBusinessNumber(body.businessNumber);
  const ownerName = (body.ownerName || '').trim();
  const phone = normalizePhone(body.phone);
  const email = (body.email || '').trim().toLowerCase() || null;
  const birthDate = normalizeBirthDate(body.birthDate) || null;
  const storeName = (body.storeName || '').trim() || null;
  const marketingConsent = body.marketingConsent === true;
  const privacyConsent = body.privacyConsent === true;
  const termsConsent = body.termsConsent === true;
  const signupStep = VALID_STEPS.includes(Number(body.signupStep)) ? Number(body.signupStep) : 5;
  const licenseFileUrl = (body.licenseFileUrl && typeof body.licenseFileUrl === 'string')
    ? body.licenseFileUrl.trim() : null;

  // 검증
  if (!isValidBusinessNumber(businessNumber)) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: '사업자등록번호 형식이 올바르지 않습니다.' }),
    };
  }
  if (!ownerName || ownerName.length < 2 || ownerName.length > 30) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '대표자명을 정확히 입력해주세요.' }) };
  }
  if (!isValidPhone(phone)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '휴대폰 번호를 정확히 입력해주세요.' }) };
  }
  if (!termsConsent || !privacyConsent) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: '이용약관 및 개인정보 처리방침에 동의해주세요.' }),
    };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    // SIGNUP_MOCK=true 면 Supabase 미설정도 graceful — JWT만 발급해서 가입 흐름 검증 가능
    const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
    if (!isSignupMock) {
      console.error('[signup-create-seller] Supabase 클라이언트 초기화 실패:', e.message);
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: '서버 설정 오류입니다. 고객센터로 문의해주세요.' }),
      };
    }
    // 모킹 모드 — 결정론적 seller_id (사업자번호 해시) + JWT 발급 후 즉시 종료
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('mock-seller-' + businessNumber).digest('hex');
    const sellerId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
    const referralCode = generateReferralCode(businessNumber);
    let token;
    try {
      token = signSellerToken({
        seller_id: sellerId,
        business_number_masked: maskBusinessNumber(businessNumber),
      });
    } catch (jwtErr) {
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: '인증 토큰 발급에 실패했습니다.' }),
      };
    }
    console.log(`[signup-create-seller] mock seller=${sellerId.slice(0, 8)} biz=${maskBusinessNumber(businessNumber)} step=${signupStep}`);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        token,
        mock: true,
        seller: {
          id: sellerId,
          ownerName,
          plan: 'trial',
          signupStep,
          signupCompleted: signupStep >= 5,
          referralCode,
        },
      }),
    };
  }

  const now = new Date().toISOString();
  const isCompleted = signupStep >= 5;

  // 기존 셀러 조회 (business_number unique)
  const { data: existing, error: selErr } = await admin
    .from('sellers')
    .select('id, signup_step, signup_completed_at, referral_code')
    .eq('business_number', businessNumber)
    .maybeSingle();
  if (selErr) {
    console.error('[signup-create-seller] select 오류:', selErr.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '가입 처리 중 오류가 발생했습니다.' }),
    };
  }

  let sellerId;
  let referralCode;
  if (existing) {
    sellerId = existing.id;
    referralCode = existing.referral_code;
    const update = {
      owner_name: ownerName,
      phone,
      email,
      birth_date: birthDate,
      store_name: storeName,
      marketing_consent: marketingConsent,
      privacy_consent_at: privacyConsent ? now : null,
      terms_consent_at: termsConsent ? now : null,
      business_verified: true,
      business_verified_at: now,
      business_verify_method: (process.env.BUSINESS_VERIFY_MOCK || 'true').toLowerCase() !== 'false' ? 'pg_toss' : 'mock',
      signup_step: Math.max(existing.signup_step || 1, signupStep),
      signup_completed_at: isCompleted ? (existing.signup_completed_at || now) : existing.signup_completed_at,
      updated_at: now,
    };
    if (licenseFileUrl) {
      update.business_license_file_url = licenseFileUrl;
      update.business_license_uploaded_at = now;
      update.business_license_review_status =
        (process.env.BUSINESS_LICENSE_AUTO_APPROVE || 'false').toLowerCase() === 'true' ? 'approved' : 'pending';
    }
    const { error: upErr } = await admin.from('sellers').update(update).eq('id', sellerId);
    if (upErr) {
      console.error('[signup-create-seller] update 오류:', upErr.message);
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: '가입 정보 갱신에 실패했습니다.' }),
      };
    }
  } else {
    referralCode = generateReferralCode(businessNumber);
    const insert = {
      business_number: businessNumber,
      owner_name: ownerName,
      phone,
      email,
      birth_date: birthDate,
      store_name: storeName,
      marketing_consent: marketingConsent,
      privacy_consent_at: privacyConsent ? now : null,
      terms_consent_at: termsConsent ? now : null,
      business_verified: true,
      business_verified_at: now,
      business_verify_method: (process.env.BUSINESS_VERIFY_MOCK || 'true').toLowerCase() !== 'false' ? 'mock' : 'pg_toss',
      signup_step: signupStep,
      signup_completed_at: isCompleted ? now : null,
      plan: 'trial',
      referral_code: referralCode,
    };
    if (licenseFileUrl) {
      insert.business_license_file_url = licenseFileUrl;
      insert.business_license_uploaded_at = now;
      insert.business_license_review_status =
        (process.env.BUSINESS_LICENSE_AUTO_APPROVE || 'false').toLowerCase() === 'true' ? 'approved' : 'pending';
    }
    const { data: inserted, error: insErr } = await admin
      .from('sellers')
      .insert(insert)
      .select('id')
      .single();
    if (insErr) {
      console.error('[signup-create-seller] insert 오류:', insErr.message);
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: '가입 처리에 실패했습니다.' }),
      };
    }
    sellerId = inserted.id;
  }

  // JWT 발급
  let token;
  try {
    token = signSellerToken({
      seller_id: sellerId,
      business_number_masked: maskBusinessNumber(businessNumber),
    });
  } catch (e) {
    console.error('[signup-create-seller] JWT 발급 실패:', e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '인증 토큰 발급에 실패했습니다. 잠시 후 다시 시도해주세요.' }),
    };
  }

  // 감사 로그 (best-effort)
  await recordAudit(admin, {
    actor_id: sellerId,
    actor_type: 'seller',
    action: isCompleted ? 'signup_complete' : 'signup_progress',
    resource_type: 'seller',
    resource_id: sellerId,
    metadata: {
      step: signupStep,
      is_new: !existing,
      has_email: Boolean(email),
      has_birth_date: Boolean(birthDate),
      has_store_name: Boolean(storeName),
      marketing_consent: marketingConsent,
    },
    event,
  });

  console.log(`[signup-create-seller] ${existing ? 'update' : 'create'} seller=${sellerId.slice(0, 8)} biz=${maskBusinessNumber(businessNumber)} phone=${maskPhone(phone)} email=${email ? maskEmail(email) : 'none'} step=${signupStep}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      token,
      seller: {
        id: sellerId,
        ownerName,
        plan: 'trial',
        signupStep,
        signupCompleted: isCompleted,
        referralCode,
      },
    }),
  };
};
