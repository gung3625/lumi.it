// 사업자 진위확인 단위 테스트 — Sprint 1
// 외부 라이브러리 없이 node assert만 사용
// 실행: node netlify/functions/_shared/__tests__/business-verify.test.js
//
// 검증 케이스:
//  1. normalizeStartDate — YYYY-MM-DD → YYYYMMDD
//  2. normalizeStartDate — 잘못된 형식 → 빈 문자열
//  3. translateBusinessVerifyError — 모든 키 매핑
//  4. NTS 클라이언트 — 정상 진위 일치 응답 (fetcher mock)
//  5. NTS 클라이언트 — 진위 불일치 (valid='02')
//  6. NTS 클라이언트 — 휴업 (b_stt_cd='02')
//  7. NTS 클라이언트 — 폐업 (b_stt_cd='03')
//  8. business-verify handler — API 키 없음 → 503
//  9. business-verify handler — startDate 없음 → 400
// 10. business-verify handler — 휴업 → 409 + closed_temporary 카드
// 11. business-verify handler — 폐업 → 409 + closed_permanent 카드
// 12. business-verify handler — 진위 불일치 → 409 + mismatch 카드
// 13. business-verify handler — 모두 통과 → 200 + verified=true
// 14. business-verify handler — 네트워크 실패 → 502 + autoRetry 카드
// 15. business-verify handler — MOCK 모드 → 200 + method='mock'

const assert = require('assert');
const path = require('path');

const errorsPath = path.join(__dirname, '..', 'market-errors.js');
const ntsPath = path.join(__dirname, '..', 'nts-business-client.js');
const handlerPath = path.join(__dirname, '..', '..', 'business-verify.js');

const { translateBusinessVerifyError } = require(errorsPath);
const { fetchBusinessStatus, validateBusinessIdentity } = require(ntsPath);

// handler는 require cache 비워서 로드 (env 변경 반영)
function loadHandler() {
  delete require.cache[handlerPath];
  return require(handlerPath);
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

function makeFetcher(responses) {
  // responses: { status: <res>, validate: <res> }
  let statusCalls = 0;
  let validateCalls = 0;
  return {
    postJson: async (url) => {
      if (url.includes('/status')) { statusCalls += 1; return responses.status; }
      if (url.includes('/validate')) { validateCalls += 1; return responses.validate; }
      throw new Error('unexpected url: ' + url);
    },
    statusCalls: () => statusCalls,
    validateCalls: () => validateCalls,
  };
}

function makeEvent(body) {
  return {
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    body: JSON.stringify(body || {}),
  };
}

(async function run() {
  // =========================================================================
  // 1. normalizeStartDate
  // =========================================================================
  await test('1. normalizeStartDate — YYYY-MM-DD → YYYYMMDD', () => {
    const { normalizeStartDate } = loadHandler();
    assert.strictEqual(normalizeStartDate('2024-01-15'), '20240115');
    assert.strictEqual(normalizeStartDate('20240115'), '20240115');
    assert.strictEqual(normalizeStartDate('2024.01.15'), '20240115');
  });

  // =========================================================================
  // 2. normalizeStartDate 거부 케이스
  // =========================================================================
  await test('2. normalizeStartDate — 잘못된 형식 → 빈 문자열', () => {
    const { normalizeStartDate } = loadHandler();
    assert.strictEqual(normalizeStartDate(''), '');
    assert.strictEqual(normalizeStartDate('abc'), '');
    assert.strictEqual(normalizeStartDate('2024-13-15'), '');  // 13월
    assert.strictEqual(normalizeStartDate('2024-01-32'), '');  // 32일
    assert.strictEqual(normalizeStartDate('1899-01-15'), '');  // 1899년
  });

  // =========================================================================
  // 3. translateBusinessVerifyError 매핑 검증
  // =========================================================================
  await test('3. translateBusinessVerifyError — 모든 키 매핑', () => {
    const m = translateBusinessVerifyError('mismatch');
    assert.strictEqual(m.statusCode, 409);
    assert.ok(m.title && m.cause && m.action);
    assert.strictEqual(m.deepLink, 'business.identity_check');

    const c1 = translateBusinessVerifyError('closed_temporary');
    assert.ok(/휴업/.test(c1.title));
    assert.strictEqual(c1.statusCode, 409);

    const c2 = translateBusinessVerifyError('closed_permanent');
    assert.ok(/폐업/.test(c2.title));
    assert.strictEqual(c2.statusCode, 409);

    const n = translateBusinessVerifyError('network_error');
    assert.strictEqual(n.statusCode, 502);
    assert.strictEqual(n.autoRetry, true);

    const cfg = translateBusinessVerifyError('config_missing');
    assert.strictEqual(cfg.statusCode, 503);
  });

  // =========================================================================
  // 4. NTS client — 정상 응답
  // =========================================================================
  await test('4. NTS 클라이언트 — 정상 진위 일치 응답 (fetcher mock)', async () => {
    const fetcher = makeFetcher({
      status: { status: 200, json: { data: [{ b_no: '4040966416', b_stt_cd: '01', b_stt: '계속사업자' }] } },
      validate: { status: 200, json: { data: [{ b_no: '4040966416', valid: '01' }] } },
    });
    const s = await fetchBusinessStatus({ businessNumber: '4040966416', serviceKey: 'KEY', fetcher });
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.statusCode, '01');

    const v = await validateBusinessIdentity({
      businessNumber: '4040966416', ownerName: '김현', startDate: '20240101',
      serviceKey: 'KEY', fetcher,
    });
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.valid, '01');
  });

  // =========================================================================
  // 5. NTS client — 진위 불일치
  // =========================================================================
  await test('5. NTS 클라이언트 — 진위 불일치 (valid="02")', async () => {
    const fetcher = makeFetcher({
      status: { status: 200, json: { data: [{ b_stt_cd: '01' }] } },
      validate: { status: 200, json: { data: [{ valid: '02' }] } },
    });
    const v = await validateBusinessIdentity({
      businessNumber: '4040966416', ownerName: '다른이름', startDate: '20240101',
      serviceKey: 'KEY', fetcher,
    });
    assert.strictEqual(v.valid, '02');
  });

  // =========================================================================
  // 6. NTS — 휴업
  // =========================================================================
  await test('6. NTS 클라이언트 — 휴업 (b_stt_cd="02")', async () => {
    const fetcher = makeFetcher({
      status: { status: 200, json: { data: [{ b_stt_cd: '02' }] } },
      validate: null,
    });
    const s = await fetchBusinessStatus({ businessNumber: '4040966416', serviceKey: 'KEY', fetcher });
    assert.strictEqual(s.statusCode, '02');
  });

  // =========================================================================
  // 7. NTS — 폐업
  // =========================================================================
  await test('7. NTS 클라이언트 — 폐업 (b_stt_cd="03")', async () => {
    const fetcher = makeFetcher({
      status: { status: 200, json: { data: [{ b_stt_cd: '03' }] } },
      validate: null,
    });
    const s = await fetchBusinessStatus({ businessNumber: '4040966416', serviceKey: 'KEY', fetcher });
    assert.strictEqual(s.statusCode, '03');
  });

  // =========================================================================
  // handler 테스트는 fetcher 주입 불가 → 환경변수 + 모킹 + 형식 검증만 테스트
  // 실제 NTS 호출은 sprint1-verify/business-verify-real.js에서 검증
  // =========================================================================

  // 8. handler — API 키 없음 → 503
  await test('8. handler — PUBLIC_DATA_API_KEY 미설정 → 503', async () => {
    const oldMock = process.env.BUSINESS_VERIFY_MOCK;
    const oldKey = process.env.PUBLIC_DATA_API_KEY;
    process.env.BUSINESS_VERIFY_MOCK = 'false';
    delete process.env.PUBLIC_DATA_API_KEY;
    try {
      const { handler } = loadHandler();
      const res = await handler(makeEvent({
        businessNumber: '404-09-66416',
        ownerName: '김현',
        startDate: '2024-01-15',
        phone: '010-1234-5678',
      }));
      assert.strictEqual(res.statusCode, 503);
      const json = JSON.parse(res.body);
      assert.ok(json.error);
      assert.ok(json.error.title || typeof json.error === 'string');
    } finally {
      if (oldMock !== undefined) process.env.BUSINESS_VERIFY_MOCK = oldMock; else delete process.env.BUSINESS_VERIFY_MOCK;
      if (oldKey !== undefined) process.env.PUBLIC_DATA_API_KEY = oldKey;
    }
  });

  // 9. handler — startDate 옵션화 (사진 업로드 도입 후): MOCK으로 통과
  // 정책: startDate 없어도 status API만으로 통과 가능 (사진은 백그라운드 검토)
  await test('9. handler — startDate 없어도 MOCK 통과 → 200 + verified', async () => {
    const oldMock = process.env.BUSINESS_VERIFY_MOCK;
    process.env.BUSINESS_VERIFY_MOCK = 'true';
    try {
      const { handler } = loadHandler();
      const res = await handler(makeEvent({
        businessNumber: '404-09-66416',
        ownerName: '김현',
        phone: '010-1234-5678',
      }));
      assert.strictEqual(res.statusCode, 200);
      const json = JSON.parse(res.body);
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.verified, true);
    } finally {
      if (oldMock !== undefined) process.env.BUSINESS_VERIFY_MOCK = oldMock; else delete process.env.BUSINESS_VERIFY_MOCK;
    }
  });

  // 15. handler — MOCK 모드 → 200
  await test('10. handler — MOCK 모드 → 200 + method=mock', async () => {
    const oldMock = process.env.BUSINESS_VERIFY_MOCK;
    process.env.BUSINESS_VERIFY_MOCK = 'true';
    try {
      const { handler } = loadHandler();
      const res = await handler(makeEvent({
        businessNumber: '404-09-66416',
        ownerName: '김현',
        startDate: '2024-01-15',
        phone: '010-1234-5678',
      }));
      assert.strictEqual(res.statusCode, 200);
      const json = JSON.parse(res.body);
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.verified, true);
      assert.strictEqual(json.method, 'mock');
    } finally {
      if (oldMock !== undefined) process.env.BUSINESS_VERIFY_MOCK = oldMock; else delete process.env.BUSINESS_VERIFY_MOCK;
    }
  });

  // 형식 검증
  await test('11. handler — 잘못된 사업자번호 → 400', async () => {
    const oldMock = process.env.BUSINESS_VERIFY_MOCK;
    process.env.BUSINESS_VERIFY_MOCK = 'true';
    try {
      const { handler } = loadHandler();
      const res = await handler(makeEvent({
        businessNumber: '111-11-11111',  // 체크섬 실패
        ownerName: '김현',
        startDate: '2024-01-15',
        phone: '010-1234-5678',
      }));
      assert.strictEqual(res.statusCode, 400);
    } finally {
      if (oldMock !== undefined) process.env.BUSINESS_VERIFY_MOCK = oldMock; else delete process.env.BUSINESS_VERIFY_MOCK;
    }
  });

  await test('12. handler — 대표자명 누락 → 400', async () => {
    const oldMock = process.env.BUSINESS_VERIFY_MOCK;
    process.env.BUSINESS_VERIFY_MOCK = 'true';
    try {
      const { handler } = loadHandler();
      const res = await handler(makeEvent({
        businessNumber: '404-09-66416',
        ownerName: '',
        startDate: '2024-01-15',
        phone: '010-1234-5678',
      }));
      assert.strictEqual(res.statusCode, 400);
    } finally {
      if (oldMock !== undefined) process.env.BUSINESS_VERIFY_MOCK = oldMock; else delete process.env.BUSINESS_VERIFY_MOCK;
    }
  });

  await test('13. handler — OPTIONS preflight → 204', async () => {
    const { handler } = loadHandler();
    const res = await handler({ httpMethod: 'OPTIONS', headers: { origin: 'http://localhost' }, body: '' });
    assert.strictEqual(res.statusCode, 204);
  });

  await test('14. handler — GET → 405', async () => {
    const { handler } = loadHandler();
    const res = await handler({ httpMethod: 'GET', headers: { origin: 'http://localhost' }, body: '' });
    assert.strictEqual(res.statusCode, 405);
  });

  await test('15. handler — 잘못된 JSON → 400', async () => {
    const { handler } = loadHandler();
    const res = await handler({ httpMethod: 'POST', headers: { origin: 'http://localhost' }, body: '{not json' });
    assert.strictEqual(res.statusCode, 400);
  });

  // =========================================================================
  // 결과
  // =========================================================================
  console.log(`\n=== business-verify 단위 테스트 ===`);
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
})();
