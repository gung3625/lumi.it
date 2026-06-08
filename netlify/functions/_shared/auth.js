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
// caller가 'Bearer xxx' 형태로 보내든 raw 'xxx'로 보내든 둘 다 허용.
function verifyLumiSecret(provided) {
  const secret = process.env.LUMI_SECRET;
  if (!secret) return false;
  const cleaned = String(provided || '').replace(/^Bearer\s+/i, '');
  return safeEqual(cleaned, secret);
}

// 네이티브 cron 전용 함수의 "외부 임의 HTTP 트리거" 차단 게이트.
// Netlify 스케줄 호출은 event.httpMethod 없음 또는 body.next_run 포함 → 통과(true).
// 외부 HTTP 호출(httpMethod 있고 next_run 없음)은 LUMI_SECRET(x-lumi-secret 헤더 또는
// Authorization: Bearer) 보유 시만 통과. scheduled-trends-v2 와 동일 패턴이라 네이티브 스케줄 비파괴.
// (Netlify 스케줄러는 시크릿을 못 보내므로 next_run/no-httpMethod 를 신뢰 — 외부 스캐너의
//  맹목적 트리거는 차단되고, 정식 내부 호출은 시크릿으로 허용.)
function allowScheduledOrSecret(event) {
  if (!event || !event.httpMethod) return true;
  try { if (JSON.parse(event.body || '{}').next_run) return true; } catch (_) { /* noop */ }
  const h = event.headers || {};
  const provided = h['x-lumi-secret'] || h['X-Lumi-Secret'] || h.authorization || h.Authorization || '';
  return verifyLumiSecret(provided);
}

// 인증 필요한 endpoint용 origin allowlist.
// localhost 는 로컬 dev (netlify dev) 에서만 허용 — production runtime 에는 NETLIFY_DEV
// 환경 변수가 없으므로 자동 제외. NODE_ENV !== 'production' fallback 도 보호.
const IS_LOCAL_DEV =
  process.env.NETLIFY_DEV === 'true' || process.env.NODE_ENV !== 'production';
const ALLOWED_ORIGINS = new Set([
  'https://lumi.it.kr',
  'https://www.lumi.it.kr',
  ...(IS_LOCAL_DEV ? ['http://localhost:8888', 'http://127.0.0.1:8888'] : []),
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

module.exports = { safeEqual, verifyLumiSecret, allowScheduledOrSecret, corsHeaders, getOrigin, ALLOWED_ORIGINS };
