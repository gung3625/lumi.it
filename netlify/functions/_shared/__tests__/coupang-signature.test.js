// 쿠팡 HMAC-SHA256 한글 단위 테스트 — Sprint 1
// 외부 라이브러리 없이 node assert만 사용
// 실행: node netlify/functions/_shared/__tests__/coupang-signature.test.js
//
// 검증 케이스 (1바이트 오차도 잡아냄):
// 1. 한글 상품명 raw vs URL 인코딩 동일 서명
// 2. 한글 path raw vs URL 인코딩 동일 서명
// 3. 영어/한글 혼합 정렬 안정성
// 4. 공백 trim 차이 — 의도적으로 다른 서명 발생 검증
// 5. 쿼리 정렬 (동일 의미, 입력 순서만 다름) → 동일 서명
// 6. 한글 키 + 한글 값
// 7. UTF-8 vs Latin-1 — 명시적 utf-8 인코딩 검증
// 8. Canonical 메시지 형식 검증 (수동 계산)
// 9. 빈 query
// 10. 만 자리 datetime 형식 검증

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

const sigPath = path.join(__dirname, '..', 'coupang-signature.js');
const {
  signCoupang,
  buildDatetime,
  normalizeQueryString,
  normalizePath,
  validateCoupangCredentials,
} = require(sigPath);

const FIXED_DATE = new Date(Date.UTC(2026, 3, 27, 12, 30, 45));
const ACCESS = 'TEST_ACCESS_KEY_0123';
const SECRET = 'TEST_SECRET_KEY_0123_BUFFER_LONG';

let pass = 0;
let fail = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    pass += 1;
    results.push({ name, status: 'PASS' });
    console.log(`[PASS] ${name}`);
  } catch (e) {
    fail += 1;
    results.push({ name, status: 'FAIL', error: e.message });
    console.error(`[FAIL] ${name}: ${e.message}`);
  }
}

// =========================================================================
// 1. 한글 상품명 raw vs URL 인코딩
// =========================================================================
test('1. 한글 상품명 raw vs URL 인코딩 — 동일 서명', () => {
  const raw = signCoupang({
    method: 'GET',
    path: '/v2/products',
    query: 'name=베이직 코튼 후드 티셔츠',
    accessKey: ACCESS,
    secretKey: SECRET,
    date: FIXED_DATE,
  });
  const enc = signCoupang({
    method: 'GET',
    path: '/v2/products',
    query: 'name=' + encodeURIComponent('베이직 코튼 후드 티셔츠'),
    accessKey: ACCESS,
    secretKey: SECRET,
    date: FIXED_DATE,
  });
  assert.strictEqual(raw.signature, enc.signature, '한글 raw vs encoded 서명 불일치');
  assert.strictEqual(raw.signature.length, 64, 'sha256 hex 길이는 64');
});

// =========================================================================
// 2. 한글 path raw vs URL 인코딩
// =========================================================================
test('2. 한글 path raw vs URL 인코딩 — 동일 서명', () => {
  const raw = signCoupang({
    method: 'GET',
    path: '/v2/한글경로/상품',
    accessKey: ACCESS,
    secretKey: SECRET,
    date: FIXED_DATE,
  });
  const enc = signCoupang({
    method: 'GET',
    path: '/v2/' + encodeURIComponent('한글경로') + '/' + encodeURIComponent('상품'),
    accessKey: ACCESS,
    secretKey: SECRET,
    date: FIXED_DATE,
  });
  assert.strictEqual(raw.signature, enc.signature, 'path 한글 인코딩 차이로 서명 불일치');
});

// =========================================================================
// 3. 한글 + 영어 혼합 키 정렬 안정성
// =========================================================================
test('3. 영문/한글 혼합 키 정렬 → 동일 서명', () => {
  // 정렬: ABC < DEF < 가나다 (codepoint 기준)
  const a = signCoupang({
    method: 'GET',
    path: '/test',
    query: '가=1&zKey=2&aKey=3',
    accessKey: ACCESS, secretKey: SECRET, date: FIXED_DATE,
  });
  const b = signCoupang({
    method: 'GET',
    path: '/test',
    query: 'aKey=3&가=1&zKey=2',
    accessKey: ACCESS, secretKey: SECRET, date: FIXED_DATE,
  });
  assert.strictEqual(a.signature, b.signature, '키 입력 순서가 서명에 영향 (정렬 실패)');

  // 정규화 결과는 'aKey=3&zKey=2&가=1'
  const normalized = normalizeQueryString('가=1&zKey=2&aKey=3');
  assert.ok(normalized.startsWith('aKey=3'), 'aKey가 첫번째여야 함');
  assert.ok(normalized.endsWith('가=1'), '가 가 마지막이어야 함 (한글 codepoint > 영문)');
});

// =========================================================================
// 4. 공백 trim — '한글 ' (뒤 공백) vs '한글' 다른 서명
// =========================================================================
test('4. 1바이트 오차 검출 — 한글 1글자 다르면 다른 서명', () => {
  const a = signCoupang({
    method: 'GET',
    path: '/test',
    query: 'name=한글',
    accessKey: ACCESS, secretKey: SECRET, date: FIXED_DATE,
  });
  const b = signCoupang({
    method: 'GET',
    path: '/test',
    query: 'name=한국',  // 글 → 국 (1글자 = 3바이트 차이)
    accessKey: ACCESS, secretKey: SECRET, date: FIXED_DATE,
  });
  assert.notStrictEqual(a.signature, b.signature, '한글 1글자 차이면 서명도 달라야 함');

  // 추가: 값 내부 공백 차이 (정렬 후 보존됨)
  const c = signCoupang({
    method: 'GET',
    path: '/test',
    query: 'name=한 글&z=1',  // 공백 in middle of value (전체 trim에 안 잡힘)
    accessKey: ACCESS, secretKey: SECRET, date: FIXED_DATE,
  });
  const d = signCoupang({
    method: 'GET',
    path: '/test',
    query: 'name=한글&z=1',
    accessKey: ACCESS, secretKey: SECRET, date: FIXED_DATE,
  });
  assert.notStrictEqual(c.signature, d.signature, '값 내부 공백 1바이트 차이 검출');
});

// =========================================================================
// 5. 쿼리 정렬 — 동일 의미, 입력 순서만 다름
// =========================================================================
test('5. 쿼리 정렬 — 입력 순서 무관 동일 서명', () => {
  const a = signCoupang({
    method: 'POST', path: '/orders',
    query: 'vendorId=A00012345&maxPerPage=10&status=ACCEPT',
    accessKey: ACCESS, secretKey: SECRET, date: FIXED_DATE,
  });
  const b = signCoupang({
    method: 'POST', path: '/orders',
    query: 'status=ACCEPT&maxPerPage=10&vendorId=A00012345',
    accessKey: ACCESS, secretKey: SECRET, date: FIXED_DATE,
  });
  assert.strictEqual(a.signature, b.signature, '쿼리 정렬 후 동일 서명이어야 함');
});

// =========================================================================
// 6. 한글 키 + 한글 값 (Canonical 메시지 검증)
// =========================================================================
test('6. 한글 키+값 — 수동 HMAC 계산과 일치', () => {
  const r = signCoupang({
    method: 'GET',
    path: '/v2/카테고리',
    query: '검색어=청바지&페이지=1',
    accessKey: ACCESS, secretKey: SECRET, date: FIXED_DATE,
  });

  // 수동 계산 — 정렬 후 '검색어=청바지&페이지=1'
  const datetime = buildDatetime(FIXED_DATE);
  // 정렬: 검색어(U+AC80) < 페이지(U+D398) ? 한글 codepoint 비교
  const sorted = '검색어=청바지&페이지=1';  // 검(AC80) < 페(D398), 그대로
  const expectedMessage = `${datetime}GET/v2/카테고리${sorted}`;
  const expectedSig = crypto
    .createHmac('sha256', Buffer.from(SECRET, 'utf8'))
    .update(Buffer.from(expectedMessage, 'utf8'))
    .digest('hex');

  assert.strictEqual(r.signature, expectedSig, '수동 계산 HMAC 결과와 일치해야 함');
  assert.strictEqual(r.message, expectedMessage, 'canonical message 형식 일치');
});

// =========================================================================
// 7. UTF-8 강제 — 같은 문자열이라도 명시적 utf8 buffer 사용 검증
// =========================================================================
test('7. UTF-8 인코딩 명시 — 한글 1바이트 오차 검출', () => {
  const message = '한글';
  const utf8Hex = Buffer.from(message, 'utf8').toString('hex');
  // 한글 = E5 95 9C E5 9B BD 가 아니라 ED 95 9C EA B8 80
  assert.strictEqual(utf8Hex, 'ed959cea b880'.replace(/\s/g, ''), 'UTF-8 한글 바이트 시퀀스 검증');

  // signCoupang 내부 버퍼링 일관성
  const r = signCoupang({
    method: 'GET', path: '/' + message, accessKey: ACCESS, secretKey: SECRET, date: FIXED_DATE,
  });
  // 동일 입력에서는 항상 동일 서명 (결정성)
  const r2 = signCoupang({
    method: 'GET', path: '/' + message, accessKey: ACCESS, secretKey: SECRET, date: FIXED_DATE,
  });
  assert.strictEqual(r.signature, r2.signature, '결정적 서명');
});

// =========================================================================
// 8. Canonical 메시지 형식
// =========================================================================
test('8. Canonical 형식 — datetime+method+path+query', () => {
  const r = signCoupang({
    method: 'POST',
    path: '/v2/path',
    query: 'a=1&b=2',
    accessKey: ACCESS, secretKey: SECRET, date: FIXED_DATE,
  });
  // datetime = '260427T123045Z'
  assert.strictEqual(r.datetime, '260427T123045Z', 'datetime 형식 yyMMddTHHmmssZ');
  // 메시지 = datetime + 'POST' + '/v2/path' + 'a=1&b=2'
  assert.strictEqual(r.message, '260427T123045ZPOST/v2/patha=1&b=2', 'canonical 메시지');
  // Authorization 헤더 형식
  assert.ok(r.authorization.startsWith('CEA algorithm=HmacSHA256, '), 'CEA algorithm 헤더');
  assert.ok(r.authorization.includes(`access-key=${ACCESS}`), 'access-key 포함');
  assert.ok(r.authorization.includes(`signed-date=${r.datetime}`), 'signed-date 포함');
  assert.ok(r.authorization.includes(`signature=${r.signature}`), 'signature 포함');
});

// =========================================================================
// 9. 빈 query
// =========================================================================
test('9. 빈 query — 메시지에 query 부분 미포함', () => {
  const r1 = signCoupang({
    method: 'GET', path: '/test', accessKey: ACCESS, secretKey: SECRET, date: FIXED_DATE,
  });
  const r2 = signCoupang({
    method: 'GET', path: '/test', query: '', accessKey: ACCESS, secretKey: SECRET, date: FIXED_DATE,
  });
  const r3 = signCoupang({
    method: 'GET', path: '/test', query: '?', accessKey: ACCESS, secretKey: SECRET, date: FIXED_DATE,
  });
  assert.strictEqual(r1.signature, r2.signature);
  assert.strictEqual(r1.signature, r3.signature);
  assert.strictEqual(r1.message, '260427T123045ZGET/test', 'query 부분 빈 문자열');
});

// =========================================================================
// 10. datetime 자릿수 — 1자리수 월/일/시 zero-pad
// =========================================================================
test('10. datetime — 1자리 월/일/시 zero-pad', () => {
  const d = new Date(Date.UTC(2026, 0, 5, 3, 9, 7));  // 2026-01-05 03:09:07 UTC
  assert.strictEqual(buildDatetime(d), '260105T030907Z', 'zero-pad 검증');
});

// =========================================================================
// 11. validateCoupangCredentials
// =========================================================================
test('11. validateCoupangCredentials — 정상/이상 케이스', () => {
  const ok = validateCoupangCredentials({
    vendorId: 'A00012345',
    accessKey: '0123456789abcdef',
    secretKey: '0123456789abcdef',
  });
  assert.strictEqual(ok.valid, true);

  const badVendor = validateCoupangCredentials({
    vendorId: 'B00012345',
    accessKey: '0123456789abcdef',
    secretKey: '0123456789abcdef',
  });
  assert.strictEqual(badVendor.valid, false);

  const tooShort = validateCoupangCredentials({
    vendorId: 'A00012345',
    accessKey: 'short',
    secretKey: 'short',
  });
  assert.strictEqual(tooShort.valid, false);
  assert.strictEqual(tooShort.errors.length, 2);
});

// =========================================================================
// 12. normalizeQueryString — URL 디코딩 후 정렬
// =========================================================================
test('12. normalizeQueryString — URL 디코딩 후 정렬', () => {
  const raw = 'b=%ED%95%9C%EA%B8%80&a=1';  // %한글
  const normalized = normalizeQueryString(raw);
  assert.strictEqual(normalized, 'a=1&b=한글', 'URL 디코딩 후 정렬');
});

// =========================================================================
// 13. normalizePath — 끝 슬래시 + URL 디코딩
// =========================================================================
test('13. normalizePath — URL 디코딩', () => {
  assert.strictEqual(normalizePath('/v2/%ED%95%9C%EA%B8%80'), '/v2/한글');
  assert.strictEqual(normalizePath('v2/test'), '/v2/test', '슬래시 없으면 추가');
  assert.strictEqual(normalizePath('/test?key=val'), '/test', 'query 분리');
});

// =========================================================================
// 결과 출력
// =========================================================================
console.log(`\n=== Sprint 1 HMAC 한글 단위 테스트 ===`);
console.log(`총 ${pass + fail} 테스트 — ${pass} PASS, ${fail} FAIL`);
if (fail > 0) {
  console.log('\n실패한 테스트:');
  results.filter((r) => r.status === 'FAIL').forEach((r) => {
    console.log(`  ✗ ${r.name} — ${r.error}`);
  });
  process.exit(1);
}
console.log('\n전부 통과!');
process.exit(0);
