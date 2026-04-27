// Sprint 1 가입 플로우 공용 헬퍼
// - 사업자번호 정규화/검증 (체크섬 포함)
// - 휴대폰/사업자번호/이메일 마스킹 (로그 표시용)
// - IP/UA 추출 (감사 로그용)
// - 감사 로그 기록 헬퍼

/**
 * 사업자번호를 숫자 10자리로 정규화 (하이픈 제거)
 * @param {string} input
 * @returns {string} '1234567890' 또는 빈 문자열
 */
function normalizeBusinessNumber(input) {
  if (!input || typeof input !== 'string') return '';
  return input.replace(/\D/g, '');
}

/**
 * 사업자번호 형식 + 체크섬 검증 (국세청 표준)
 * @param {string} input
 * @returns {boolean}
 */
function isValidBusinessNumber(input) {
  const num = normalizeBusinessNumber(input);
  if (!/^\d{10}$/.test(num)) return false;
  const weights = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    sum += parseInt(num[i], 10) * weights[i];
  }
  sum += Math.floor((parseInt(num[8], 10) * 5) / 10);
  const check = (10 - (sum % 10)) % 10;
  return check === parseInt(num[9], 10);
}

/**
 * 사업자번호 표시용 포맷 'xxx-xx-xxxxx'
 */
function formatBusinessNumber(input) {
  const num = normalizeBusinessNumber(input);
  if (num.length !== 10) return input;
  return `${num.slice(0, 3)}-${num.slice(3, 5)}-${num.slice(5)}`;
}

/**
 * 사업자번호 마스킹 (로그용) — 'xxx-xx-***90'
 */
function maskBusinessNumber(input) {
  const num = normalizeBusinessNumber(input);
  if (num.length !== 10) return '***';
  return `${num.slice(0, 3)}-${num.slice(3, 5)}-***${num.slice(8)}`;
}

/**
 * 휴대폰 번호 정규화 (숫자만)
 */
function normalizePhone(input) {
  if (!input || typeof input !== 'string') return '';
  return input.replace(/\D/g, '');
}

/**
 * 휴대폰 형식 검증 (01[016789]xxxxxxxx)
 */
function isValidPhone(input) {
  const num = normalizePhone(input);
  return /^01[016789]\d{7,8}$/.test(num);
}

/**
 * 휴대폰 번호 마스킹 — '010-***-1234'
 */
function maskPhone(input) {
  const num = normalizePhone(input);
  if (num.length < 9) return '***';
  return `${num.slice(0, 3)}-***-${num.slice(-4)}`;
}

/**
 * 이메일 마스킹 — 'k***@example.com'
 */
function maskEmail(input) {
  if (!input || typeof input !== 'string') return '';
  const [local, domain] = input.split('@');
  if (!domain) return '***';
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}

/**
 * 생년월일 정규화 (YYYY-MM-DD 또는 YYYYMMDD → YYYY-MM-DD)
 */
function normalizeBirthDate(input) {
  if (!input || typeof input !== 'string') return '';
  const trimmed = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  if (/^\d{8}$/.test(trimmed)) {
    return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6)}`;
  }
  return '';
}

function getClientIp(event) {
  const h = event.headers || {};
  return h['x-nf-client-connection-ip']
    || h['client-ip']
    || (h['x-forwarded-for'] || '').split(',')[0].trim()
    || null;
}

function getUserAgent(event) {
  const h = event.headers || {};
  return h['user-agent'] || h['User-Agent'] || null;
}

/**
 * 감사 로그 기록 — 실패해도 throw 안 함 (best-effort)
 */
async function recordAudit(admin, params) {
  const { actor_id, actor_type, action, resource_type, resource_id, metadata, event } = params;
  try {
    await admin.from('audit_logs').insert({
      actor_id: actor_id || null,
      actor_type: actor_type || 'system',
      action,
      resource_type: resource_type || null,
      resource_id: resource_id || null,
      metadata: metadata || null,
      ip_address: event ? getClientIp(event) : null,
      user_agent: event ? getUserAgent(event) : null,
    });
  } catch (e) {
    console.error(`[audit] 기록 실패 action=${action}:`, e.message);
  }
}

/**
 * referral_code 6자리 영숫자 (사업자번호 해시 기반 결정론적)
 */
function generateReferralCode(seed) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(String(seed) + Date.now()).digest('hex');
  // base36 6자리 (대문자)
  return hash.slice(0, 8).toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 6);
}

module.exports = {
  normalizeBusinessNumber,
  isValidBusinessNumber,
  formatBusinessNumber,
  maskBusinessNumber,
  normalizePhone,
  isValidPhone,
  maskPhone,
  maskEmail,
  normalizeBirthDate,
  getClientIp,
  getUserAgent,
  recordAudit,
  generateReferralCode,
};
