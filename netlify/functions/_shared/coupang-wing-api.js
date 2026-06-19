'use strict';
// 쿠팡 WING OPEN API — HMAC 인증 + 호출 헬퍼.
// 공식: developers.coupangcorp.com (HMAC Signature). message=datetime+method+path+query, HMAC-SHA256 hex,
//   Authorization: "CEA algorithm=HmacSHA256, access-key=.., signed-date=.., signature=..", base=api-gateway.coupang.com
// env: COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY, COUPANG_VENDOR_ID. 호출 IP는 WING에 등록된 IP여야 함(GCP 34.158.206.244).
const crypto = require('crypto');
const HOST = 'https://api-gateway.coupang.com';

// datetime = yyMMdd'T'HHmmss'Z' (UTC). 예: 260619T033816Z
function signedDate() {
  return new Date().toISOString().split('.')[0].replace(/[-:]/g, '').slice(2) + 'Z';
}
function authHeader(method, path, query) {
  const ACCESS = process.env.COUPANG_ACCESS_KEY, SECRET = process.env.COUPANG_SECRET_KEY;
  if (!ACCESS || !SECRET) return null;
  const datetime = signedDate();
  const message = datetime + method + path + (query || '');
  const signature = crypto.createHmac('sha256', SECRET).update(message).digest('hex');
  return 'CEA algorithm=HmacSHA256, access-key=' + ACCESS + ', signed-date=' + datetime + ', signature=' + signature;
}

// 쿼리는 서명 메시지와 URL이 100% 동일해야 함 → 호출부에서 만든 query 문자열을 그대로 전달.
async function coupangCall(method, path, query, jsonBody) {
  const auth = authHeader(method, path, query || '');
  if (!auth) return { ok: false, status: 0, error: 'COUPANG_ACCESS_KEY/SECRET_KEY 미설정' };
  const url = HOST + path + (query ? '?' + query : '');
  const opts = {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json;charset=UTF-8', 'X-EXTENDED-TIMEOUT': '90000' },
    signal: AbortSignal.timeout(20000),
  };
  if (jsonBody != null) opts.body = JSON.stringify(jsonBody);
  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch (_) { body = text; }
    return { ok: res.ok, status: res.status, body };
  } catch (e) { return { ok: false, status: 0, error: e && e.message ? e.message : String(e) }; }
}

const coupangGet = (path, query) => coupangCall('GET', path, query);
const VENDOR = () => process.env.COUPANG_VENDOR_ID || '';

module.exports = { authHeader, coupangCall, coupangGet, VENDOR, HOST };
