// 공통 인증·CORS 헬퍼
// - safeEqual: timingSafeEqual 래퍼 (길이 mismatch 허용, 절대 throw 안 함)
// - corsHeaders: allowlist origin echo (credentials 포함 시 wildcard 금지 대응)
// - corsPublic: 비인증 public endpoint용 wildcard 헤더
const crypto = require('crypto');

// timing-safe 문자열 비교. 길이가 다르면 false, 에러는 swallow.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ab.length === 0 || bb.length === 0) return false;
  if (ab.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch (_) {
    return false;
  }
}

// LUMI_SECRET 비교 전용 — 미설정 시 항상 false (fail-closed).
function verifyLumiSecret(provided) {
  const secret = process.env.LUMI_SECRET;
  if (!secret) return false;
  return safeEqual(provided, secret);
}

// 인증 필요한 endpoint용 origin allowlist.
const ALLOWED_ORIGINS = new Set([
  'https://lumi.it.kr',
  'https://www.lumi.it.kr',
  'http://localhost:8888',
  'http://127.0.0.1:8888',
]);

// origin을 echo. allowlist에 없으면 기본 도메인으로 대체.
function corsHeaders(origin, extra = {}) {
  const allow = (origin && ALLOWED_ORIGINS.has(origin)) ? origin : 'https://lumi.it.kr';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
    'Content-Type': 'application/json',
    ...extra,
  };
}

// event 객체에서 origin 추출 (lowercase key 폴백).
function getOrigin(event) {
  const h = event?.headers || {};
  return h.origin || h.Origin || '';
}

module.exports = { safeEqual, verifyLumiSecret, corsHeaders, getOrigin, ALLOWED_ORIGINS };
