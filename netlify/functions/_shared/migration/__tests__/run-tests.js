#!/usr/bin/env node
// Sprint 3.5 마이그레이션 단위 테스트 — 4단 파이프라인 모듈별 검증
// 사용: node netlify/functions/_shared/migration/__tests__/run-tests.js

const path = require('path');
const assert = require('assert');

const MIG_ROOT = path.resolve(__dirname, '..');

const TESTS = [];
function test(name, fn) { TESTS.push({ name, fn }); }

// ──────────────────────────────────────────────────────────────────────────
// encoding-detector
// ──────────────────────────────────────────────────────────────────────────
test('encoding-detector: UTF-8 BOM 감지', () => {
  const { detectEncoding } = require(`${MIG_ROOT}/core/encoding-detector`);
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('상품명,가격', 'utf-8')]);
  assert.strictEqual(detectEncoding(buf), 'utf-8');
});

test('encoding-detector: XLSX 바이너리는 binary 반환', () => {
  const { detectEncoding } = require(`${MIG_ROOT}/core/encoding-detector`);
  const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  assert.strictEqual(detectEncoding(buf), 'binary');
});

test('encoding-detector: 한글 UTF-8 텍스트 감지', () => {
  const { detectEncoding } = require(`${MIG_ROOT}/core/encoding-detector`);
  const text = '상품명,판매가,재고\n봄원피스,15000,10\n';
  assert.strictEqual(detectEncoding(Buffer.from(text, 'utf-8')), 'utf-8');
});

test('encoding-detector: codepage 매핑', () => {
  const { toCodepage } = require(`${MIG_ROOT}/core/encoding-detector`);
  assert.strictEqual(toCodepage('utf-8'), 65001);
  assert.strictEqual(toCodepage('euc-kr'), 949);
});

// ──────────────────────────────────────────────────────────────────────────
// solution-identifier
// ──────────────────────────────────────────────────────────────────────────
test('solution-identifier: 사방넷 시그니처 (it_name + it_price)', () => {
  const { identifySolution } = require(`${MIG_ROOT}/core/solution-identifier`);
  const r = identifySolution(['판매자상품코드', 'it_name', 'it_price', 'it_stock', 'it_img']);
  assert.strictEqual(r.solution, 'sabangnet');
  assert.ok(r.confidence > 0.5);
});

test('solution-identifier: 샵링커 시그니처', () => {
  const { identifySolution } = require(`${MIG_ROOT}/core/solution-identifier`);
  const r = identifySolution(['판매자관리코드', '상품명', '판매가', '공급가', '대표이미지']);
  assert.strictEqual(r.solution, 'shoplinker');
});

test('solution-identifier: 이지어드민 시그니처', () => {
  const { identifySolution } = require(`${MIG_ROOT}/core/solution-identifier`);
  const r = identifySolution(['상품관리코드', '상품명', '판매단가', '현재고', '이지카테고리']);
  assert.strictEqual(r.solution, 'ezadmin');
});

test('solution-identifier: 플레이오토 시그니처', () => {
  const { identifySolution } = require(`${MIG_ROOT}/core/solution-identifier`);
  const r = identifySolution(['자체상품코드', '상품명', '판매가', '메인이미지', '확장필드1']);
  assert.strictEqual(r.solution, 'plto');
});

test('solution-identifier: unknown 폴백', () => {
  const { identifySolution } = require(`${MIG_ROOT}/core/solution-identifier`);
  const r = identifySolution(['Custom Field A', 'Custom Field B']);
  assert.strictEqual(r.solution, 'unknown');
});

test('solution-identifier: 친화 라벨에 솔루션명 노출 금지', () => {
  const { friendlyLabel } = require(`${MIG_ROOT}/core/solution-identifier`);
  const labels = ['sabangnet', 'shoplinker', 'ezadmin', 'plto'].map(friendlyLabel);
  for (const label of labels) {
    assert.ok(!/사방넷|샵링커|이지어드민|플레이오토/i.test(label), `라벨 "${label}"에 경쟁사명 포함`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// header-mapper (Phase 1 + Phase 2)
// ──────────────────────────────────────────────────────────────────────────
test('header-mapper: 사방넷 표준 헤더 100% 코드 매핑', async () => {
  const { mapHeaders } = require(`${MIG_ROOT}/core/header-mapper`);
  const headers = ['it_name', 'it_price', 'it_stock', 'it_img', '판매자상품코드'];
  const r = await mapHeaders(headers, { solution: 'sabangnet', mockAi: true });
  const mappedFields = r.filter((m) => m.source === 'code').length;
  assert.ok(mappedFields >= 4, `code 매핑 ${mappedFields} (4 이상 기대)`);
});

test('header-mapper: AI 폴백 모킹 (변칙 헤더)', async () => {
  const { mapHeaders } = require(`${MIG_ROOT}/core/header-mapper`);
  const headers = ['상품 이름 (옵션)', '가격 (원)', '수량'];
  const r = await mapHeaders(headers, { solution: 'unknown', mockAi: true });
  const mapped = r.filter((m) => m.mapped);
  assert.ok(mapped.length >= 2, `mock AI 매핑 ${mapped.length}개 (2 이상 기대)`);
});

test('header-mapper: 휴리스틱 가격·재고 추론', () => {
  const { heuristicGuess } = require(`${MIG_ROOT}/core/header-mapper`);
  assert.strictEqual(heuristicGuess('판매가'), 'price');
  assert.strictEqual(heuristicGuess('재고수량'), 'stock');
  assert.strictEqual(heuristicGuess('상품명'), 'product_name');
  assert.strictEqual(heuristicGuess('미스테리필드'), null);
});

// ──────────────────────────────────────────────────────────────────────────
// currency-parser
// ──────────────────────────────────────────────────────────────────────────
test('currency-parser: 쉼표·"원" 제거', () => {
  const { parseCurrency } = require(`${MIG_ROOT}/transformers/currency-parser`);
  assert.strictEqual(parseCurrency('15,000원').value, 15000);
  assert.strictEqual(parseCurrency('₩39,900').value, 39900);
  assert.strictEqual(parseCurrency('1,234,567').value, 1234567);
});

test('currency-parser: 품절 플래그 추출', () => {
  const { parseCurrency } = require(`${MIG_ROOT}/transformers/currency-parser`);
  const r = parseCurrency('15,000원(품절)');
  assert.strictEqual(r.value, 15000);
  assert.deepStrictEqual(r.flags, ['out_of_stock']);
});

test('currency-parser: 음수·빈값 안전 처리', () => {
  const { parseCurrency, parseStock } = require(`${MIG_ROOT}/transformers/currency-parser`);
  assert.strictEqual(parseCurrency('').value, 0);
  assert.strictEqual(parseCurrency(null).value, 0);
  assert.strictEqual(parseCurrency(-100).value, 0);
  assert.strictEqual(parseStock('재고없음').value, 0);
  assert.strictEqual(parseStock(50).value, 50);
});

// ──────────────────────────────────────────────────────────────────────────
// option-parser
// ──────────────────────────────────────────────────────────────────────────
test('option-parser: 색상:블랙|사이즈:XL 형식', () => {
  const { parseOptionString } = require(`${MIG_ROOT}/transformers/option-parser`);
  const r = parseOptionString('색상:블랙|사이즈:XL');
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].name, '색상');
  assert.deepStrictEqual(r[0].values, ['블랙']);
  assert.strictEqual(r[1].name, '사이즈');
});

test('option-parser: S/M/L value-only 폴백', () => {
  const { parseOptionString } = require(`${MIG_ROOT}/transformers/option-parser`);
  const r = parseOptionString('S/M/L');
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual(r[0].values, ['S', 'M', 'L']);
});

test('option-parser: 복합 구분자 (색상-블랙,화이트;사이즈-M,L)', () => {
  const { parseOptionString } = require(`${MIG_ROOT}/transformers/option-parser`);
  const r = parseOptionString('색상-블랙,화이트;사이즈-M,L');
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r[0].values, ['블랙', '화이트']);
  assert.deepStrictEqual(r[1].values, ['M', 'L']);
});

test('option-parser: 행 분리형 집계', () => {
  const { aggregateRowOptions } = require(`${MIG_ROOT}/transformers/option-parser`);
  const r = aggregateRowOptions([
    { name: '색상', value: '블랙' },
    { name: '색상', value: '화이트' },
    { name: '사이즈', value: 'M' },
  ]);
  assert.strictEqual(r.length, 2);
  const color = r.find((o) => o.name === '색상');
  assert.deepStrictEqual(color.values.sort(), ['블랙', '화이트']);
});

// ──────────────────────────────────────────────────────────────────────────
// image-validator
// ──────────────────────────────────────────────────────────────────────────
test('image-validator: 절대 URL 형식 검증', () => {
  const { validateUrlFormat } = require(`${MIG_ROOT}/transformers/image-validator`);
  assert.strictEqual(validateUrlFormat('https://example.com/a.jpg').valid, true);
  assert.strictEqual(validateUrlFormat('relative/path.jpg').valid, false);
  assert.strictEqual(validateUrlFormat('').valid, false);
});

test('image-validator: CSV 분리', () => {
  const { parseImageUrlCsv } = require(`${MIG_ROOT}/transformers/image-validator`);
  const r = parseImageUrlCsv('https://a.jpg,https://b.jpg,https://c.jpg');
  assert.strictEqual(r.length, 3);
  assert.strictEqual(r[0], 'https://a.jpg');
});

test('image-validator: 모킹 표본 검증', async () => {
  const { sampleValidate } = require(`${MIG_ROOT}/transformers/image-validator`);
  const r = await sampleValidate(['https://a.jpg', 'https://b.png'], { mock: true });
  assert.strictEqual(r.checked, 2);
  assert.strictEqual(r.brokenUrls.length, 0);
});

// ──────────────────────────────────────────────────────────────────────────
// policy-word-checker (마이그레이션 시점)
// ──────────────────────────────────────────────────────────────────────────
test('policy-word-checker: "최고급" 검출', () => {
  const { checkText } = require(`${MIG_ROOT}/transformers/policy-word-checker`);
  const r = checkText('최고급 봄 원피스');
  assert.ok(r.length >= 1, '"최고" 검출 기대');
});

test('policy-word-checker: 상품 배열 일괄 검사', () => {
  const { checkProducts } = require(`${MIG_ROOT}/transformers/policy-word-checker`);
  const r = checkProducts([
    { product_name: '평범한 원피스', sku_code: 'A1' },
    { product_name: '최저가 보장 셔츠', sku_code: 'A2' },
    { product_name: '특허 출원 가방', sku_code: 'A3' },
  ]);
  assert.ok(r.violatingCount >= 2, `위반 ${r.violatingCount} (2 이상 기대)`);
});

// ──────────────────────────────────────────────────────────────────────────
// sabang-parser (옵션 모드 자동 감지)
// ──────────────────────────────────────────────────────────────────────────
test('sabang-parser: 행 분리형 옵션 감지 + 그룹핑', () => {
  const { parseSabangSheet } = require(`${MIG_ROOT}/parsers/sabang-parser`);
  const rows = [
    { '판매자상품코드': 'AB12345', 'it_name': '봄 원피스', '옵션명': '색상', '옵션값': '블랙', 'it_price': '39000' },
    { '판매자상품코드': 'AB12345', 'it_name': '봄 원피스', '옵션명': '색상', '옵션값': '화이트', 'it_price': '39000' },
    { '판매자상품코드': 'AB12345', 'it_name': '봄 원피스', '옵션명': '사이즈', '옵션값': 'M', 'it_price': '39000' },
  ];
  const r = parseSabangSheet(rows);
  assert.strictEqual(r.optionMode, 'row-split');
  assert.strictEqual(r.products.length, 1);
  assert.ok(r.products[0].options.length >= 3);
});

test('sabang-parser: 결합형 옵션 감지', () => {
  const { parseSabangSheet } = require(`${MIG_ROOT}/parsers/sabang-parser`);
  const rows = [
    { '판매자상품코드': 'AB1', 'it_name': '원피스', '옵션값': '색상:블랙|사이즈:M', 'it_price': '39000' },
  ];
  const r = parseSabangSheet(rows);
  assert.strictEqual(r.optionMode, 'inline');
});

// ──────────────────────────────────────────────────────────────────────────
// lumi-excel-processor (통합)
// ──────────────────────────────────────────────────────────────────────────
test('lumi-excel-processor: validateRow 필수 필드 검증', () => {
  const { validateRow } = require(`${MIG_ROOT}/core/lumi-excel-processor`);
  const valid = {
    sku_code: 'A1', title: '원피스', price: 39000, stock: 10,
    image_urls: ['https://a.jpg'],
  };
  assert.deepStrictEqual(validateRow(valid), []);

  const invalid = { sku_code: '', title: '', price: 0, stock: -1, image_urls: [] };
  const errors = validateRow(invalid);
  assert.ok(errors.length >= 4);
});

test('lumi-excel-processor: normalizeProduct 행 → Lumi 표준', () => {
  const { normalizeProduct } = require(`${MIG_ROOT}/core/lumi-excel-processor`);
  const headerMapping = [
    { original: '판매자상품코드', mapped: 'sku_code', confidence: 1, source: 'code' },
    { original: 'it_name', mapped: 'product_name', confidence: 1, source: 'code' },
    { original: 'it_price', mapped: 'price', confidence: 1, source: 'code' },
    { original: 'it_stock', mapped: 'stock', confidence: 1, source: 'code' },
    { original: 'it_img', mapped: 'image_url', confidence: 1, source: 'code' },
  ];
  const row = {
    '판매자상품코드': 'AB12345',
    'it_name': '봄 원피스',
    'it_price': '39,000원',
    'it_stock': '10',
    'it_img': 'https://example.com/a.jpg,https://example.com/b.jpg',
  };
  const p = normalizeProduct(row, [], headerMapping);
  assert.strictEqual(p.sku_code, 'AB12345');
  assert.strictEqual(p.title, '봄 원피스');
  assert.strictEqual(p.price, 39000);
  assert.strictEqual(p.stock, 10);
  assert.strictEqual(p.image_urls.length, 2);
});

test('lumi-excel-processor: buildAhaCopy 결제 트리거 카피', () => {
  const { buildAhaCopy } = require(`${MIG_ROOT}/core/lumi-excel-processor`);
  const p = {
    title: '봄 원피스', price: 39000, stock: 10,
    image_urls: ['a.jpg', 'b.jpg'],
    options: [{ name: '색상', values: ['블랙', '화이트'] }],
    _valid: true,
  };
  const aha = buildAhaCopy(p);
  assert.ok(/등록/.test(aha.tagline));
  assert.ok(aha.hint.length > 0);
});

// ──────────────────────────────────────────────────────────────────────────
// Run
// ──────────────────────────────────────────────────────────────────────────
(async () => {
  let pass = 0;
  let fail = 0;
  const failed = [];
  for (const t of TESTS) {
    try {
      await t.fn();
      pass++;
      console.log(`[PASS] ${t.name}`);
    } catch (e) {
      fail++;
      failed.push({ name: t.name, error: e.message });
      console.log(`[FAIL] ${t.name}\n       ${e.message}`);
    }
  }
  console.log(`\n${pass}/${TESTS.length} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('\nFailed tests:');
    failed.forEach((f) => console.log(`  - ${f.name}: ${f.error}`));
    process.exit(1);
  }
})();
