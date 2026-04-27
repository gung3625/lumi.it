// 사업자등록증 업로드 단위 테스트 — Sprint 1
// 외부 라이브러리 없이 node assert만 사용
// 실행: node netlify/functions/_shared/__tests__/upload-business-license.test.js
//
// 검증 케이스:
//  1. detectExtension — 확장자 정상 추출
//  2. detectExtension — 확장자 없음 → MIME 폴백
//  3. detectExtension — 허용되지 않은 확장자 → 빈 문자열
//  4. validateMagicBytes — JPEG 매직 바이트 통과
//  5. validateMagicBytes — PNG 매직 바이트 통과
//  6. validateMagicBytes — PDF 매직 바이트 통과
//  7. validateMagicBytes — 매직 바이트 불일치 → false
//  8. handler — 인증 토큰 없음 → 401
//  9. handler — OPTIONS preflight → 204
// 10. handler — GET → 405
// 11. handler — multipart 아님 → 400
// 12. handler — 파일 크기 초과 (10MB+) → 413
// 13. handler — 빈 multipart → 400
// 14. handler — 정상 JPEG 업로드 → 200 + fileUrl + verifyStatus
// 15. handler — 정상 PDF 업로드 → 200 + fileUrl
// 16. handler — 미허용 확장자 (.exe) → 415

const assert = require('assert');
const path = require('path');

const handlerPath = path.join(__dirname, '..', '..', 'upload-business-license.js');
const jwtPath = path.join(__dirname, '..', 'seller-jwt.js');

function loadHandler() {
  delete require.cache[handlerPath];
  return require(handlerPath);
}

function loadJwt() {
  delete require.cache[jwtPath];
  return require(jwtPath);
}

let pass = 0;
let fail = 0;
const results = [];

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { pass += 1; results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); })
    .catch((e) => { fail += 1; results.push({ name, status: 'FAIL', error: e.message }); console.error(`[FAIL] ${name}: ${e.message}`); });
}

// JPEG 매직 바이트 + 1KB 더미 페이로드
function makeJpegBuffer() {
  const head = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const tail = Buffer.alloc(1024, 0x00);
  return Buffer.concat([head, tail]);
}

function makePngBuffer() {
  const head = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
  const tail = Buffer.alloc(512, 0x00);
  return Buffer.concat([head, tail]);
}

function makePdfBuffer() {
  const head = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary');
  const tail = Buffer.alloc(256, 0x00);
  return Buffer.concat([head, tail]);
}

function makeFakeBuffer(size) {
  return Buffer.alloc(size, 0x41); // 'A' 반복
}

// multipart/form-data 바디 빌더 (boundary + file part)
function buildMultipart(filename, mimeType, fileBuffer, extraFields = {}) {
  const boundary = '----LumiTestBoundary' + Math.random().toString(16).slice(2);
  const CRLF = '\r\n';
  const parts = [];

  Object.entries(extraFields).forEach(([key, value]) => {
    parts.push(Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="${key}"${CRLF}${CRLF}` +
      `${value}${CRLF}`
    , 'utf8'));
  });

  parts.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
    `Content-Type: ${mimeType}${CRLF}${CRLF}`
  , 'utf8'));
  parts.push(fileBuffer);
  parts.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8'));

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function makeEvent(method, body, headers, isBase64Encoded) {
  return {
    httpMethod: method,
    headers: Object.assign({ origin: 'http://localhost' }, headers || {}),
    queryStringParameters: {},
    path: '/api/upload-business-license',
    body,
    isBase64Encoded: Boolean(isBase64Encoded),
  };
}

function makeMultipartEvent(method, headers, multipart) {
  const headersAll = Object.assign(
    { 'content-type': multipart.contentType, origin: 'http://localhost' },
    headers || {}
  );
  return makeEvent(method, multipart.body.toString('base64'), headersAll, true);
}

// SIGNUP_MOCK=true 환경 (Supabase 미설정 graceful)
function setupMockEnv() {
  process.env.SIGNUP_MOCK = 'true';
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    process.env.JWT_SECRET = 'test-jwt-secret-32-chars-minimum-please-1234567890';
  }
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
}

(async function run() {
  setupMockEnv();

  // 1. detectExtension — 확장자 정상 추출
  await test('1. detectExtension — 확장자 정상 추출', () => {
    const { _internals } = loadHandler();
    assert.strictEqual(_internals.detectExtension('license.jpg', 'image/jpeg'), 'jpg');
    assert.strictEqual(_internals.detectExtension('license.PNG', 'image/png'), 'png');
    assert.strictEqual(_internals.detectExtension('license.pdf', 'application/pdf'), 'pdf');
  });

  // 2. detectExtension — MIME 폴백
  await test('2. detectExtension — 확장자 없음 → MIME 폴백', () => {
    const { _internals } = loadHandler();
    assert.strictEqual(_internals.detectExtension('license', 'image/jpeg'), 'jpg');
    assert.strictEqual(_internals.detectExtension('license', 'application/pdf'), 'pdf');
    assert.strictEqual(_internals.detectExtension('', 'image/png'), 'png');
  });

  // 3. detectExtension — 미허용
  await test('3. detectExtension — 미허용 확장자 → 빈 문자열', () => {
    const { _internals } = loadHandler();
    assert.strictEqual(_internals.detectExtension('virus.exe', 'application/octet-stream'), '');
    assert.strictEqual(_internals.detectExtension('script.js', 'application/javascript'), '');
  });

  // 4. validateMagicBytes — JPEG
  await test('4. validateMagicBytes — JPEG 매직 바이트 통과', () => {
    const { _internals } = loadHandler();
    assert.strictEqual(_internals.validateMagicBytes(makeJpegBuffer(), 'jpg'), true);
    assert.strictEqual(_internals.validateMagicBytes(makeJpegBuffer(), 'jpeg'), true);
  });

  // 5. validateMagicBytes — PNG
  await test('5. validateMagicBytes — PNG 매직 바이트 통과', () => {
    const { _internals } = loadHandler();
    assert.strictEqual(_internals.validateMagicBytes(makePngBuffer(), 'png'), true);
  });

  // 6. validateMagicBytes — PDF
  await test('6. validateMagicBytes — PDF 매직 바이트 통과', () => {
    const { _internals } = loadHandler();
    assert.strictEqual(_internals.validateMagicBytes(makePdfBuffer(), 'pdf'), true);
  });

  // 7. validateMagicBytes — 불일치
  await test('7. validateMagicBytes — 매직 바이트 불일치 → false', () => {
    const { _internals } = loadHandler();
    assert.strictEqual(_internals.validateMagicBytes(makeJpegBuffer(), 'png'), false);
    assert.strictEqual(_internals.validateMagicBytes(makePngBuffer(), 'pdf'), false);
    assert.strictEqual(_internals.validateMagicBytes(Buffer.alloc(20, 0x00), 'jpg'), false);
  });

  // 8. 인증 토큰 없음
  await test('8. handler — 인증 토큰 없음 → 401', async () => {
    const { handler } = loadHandler();
    const mp = buildMultipart('license.jpg', 'image/jpeg', makeJpegBuffer());
    const res = await handler(makeMultipartEvent('POST', {}, mp));
    assert.strictEqual(res.statusCode, 401);
  });

  // 9. OPTIONS
  await test('9. handler — OPTIONS preflight → 204', async () => {
    const { handler } = loadHandler();
    const res = await handler(makeEvent('OPTIONS', '', {}));
    assert.strictEqual(res.statusCode, 204);
  });

  // 10. GET → 405
  await test('10. handler — GET → 405', async () => {
    const { handler } = loadHandler();
    const res = await handler(makeEvent('GET', '', {}));
    assert.strictEqual(res.statusCode, 405);
  });

  // 11. multipart 아님 → 400
  await test('11. handler — multipart 아님 → 400', async () => {
    const { handler } = loadHandler();
    const { signSellerToken } = loadJwt();
    const token = signSellerToken({ seller_id: '11111111-1111-1111-1111-111111111111' });
    const res = await handler(makeEvent('POST', '{"foo":"bar"}', {
      'content-type': 'application/json',
      authorization: 'Bearer ' + token,
    }));
    assert.strictEqual(res.statusCode, 400);
  });

  // 12. 파일 크기 초과
  await test('12. handler — 파일 크기 초과 (10MB+) → 413', async () => {
    const { handler } = loadHandler();
    const { signSellerToken } = loadJwt();
    const token = signSellerToken({ seller_id: '22222222-2222-2222-2222-222222222222' });
    const oversize = Buffer.concat([makeJpegBuffer(), makeFakeBuffer(11 * 1024 * 1024)]);
    const mp = buildMultipart('big.jpg', 'image/jpeg', oversize);
    const res = await handler(makeMultipartEvent('POST', {
      authorization: 'Bearer ' + token,
    }, mp));
    assert.strictEqual(res.statusCode, 413);
  });

  // 13. 빈 multipart
  await test('13. handler — 빈 multipart → 400', async () => {
    const { handler } = loadHandler();
    const { signSellerToken } = loadJwt();
    const token = signSellerToken({ seller_id: '33333333-3333-3333-3333-333333333333' });
    const mp = buildMultipart('empty.jpg', 'image/jpeg', Buffer.alloc(0));
    const res = await handler(makeMultipartEvent('POST', {
      authorization: 'Bearer ' + token,
    }, mp));
    assert.strictEqual(res.statusCode, 400);
  });

  // 14. 정상 JPEG 업로드 → 200
  await test('14. handler — 정상 JPEG 업로드 → 200 + fileUrl + verifyStatus', async () => {
    const { handler } = loadHandler();
    const { signSellerToken } = loadJwt();
    const token = signSellerToken({ seller_id: '44444444-4444-4444-4444-444444444444' });
    const mp = buildMultipart('biz-license.jpg', 'image/jpeg', makeJpegBuffer());
    const res = await handler(makeMultipartEvent('POST', {
      authorization: 'Bearer ' + token,
    }, mp));
    assert.strictEqual(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.success, true);
    assert.ok(json.fileUrl, 'fileUrl 응답 누락');
    assert.ok(['pending', 'approved'].includes(json.verifyStatus), `verifyStatus=${json.verifyStatus}`);
    assert.ok(json.sizeBytes > 0);
  });

  // 15. 정상 PDF 업로드
  await test('15. handler — 정상 PDF 업로드 → 200 + fileUrl', async () => {
    const { handler } = loadHandler();
    const { signSellerToken } = loadJwt();
    const token = signSellerToken({ seller_id: '55555555-5555-5555-5555-555555555555' });
    const mp = buildMultipart('biz-license.pdf', 'application/pdf', makePdfBuffer());
    const res = await handler(makeMultipartEvent('POST', {
      authorization: 'Bearer ' + token,
    }, mp));
    assert.strictEqual(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.success, true);
    assert.ok(json.fileUrl);
  });

  // 16. 미허용 확장자
  await test('16. handler — 미허용 확장자 (.exe) → 415', async () => {
    const { handler } = loadHandler();
    const { signSellerToken } = loadJwt();
    const token = signSellerToken({ seller_id: '66666666-6666-6666-6666-666666666666' });
    const mp = buildMultipart('virus.exe', 'application/octet-stream', Buffer.alloc(100, 0x00));
    const res = await handler(makeMultipartEvent('POST', {
      authorization: 'Bearer ' + token,
    }, mp));
    assert.strictEqual(res.statusCode, 415);
  });

  // 결과
  console.log(`\n=== upload-business-license 단위 테스트 ===`);
  console.log(`총 ${pass + fail} 테스트 — ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) {
    console.log('\n실패한 테스트:');
    results.filter((r) => r.status === 'FAIL').forEach((r) => {
      console.log(`  ${r.name} — ${r.error}`);
    });
    process.exit(1);
  }
  console.log('\n전부 통과!');
  process.exit(0);
})();
