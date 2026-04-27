// 사업자 인증 — Sprint 1 (국세청 휴폐업 자동 검증 + 백그라운드 사진 검토)
// POST /api/business-verify
// body: { businessNumber, ownerName, businessName?, birthDate?, phone?, startDate? }
// 응답: { success: true, verified: true, method: 'nts_status_only'|'nts_public'|'mock', stateCode }
//
// 정책 (2026-04-27 변경):
// - 기본 흐름 = 사업자번호 → 국세청 /status 자동 검증만 (휴폐업 거르기)
// - 사진 검증 = /api/upload-business-license 별도 endpoint, 백그라운드 검토
// - startDate 옵션: 제공 시 /validate까지 호출(이중 검증), 없으면 status만으로 즉시 통과
// - BUSINESS_VERIFY_MOCK=true → 형식+체크섬만 검증 (개발/테스트용)
// - PUBLIC_DATA_API_KEY 미설정 시 → 503 + 관리자 안내
//
// 보안:
// - 사업자번호/휴대폰/생년월일/대표자명은 마스킹 후만 로그
// - API 키는 절대 로그·응답 노출 금지
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
const { translateBusinessVerifyError } = require('./_shared/market-errors');
const { fetchBusinessStatus, validateBusinessIdentity } = require('./_shared/nts-business-client');
const { getAdminClient } = require('./_shared/supabase-admin');
const { corsHeaders, getOrigin } = require('./_shared/auth');

/**
 * 개업일을 YYYYMMDD (NTS API 형식)로 정규화.
 * 입력 허용: 'YYYY-MM-DD', 'YYYYMMDD', 'YYYY.MM.DD'
 */
function normalizeStartDate(input) {
  if (!input || typeof input !== 'string') return '';
  const digits = input.replace(/\D/g, '');
  if (!/^\d{8}$/.test(digits)) return '';
  // 1900~현재년도+1 사이 4자리 연도만 허용 (간이 검증)
  const year = parseInt(digits.slice(0, 4), 10);
  const month = parseInt(digits.slice(4, 6), 10);
  const day = parseInt(digits.slice(6, 8), 10);
  if (year < 1900 || year > new Date().getFullYear() + 1) return '';
  if (month < 1 || month > 12) return '';
  if (day < 1 || day > 31) return '';
  return digits;
}

function jsonError(statusCode, CORS, payload) {
  return { statusCode, headers: CORS, body: JSON.stringify(payload) };
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return jsonError(405, CORS, { error: 'Method not allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return jsonError(400, CORS, { error: '잘못된 요청 형식입니다.' });
  }

  const businessNumber = normalizeBusinessNumber(body.businessNumber);
  const ownerName = (body.ownerName || '').trim();
  const businessName = (body.businessName || '').trim();
  const phone = normalizePhone(body.phone);
  const birthDate = normalizeBirthDate(body.birthDate);
  const startDate = normalizeStartDate(body.startDate);

  // 1. 형식 검증
  if (!isValidBusinessNumber(businessNumber)) {
    return jsonError(400, CORS, { error: '사업자등록번호 형식이 올바르지 않습니다. 10자리 숫자를 확인해주세요.' });
  }
  if (!ownerName || ownerName.length < 2 || ownerName.length > 30) {
    return jsonError(400, CORS, { error: '대표자명을 정확히 입력해주세요.' });
  }
  if (phone && !isValidPhone(phone)) {
    return jsonError(400, CORS, { error: '휴대폰 번호 형식이 올바르지 않습니다.' });
  }
  if (birthDate) {
    const d = new Date(birthDate);
    if (Number.isNaN(d.getTime())) {
      return jsonError(400, CORS, { error: '생년월일 형식이 올바르지 않습니다. (예: 1990-01-15)' });
    }
  }

  const isMock = (process.env.BUSINESS_VERIFY_MOCK || 'false').toLowerCase() === 'true';

  // 2. 모킹 분기 (개발용) — 형식+체크섬 통과로 간주
  if (isMock) {
    await safeAudit({
      action: 'business_verify',
      businessNumber, method: 'mock', verified: true,
      ownerName, phone, birthDate, startDate, event,
    });
    console.log(`[business-verify] mock biz=${maskBusinessNumber(businessNumber)} verified=true`);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        verified: true,
        method: 'mock',
        normalized: { businessNumberDigits: businessNumber },
      }),
    };
  }

  // 3. 실연동: PUBLIC_DATA_API_KEY 필수
  const serviceKey = process.env.PUBLIC_DATA_API_KEY;
  if (!serviceKey) {
    console.error('[business-verify] PUBLIC_DATA_API_KEY 미설정 — 관리자 확인 필요');
    return jsonError(503, CORS, { error: translateBusinessVerifyError('config_missing') });
  }

  // startDate는 옵션 (제공 시 진위 일치까지 이중 검증, 없으면 status만으로 통과)
  const hasStartDate = Boolean(startDate);

  // 4. 휴폐업 상태 조회 (네트워크 1회로 폐업·휴업 즉시 거부)
  let stateCode = null;
  try {
    const statusRes = await fetchBusinessStatus({ businessNumber, serviceKey });
    if (!statusRes.ok) {
      console.error(`[business-verify] /status http=${statusRes.httpStatus} biz=${maskBusinessNumber(businessNumber)}`);
      return jsonError(502, CORS, { error: translateBusinessVerifyError('network_error') });
    }
    stateCode = statusRes.statusCode;
    if (stateCode === '02') {
      await safeAudit({
        action: 'business_verify', businessNumber, method: 'nts_public',
        verified: false, reason: 'closed_temporary',
        ownerName, phone, birthDate, startDate, event,
      });
      return jsonError(409, CORS, { error: translateBusinessVerifyError('closed_temporary') });
    }
    if (stateCode === '03') {
      await safeAudit({
        action: 'business_verify', businessNumber, method: 'nts_public',
        verified: false, reason: 'closed_permanent',
        ownerName, phone, birthDate, startDate, event,
      });
      return jsonError(409, CORS, { error: translateBusinessVerifyError('closed_permanent') });
    }
    if (stateCode !== '01') {
      // 기타 상태 코드 (응답 자체는 정상이지만 식별 불가)
      console.error(`[business-verify] unknown stt_cd=${stateCode} biz=${maskBusinessNumber(businessNumber)}`);
      return jsonError(409, CORS, { error: translateBusinessVerifyError('unknown_state') });
    }
  } catch (e) {
    console.error('[business-verify] /status throw:', e.message);
    return jsonError(502, CORS, { error: translateBusinessVerifyError('network_error') });
  }

  // 5. 진위 확인 (b_no + p_nm + start_dt 일치 검증) — startDate 제공된 경우만
  if (hasStartDate) {
    let validCode = null;
    try {
      const validateRes = await validateBusinessIdentity({
        businessNumber, ownerName, startDate,
        businessName: businessName || undefined,
        serviceKey,
      });
      if (!validateRes.ok) {
        console.error(`[business-verify] /validate http=${validateRes.httpStatus} biz=${maskBusinessNumber(businessNumber)}`);
        return jsonError(502, CORS, { error: translateBusinessVerifyError('network_error') });
      }
      validCode = validateRes.valid;
      if (validCode !== '01') {
        // 진위 불일치
        await safeAudit({
          action: 'business_verify', businessNumber, method: 'nts_public',
          verified: false, reason: 'mismatch',
          ownerName, phone, birthDate, startDate, event,
        });
        return jsonError(409, CORS, { error: translateBusinessVerifyError('mismatch') });
      }
    } catch (e) {
      console.error('[business-verify] /validate throw:', e.message);
      return jsonError(502, CORS, { error: translateBusinessVerifyError('network_error') });
    }
  }

  // 6. 모두 통과 — method는 startDate 제공 여부에 따라 분기
  const method = hasStartDate ? 'nts_public' : 'nts_status_only';
  await safeAudit({
    action: 'business_verify', businessNumber, method,
    verified: true, ownerName, phone, birthDate, startDate, event,
  });
  console.log(`[business-verify] ${method} biz=${maskBusinessNumber(businessNumber)} phone=${phone ? maskPhone(phone) : 'none'} verified=true stateCode=${stateCode}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      verified: true,
      method,
      stateCode,
      normalized: { businessNumberDigits: businessNumber },
    }),
  };
};

/**
 * 감사 로그 기록 — best-effort, throw 안 함
 */
async function safeAudit({ action, businessNumber, method, verified, reason, ownerName, phone, birthDate, startDate, event }) {
  try {
    const admin = getAdminClient();
    await recordAudit(admin, {
      actor_type: 'system',
      action,
      resource_type: 'business_number',
      resource_id: maskBusinessNumber(businessNumber),
      metadata: {
        method,
        verified,
        reason: reason || null,
        owner_name_length: ownerName ? ownerName.length : 0,
        has_phone: Boolean(phone),
        has_birth_date: Boolean(birthDate),
        has_start_date: Boolean(startDate),
      },
      event,
    });
  } catch (e) {
    console.error('[business-verify] 감사 로그 스킵:', e.message);
  }
}

// 테스트용 export
exports.normalizeStartDate = normalizeStartDate;
