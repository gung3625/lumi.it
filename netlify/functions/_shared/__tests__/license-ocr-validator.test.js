// 사업자등록증 OCR 자동 대조 — Sprint 1.1 단위 테스트
// 외부 라이브러리 없이 node assert만 사용
// 실행: node netlify/functions/_shared/__tests__/license-ocr-validator.test.js
//
// 검증 케이스:
//  [OCR 추출 정상 5종]
//   1. mockExtract — 셀러 입력값 그대로 추출
//   2. sanitizeExtracted — 모든 필드 정상 추출 후 사업자번호 정규화
//   3. sanitizeExtracted — 예상 외 키 제거
//   4. validateLicenseOcr — AI_OCR_MOCK=true 시 mock 모드 응답
//   5. validateLicenseOcr — 모킹 + 일치 시 autoApprove=true
//
//  [입력 vs 사진 불일치 5종]
//   6. compareWithInput — 사업자번호 불일치
//   7. compareWithInput — 대표자명 불일치
//   8. compareWithInput — 둘 다 불일치
//   9. compareWithInput — is_business_license=false (다른 문서)
//  10. compareWithInput — OCR 빈 응답 (사업자번호 없음)
//
//  [Confidence 임계치 4종]
//  11. shouldAutoApprove — confidence=89 → false (89 < 90)
//  12. shouldAutoApprove — confidence=90 + match → true
//  13. shouldAutoApprove — confidence=100 but mismatch → false
//  14. shouldAutoApprove — null comparison → false
//
//  [모킹 모드 검증 2종]
//  15. validateLicenseOcr — PDF MIME → mock 모드에서도 OCR 실행 (mock은 mime 무시)
//  16. validateLicenseOcr — 실 모드 + PDF → unsupported_format error

const assert = require('assert');
const path = require('path');

const validatorPath = path.join(__dirname, '..', 'license-ocr-validator.js');
delete require.cache[validatorPath];
const {
  validateLicenseOcr,
  compareWithInput,
  shouldAutoApprove,
  normalizeName,
  normalizeBizNumber,
  sanitizeExtracted,
  AUTO_APPROVE_THRESHOLD,
  _internals,
} = require(validatorPath);

let pass = 0;
let fail = 0;
const results = [];

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { pass += 1; results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); })
    .catch((e) => { fail += 1; results.push({ name, status: 'FAIL', error: e.message }); console.error(`[FAIL] ${name}: ${e.message}`); });
}

// JPEG 매직 바이트 + 더미 페이로드 (실제 OCR 호출 없으므로 내용은 무관)
function makeJpegBuffer() {
  const head = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
  const tail = Buffer.alloc(512, 0x00);
  return Buffer.concat([head, tail]);
}

(async function run() {
  // 모든 테스트는 AI_OCR_MOCK=true 기본값 가정 — env 격리
  const oldMock = process.env.AI_OCR_MOCK;
  process.env.AI_OCR_MOCK = 'true';

  // ============ OCR 추출 정상 5종 ============

  // 1. mockExtract — 셀러 입력값 그대로
  await test('1. mockExtract — 셀러 입력값을 OCR 결과로 그대로 반환', () => {
    const r = _internals.mockExtract({
      businessNumber: '404-09-66416',
      ownerName: '김현',
      businessName: '루미',
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.raw.business_number, '4040966416');
    assert.strictEqual(r.raw.owner_name, '김현');
    assert.strictEqual(r.raw.business_name, '루미');
    assert.strictEqual(r.raw.confidence, 95);
    assert.strictEqual(r.raw.is_business_license, true);
  });

  // 2. sanitizeExtracted — 모든 필드 정상
  await test('2. sanitizeExtracted — 정상 OCR 응답을 표준 필드로 정규화', () => {
    const sanitized = sanitizeExtracted({
      business_number: '404-09-66416',
      business_name: '루미',
      owner_name: '김현',
      address: '서울시 강남구',
      start_date: '2024-01-15',
      business_type: '소프트웨어 개발',
      confidence: 92,
      is_business_license: true,
    });
    assert.strictEqual(sanitized.business_number, '4040966416');
    assert.strictEqual(sanitized.owner_name, '김현');
    assert.strictEqual(sanitized.confidence, 92);
    assert.strictEqual(sanitized.is_business_license, true);
  });

  // 3. sanitizeExtracted — 예상 외 키 제거
  await test('3. sanitizeExtracted — 예상 외 키 제거 + 누락 필드 빈 문자열', () => {
    const sanitized = sanitizeExtracted({
      business_number: '4040966416',
      malicious_key: '<script>alert(1)</script>',
      // 다른 필드 누락
    });
    assert.strictEqual(sanitized.business_number, '4040966416');
    assert.strictEqual(sanitized.owner_name, '');
    assert.strictEqual(sanitized.malicious_key, undefined);
    assert.strictEqual(sanitized.confidence, 0);
  });

  // 4. validateLicenseOcr — mock 모드 응답
  await test('4. validateLicenseOcr — AI_OCR_MOCK=true → mode=mock', async () => {
    const r = await validateLicenseOcr({
      imageBuffer: makeJpegBuffer(),
      mimeType: 'image/jpeg',
      input: { businessNumber: '404-09-66416', ownerName: '김현' },
    });
    assert.strictEqual(r.mode, 'mock');
    assert.strictEqual(r.error, null);
    assert.ok(r.extracted);
    assert.ok(r.comparison);
  });

  // 5. validateLicenseOcr — 모킹 + 일치 시 autoApprove=true
  await test('5. validateLicenseOcr — 모킹 + 입력값 일치 → autoApprove=true', async () => {
    const r = await validateLicenseOcr({
      imageBuffer: makeJpegBuffer(),
      mimeType: 'image/png',
      input: { businessNumber: '4040966416', ownerName: '김현' },
    });
    assert.strictEqual(r.autoApprove, true);
    assert.strictEqual(r.comparison.match, true);
    assert.strictEqual(r.comparison.businessNumberMatch, true);
    assert.strictEqual(r.comparison.ownerNameMatch, true);
    assert.ok(r.comparison.confidence >= AUTO_APPROVE_THRESHOLD);
  });

  // ============ 입력 vs 사진 불일치 5종 ============

  // 6. compareWithInput — 사업자번호 불일치
  await test('6. compareWithInput — 사업자번호 불일치 → match=false', () => {
    const c = compareWithInput({
      ocr: { business_number: '4040966416', owner_name: '김현', confidence: 95, is_business_license: true },
      input: { businessNumber: '1111111111', ownerName: '김현' },
    });
    assert.strictEqual(c.match, false);
    assert.strictEqual(c.businessNumberMatch, false);
    assert.strictEqual(c.ownerNameMatch, true);
    assert.ok(c.reasons.includes('business_number_mismatch'));
  });

  // 7. compareWithInput — 대표자명 불일치
  await test('7. compareWithInput — 대표자명 불일치 → match=false', () => {
    const c = compareWithInput({
      ocr: { business_number: '4040966416', owner_name: '홍길동', confidence: 95, is_business_license: true },
      input: { businessNumber: '4040966416', ownerName: '김현' },
    });
    assert.strictEqual(c.match, false);
    assert.strictEqual(c.businessNumberMatch, true);
    assert.strictEqual(c.ownerNameMatch, false);
    assert.ok(c.reasons.includes('owner_name_mismatch'));
  });

  // 8. compareWithInput — 둘 다 불일치
  await test('8. compareWithInput — 사업자번호+대표자명 둘 다 불일치', () => {
    const c = compareWithInput({
      ocr: { business_number: '1234567890', owner_name: '홍길동', confidence: 80, is_business_license: true },
      input: { businessNumber: '4040966416', ownerName: '김현' },
    });
    assert.strictEqual(c.match, false);
    assert.strictEqual(c.businessNumberMatch, false);
    assert.strictEqual(c.ownerNameMatch, false);
    assert.strictEqual(c.reasons.length >= 2, true);
  });

  // 9. is_business_license=false
  await test('9. compareWithInput — is_business_license=false → match=false + reason', () => {
    const c = compareWithInput({
      ocr: { business_number: '4040966416', owner_name: '김현', confidence: 95, is_business_license: false },
      input: { businessNumber: '4040966416', ownerName: '김현' },
    });
    assert.strictEqual(c.match, false);
    assert.strictEqual(c.isBusinessLicense, false);
    assert.ok(c.reasons.includes('not_business_license'));
  });

  // 10. OCR 빈 응답
  await test('10. compareWithInput — OCR 사업자번호 빈 응답 → match=false', () => {
    const c = compareWithInput({
      ocr: { business_number: '', owner_name: '', confidence: 30, is_business_license: true },
      input: { businessNumber: '4040966416', ownerName: '김현' },
    });
    assert.strictEqual(c.match, false);
    assert.ok(c.reasons.includes('ocr_business_number_missing'));
    assert.ok(c.reasons.includes('ocr_owner_name_missing'));
  });

  // ============ Confidence 임계치 4종 ============

  // 11. confidence=89 → false (90 미만)
  await test('11. shouldAutoApprove — confidence=89 (임계치 미만) → false', () => {
    const r = shouldAutoApprove({
      match: true,
      businessNumberMatch: true,
      ownerNameMatch: true,
      isBusinessLicense: true,
      confidence: 89,
      reasons: [],
    });
    assert.strictEqual(r, false);
  });

  // 12. confidence=90 + match → true
  await test('12. shouldAutoApprove — confidence=90 (임계치 정확) + match=true → true', () => {
    const r = shouldAutoApprove({
      match: true,
      businessNumberMatch: true,
      ownerNameMatch: true,
      isBusinessLicense: true,
      confidence: AUTO_APPROVE_THRESHOLD,
      reasons: [],
    });
    assert.strictEqual(r, true);
  });

  // 13. confidence=100 but mismatch → false
  await test('13. shouldAutoApprove — confidence=100 + match=false → false', () => {
    const r = shouldAutoApprove({
      match: false,
      businessNumberMatch: false,
      ownerNameMatch: true,
      isBusinessLicense: true,
      confidence: 100,
      reasons: ['business_number_mismatch'],
    });
    assert.strictEqual(r, false);
  });

  // 14. null comparison
  await test('14. shouldAutoApprove — null comparison → false', () => {
    assert.strictEqual(shouldAutoApprove(null), false);
    assert.strictEqual(shouldAutoApprove(undefined), false);
  });

  // ============ 모킹 모드 검증 2종 ============

  // 15. PDF in mock mode — 모킹은 mime 무시 (셀러 입력값 그대로 사용)
  await test('15. validateLicenseOcr — mock 모드 + PDF → mode=mock 정상 응답', async () => {
    const r = await validateLicenseOcr({
      imageBuffer: Buffer.from('%PDF-1.4'),
      mimeType: 'application/pdf',
      input: { businessNumber: '4040966416', ownerName: '김현' },
    });
    assert.strictEqual(r.mode, 'mock');
    assert.strictEqual(r.autoApprove, true);
    assert.strictEqual(r.comparison.match, true);
  });

  // 16. PDF in real mode — unsupported_format 에러
  await test('16. validateLicenseOcr — 실 모드 + PDF → unsupported_format', async () => {
    process.env.AI_OCR_MOCK = 'false';
    const oldKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-not-real';
    try {
      const r = await validateLicenseOcr({
        imageBuffer: Buffer.from('%PDF-1.4'),
        mimeType: 'application/pdf',
        input: { businessNumber: '4040966416', ownerName: '김현' },
      });
      assert.strictEqual(r.mode, 'skipped');
      assert.strictEqual(r.error, 'unsupported_format');
      assert.strictEqual(r.autoApprove, false);
    } finally {
      process.env.AI_OCR_MOCK = 'true';
      if (oldKey !== undefined) process.env.OPENAI_API_KEY = oldKey; else delete process.env.OPENAI_API_KEY;
    }
  });

  // ============ 보너스: 정규화 헬퍼 ============

  await test('17. normalizeName — 공백/한자 괄호 제거', () => {
    assert.strictEqual(normalizeName('홍 길 동'), '홍길동');
    assert.strictEqual(normalizeName('홍길동(洪吉童)'), '홍길동');
    assert.strictEqual(normalizeName('  김현  '), '김현');
    assert.strictEqual(normalizeName(''), '');
    assert.strictEqual(normalizeName(null), '');
  });

  await test('18. normalizeBizNumber — 하이픈 제거 + 10자리 자르기', () => {
    assert.strictEqual(normalizeBizNumber('404-09-66416'), '4040966416');
    assert.strictEqual(normalizeBizNumber('40409664169999'), '4040966416');
    assert.strictEqual(normalizeBizNumber(''), '');
    assert.strictEqual(normalizeBizNumber(null), '');
  });

  await test('19. compareWithInput — 부분 일치 허용 (홍길동 vs 홍길동대표)', () => {
    const c = compareWithInput({
      ocr: { business_number: '4040966416', owner_name: '홍길동대표', confidence: 95, is_business_license: true },
      input: { businessNumber: '4040966416', ownerName: '홍길동' },
    });
    assert.strictEqual(c.ownerNameMatch, true);
  });

  await test('20. validateLicenseOcr — 입력값 모두 누락 시 mock 결과는 빈 문자열', async () => {
    const r = await validateLicenseOcr({
      imageBuffer: makeJpegBuffer(),
      mimeType: 'image/jpeg',
      input: { businessNumber: '', ownerName: '' },
    });
    assert.strictEqual(r.mode, 'mock');
    assert.strictEqual(r.autoApprove, false); // 빈 입력은 일치 판정 못 함
  });

  // env 복원
  if (oldMock !== undefined) process.env.AI_OCR_MOCK = oldMock; else delete process.env.AI_OCR_MOCK;

  // 결과
  console.log(`\n=== license-ocr-validator 단위 테스트 ===`);
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
