// 쿠팡 Wing OPEN API HMAC-SHA256 서명 헬퍼
// 공식 스펙: https://developers.coupangcorp.com (Open API Authentication)
//
// 서명 규칙:
// 1. datetime = UTC 'yyMMddTHHmmssZ' 형식 (예: '230101T120000Z')
// 2. message = datetime + method + path + queryString
//    - method: 'GET' / 'POST' 등 (대문자)
//    - path: URL 디코딩된 경로 (예: '/v2/providers/.../categorization/predictions')
//    - queryString: 알파벳 정렬된 'key=value&key2=value2' (URL 인코딩 X)
// 3. signature = HMAC-SHA256(secretKey, message) → hex
// 4. Authorization 헤더:
//    'CEA algorithm=HmacSHA256, access-key=<accessKey>, signed-date=<datetime>, signature=<signature>'
//
// 한글 처리:
// - path와 queryString은 UTF-8 바이트 그대로 사용 (URL 인코딩 후 사용 X)
// - HMAC 입력은 UTF-8 바이트 시퀀스 (Buffer.from(message, 'utf8'))

const crypto = require('crypto');

/**
 * UTC 'yyMMddTHHmmssZ' datetime 생성
 */
function buildDatetime(date = new Date()) {
  const yy = String(date.getUTCFullYear()).slice(2).padStart(2, '0');
  const MM = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const HH = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${yy}${MM}${dd}T${HH}${mm}${ss}Z`;
}

/**
 * 쿼리스트링 정규화 — 알파벳 정렬, URL 디코딩 (인코딩 X)
 * @param {string} rawQuery 'a=1&b=한글' 또는 'a=1&b=%ED%95%9C%EA%B8%80'
 * @returns {string} 정렬된 'a=1&b=한글'
 */
function normalizeQueryString(rawQuery) {
  if (!rawQuery) return '';
  const trimmed = String(rawQuery).replace(/^\?/, '').trim();
  if (!trimmed) return '';
  const pairs = trimmed.split('&').map((kv) => {
    const eq = kv.indexOf('=');
    if (eq === -1) return [decodeURIComponent(kv), ''];
    const key = decodeURIComponent(kv.slice(0, eq));
    const value = decodeURIComponent(kv.slice(eq + 1));
    return [key, value];
  });
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * Path 정규화 — URL 디코딩 + 끝 슬래시 제거
 */
function normalizePath(path) {
  if (!path) return '/';
  let p = String(path).trim();
  // 경로에 '?'가 들어있으면 분리
  const qIdx = p.indexOf('?');
  if (qIdx !== -1) p = p.slice(0, qIdx);
  // URL 디코딩
  try { p = decodeURIComponent(p); } catch (_) { /* 디코딩 실패 시 원본 유지 */ }
  if (!p.startsWith('/')) p = '/' + p;
  return p;
}

/**
 * 쿠팡 HMAC-SHA256 서명 생성
 * @param {object} params
 * @param {string} params.method - HTTP 메서드 (GET, POST 등)
 * @param {string} params.path - 경로 (예: '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products')
 * @param {string} [params.query] - 쿼리스트링 (정렬되지 않은 raw)
 * @param {string} params.accessKey
 * @param {string} params.secretKey
 * @param {Date} [params.date]
 * @returns {{ authorization: string, datetime: string, signature: string, message: string }}
 */
function signCoupang({ method, path, query = '', accessKey, secretKey, date }) {
  if (!method || !path || !accessKey || !secretKey) {
    throw new Error('signCoupang: method/path/accessKey/secretKey 필수');
  }
  const datetime = buildDatetime(date);
  const normalizedPath = normalizePath(path);
  const normalizedQuery = normalizeQueryString(query);
  const message = `${datetime}${method.toUpperCase()}${normalizedPath}${normalizedQuery}`;

  const signature = crypto
    .createHmac('sha256', Buffer.from(secretKey, 'utf8'))
    .update(Buffer.from(message, 'utf8'))
    .digest('hex');

  const authorization = `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`;
  return { authorization, datetime, signature, message };
}

/**
 * 형식 검증 — Vendor ID/Access Key/Secret Key 입력값 사전 체크
 */
function validateCoupangCredentials({ vendorId, accessKey, secretKey }) {
  const errors = [];
  if (!vendorId || !/^A\d{8,12}$/.test(String(vendorId).trim())) {
    errors.push('Vendor ID 형식이 올바르지 않습니다. (A로 시작하는 9~13자리)');
  }
  if (!accessKey || String(accessKey).length < 16) {
    errors.push('Access Key 형식이 올바르지 않습니다.');
  }
  if (!secretKey || String(secretKey).length < 16) {
    errors.push('Secret Key 형식이 올바르지 않습니다.');
  }
  return { valid: errors.length === 0, errors };
}

// =========================================================================
// 셀프 단위 테스트 — 한글 인코딩 + 정렬 케이스
// 사용: node -e "require('./_shared/coupang-signature').runTests()"
// =========================================================================
function runTests() {
  const results = [];

  // Test 1: 기본 서명 결정성
  const r1 = signCoupang({
    method: 'GET',
    path: '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products',
    query: 'vendorId=A00012345&maxPerPage=10',
    accessKey: 'TESTACCESS',
    secretKey: 'TESTSECRET',
    date: new Date(Date.UTC(2026, 3, 27, 12, 0, 0)),
  });
  results.push({
    name: 'basic-determinism',
    pass: r1.signature.length === 64 && r1.datetime === '260427T120000Z',
    detail: `signature=${r1.signature.slice(0, 12)}... datetime=${r1.datetime}`,
  });

  // Test 2: 쿼리스트링 정렬 (입력 순서 무관)
  const a = signCoupang({
    method: 'GET', path: '/test', query: 'b=2&a=1', accessKey: 'k', secretKey: 's',
    date: new Date(Date.UTC(2026, 3, 27, 12, 0, 0)),
  });
  const b = signCoupang({
    method: 'GET', path: '/test', query: 'a=1&b=2', accessKey: 'k', secretKey: 's',
    date: new Date(Date.UTC(2026, 3, 27, 12, 0, 0)),
  });
  results.push({
    name: 'query-sort-stable',
    pass: a.signature === b.signature,
    detail: `${a.signature === b.signature ? 'OK' : 'MISMATCH'}`,
  });

  // Test 3: 한글 상품명 (URL 인코딩된 입력 vs raw 한글 입력 동일성)
  const ko1 = signCoupang({
    method: 'GET', path: '/products', query: 'name=베이직 코튼 후드 티셔츠',
    accessKey: 'k', secretKey: 's',
    date: new Date(Date.UTC(2026, 3, 27, 12, 0, 0)),
  });
  const ko2 = signCoupang({
    method: 'GET', path: '/products',
    query: 'name=' + encodeURIComponent('베이직 코튼 후드 티셔츠'),
    accessKey: 'k', secretKey: 's',
    date: new Date(Date.UTC(2026, 3, 27, 12, 0, 0)),
  });
  results.push({
    name: 'korean-utf8-roundtrip',
    pass: ko1.signature === ko2.signature,
    detail: `${ko1.signature === ko2.signature ? 'OK' : 'MISMATCH'} sig=${ko1.signature.slice(0, 12)}...`,
  });

  // Test 4: Path URL 인코딩 디코딩
  const pathRaw = signCoupang({
    method: 'GET', path: '/v2/providers/한글경로',
    accessKey: 'k', secretKey: 's',
    date: new Date(Date.UTC(2026, 3, 27, 12, 0, 0)),
  });
  const pathEnc = signCoupang({
    method: 'GET', path: '/v2/providers/' + encodeURIComponent('한글경로'),
    accessKey: 'k', secretKey: 's',
    date: new Date(Date.UTC(2026, 3, 27, 12, 0, 0)),
  });
  results.push({
    name: 'path-utf8-roundtrip',
    pass: pathRaw.signature === pathEnc.signature,
    detail: `${pathRaw.signature === pathEnc.signature ? 'OK' : 'MISMATCH'}`,
  });

  // Test 5: validateCoupangCredentials
  const v1 = validateCoupangCredentials({ vendorId: 'A00012345', accessKey: '0123456789abcdef', secretKey: '0123456789abcdef' });
  const v2 = validateCoupangCredentials({ vendorId: 'BAD', accessKey: 'short', secretKey: 'short' });
  results.push({
    name: 'validate-credentials',
    pass: v1.valid === true && v2.valid === false,
    detail: `valid=${v1.valid} invalid=${v2.valid} errors=${v2.errors.length}`,
  });

  const allPass = results.every((r) => r.pass);
  for (const r of results) {
    console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}: ${r.detail}`);
  }
  console.log(`\n총 ${results.length} 테스트 — ${allPass ? '전부 통과' : '일부 실패'}`);
  return { allPass, results };
}

module.exports = {
  signCoupang,
  buildDatetime,
  normalizeQueryString,
  normalizePath,
  validateCoupangCredentials,
  runTests,
};

if (require.main === module) {
  runTests();
}
