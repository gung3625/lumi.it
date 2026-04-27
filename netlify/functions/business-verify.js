// 사업자 인증 — Sprint 1
// POST /api/business-verify
// body: { businessNumber, ownerName, birthDate, phone }
// 응답: { success: true, verified: true, method: 'mock'|'pg_toss' }
//
// 정책:
// - BUSINESS_VERIFY_MOCK=true (기본) → 형식 + 체크섬만 검증, 실제 호출 없음
// - 향후 토스 PG 가맹 후 BUSINESS_VERIFY_MOCK=false로 토글 (실제 통합인증 호출)
//
// 보안:
// - 사업자번호/휴대폰/생년월일은 마스킹 후만 로그
// - 응답에 평문 PII 절대 미포함
const {
  isValidBusinessNumber,
  normalizeBusinessNumber,
  maskBusinessNumber,
  isValidPhone,
  normalizePhone,
  maskPhone,
  normalizeBirthDate,
  recordAudit,
} = require('./_shared/onboarding-utils');
const { getAdminClient } = require('./_shared/supabase-admin');
const { corsHeaders, getOrigin } = require('./_shared/auth');

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
  const birthDate = normalizeBirthDate(body.birthDate);

  // 1. 형식 검증
  if (!isValidBusinessNumber(businessNumber)) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: '사업자등록번호 형식이 올바르지 않습니다. 10자리 숫자를 확인해주세요.' }),
    };
  }
  if (!ownerName || ownerName.length < 2 || ownerName.length > 30) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: '대표자명을 정확히 입력해주세요.' }),
    };
  }
  if (phone && !isValidPhone(phone)) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: '휴대폰 번호 형식이 올바르지 않습니다.' }),
    };
  }
  if (birthDate) {
    const d = new Date(birthDate);
    if (Number.isNaN(d.getTime())) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: '생년월일 형식이 올바르지 않습니다. (예: 1990-01-15)' }),
      };
    }
  }

  const isMock = (process.env.BUSINESS_VERIFY_MOCK || 'true').toLowerCase() !== 'false';
  const method = isMock ? 'mock' : 'pg_toss';

  // 2. 실제 인증 호출 (현재는 모킹 — PG 가맹 통과 시 실연동)
  let verified = false;
  let verifyError = null;
  if (isMock) {
    // 형식 + 체크섬 통과 = 인증 성공으로 간주
    verified = true;
  } else {
    // 향후 토스 PG 통합인증 API 호출 위치 (Phase 1 출시 전 구현)
    verifyError = '실연동 모드는 PG 가맹 후 활성화됩니다.';
  }

  // 3. 감사 로그 (best-effort)
  try {
    const admin = getAdminClient();
    await recordAudit(admin, {
      actor_type: 'system',
      action: 'business_verify',
      resource_type: 'business_number',
      resource_id: maskBusinessNumber(businessNumber),
      metadata: {
        method,
        verified,
        owner_name_length: ownerName.length,
        has_phone: Boolean(phone),
        has_birth_date: Boolean(birthDate),
      },
      event,
    });
  } catch (e) {
    // Supabase 환경 미설정 등 — best-effort, 계속 진행
    console.error('[business-verify] 감사 로그 스킵:', e.message);
  }

  console.log(`[business-verify] ${method} biz=${maskBusinessNumber(businessNumber)} phone=${phone ? maskPhone(phone) : 'none'} verified=${verified}`);

  if (!verified) {
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: verifyError || '인증 서비스 연결에 실패했습니다. 잠시 후 다시 시도해주세요.' }),
    };
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      verified: true,
      method,
      // 클라이언트가 다음 단계로 전달하기 위한 정규화된 값 (PII 아닌 형식만)
      normalized: {
        businessNumberDigits: businessNumber,
      },
    }),
  };
};
