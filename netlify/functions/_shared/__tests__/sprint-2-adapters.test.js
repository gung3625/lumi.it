// Sprint 2 어댑터·schema·정책·throttle·retry 단위 테스트
// 외부 라이브러리 X, node assert만 사용
// 실행: node netlify/functions/_shared/__tests__/sprint-2-adapters.test.js

const assert = require('assert');
const path = require('path');

const schema = require(path.join(__dirname, '..', 'market-adapters', 'lumi-product-schema'));
const coupangAdapter = require(path.join(__dirname, '..', 'market-adapters', 'coupang-adapter'));
const naverAdapter = require(path.join(__dirname, '..', 'market-adapters', 'naver-adapter'));
const policy = require(path.join(__dirname, '..', 'policy-words'));
const throttle = require(path.join(__dirname, '..', 'throttle'));
const retryEngine = require(path.join(__dirname, '..', 'retry-engine'));

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

async function asyncTest(name, fn) {
  try {
    await fn();
    pass += 1;
    results.push({ name, status: 'PASS' });
    console.log(`[PASS] ${name}`);
  } catch (e) {
    fail += 1;
    results.push({ name, status: 'FAIL', error: e.message });
    console.error(`[FAIL] ${name}: ${e.message}`);
  }
}

(async () => {
  // ================================================================
  // 1. lumi-product-schema
  // ================================================================
  test('schema: emptyLumiProduct 기본값', () => {
    const e = schema.emptyLumiProduct();
    assert.strictEqual(e.title, '');
    assert.strictEqual(e.price_suggested, 0);
    assert.deepStrictEqual(e.options, []);
    assert.deepStrictEqual(e.keywords, []);
  });

  test('schema: validateLumiProduct 정상 객체', () => {
    const ok = {
      title: '봄 시폰 원피스',
      category_suggestions: { coupang: { tree: ['패션의류'], confidence: 0.9 }, naver: { tree: ['패션의류'], confidence: 0.9 } },
      price_suggested: 39000,
      options: [{ name: '색상', values: ['베이지'] }],
      keywords: ['봄', '시폰'],
      policy_warnings: [],
      image_urls: ['https://x/y.jpg'],
      ai_confidence: 0.91,
    };
    const r = schema.validateLumiProduct(ok);
    assert.strictEqual(r.valid, true, JSON.stringify(r.errors));
  });

  test('schema: validateLumiProduct 누락 필드 검출', () => {
    const r = schema.validateLumiProduct({ title: '', image_urls: [], price_suggested: -1, ai_confidence: 2 });
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.length >= 3);
  });

  test('schema: fromAiResponse 변환', () => {
    const ai = { product_name: '코튼 후드', category: ['패션', '남성', '후드'], price: 29000, options: [{ name: '색상', values: ['그레이'] }], keywords: ['후드', '코튼'], ai_confidence: 0.85 };
    const lumi = schema.fromAiResponse(ai, ['https://x/1.jpg']);
    assert.strictEqual(lumi.title, '코튼 후드');
    assert.strictEqual(lumi.price_suggested, 29000);
    assert.strictEqual(lumi.image_urls.length, 1);
    assert.deepStrictEqual(lumi.category_suggestions.coupang.tree, ['패션', '남성', '후드']);
  });

  test('schema: keywords 20개 초과 시 trim', () => {
    const ai = { product_name: 't', keywords: Array.from({ length: 30 }, (_, i) => 'kw' + i) };
    const lumi = schema.fromAiResponse(ai, ['x']);
    assert.strictEqual(lumi.keywords.length, 20);
  });

  // ================================================================
  // 2. policy-words
  // ================================================================
  test('policy: 일반 사전 매칭 (최고급)', () => {
    const w = policy.checkPolicyWords('최고급 원피스');
    assert.ok(w.length >= 1);
    assert.strictEqual(w[0].word, '최고급');
    assert.strictEqual(w[0].suggestion, '프리미엄');
  });

  test('policy: 마켓별 사전 (쿠팡 직배송)', () => {
    const w = policy.checkPolicyWords('쿠팡 직배송 가능 상품', ['coupang']);
    assert.ok(w.some((x) => x.word === '쿠팡 직배송'));
  });

  test('policy: 깨끗한 텍스트 → 빈 배열', () => {
    const w = policy.checkPolicyWords('편안한 데일리 후드 티셔츠');
    assert.strictEqual(w.length, 0);
  });

  test('policy: applySafeReplacements 자동 치환', () => {
    const text = '최고급 의약품';
    const warnings = policy.checkPolicyWords(text);
    const safe = policy.applySafeReplacements(text, warnings);
    assert.ok(!safe.includes('최고급'));
    assert.ok(safe.includes('프리미엄'));
  });

  // ================================================================
  // 3. throttle (Token Bucket)
  // ================================================================
  test('throttle: tryAcquire 기본 5회 토큰', () => {
    throttle._reset();
    const results = [];
    for (let i = 0; i < 7; i++) {
      results.push(throttle.tryAcquire('coupang', 'A001'));
    }
    const allowed = results.filter((r) => r.allowed).length;
    assert.strictEqual(allowed, 5, `expected 5 allowed, got ${allowed}`);
  });

  test('throttle: applyBackoff 후 토큰 0', () => {
    throttle._reset();
    throttle.applyBackoff('naver', 'X', 60000);
    const r = throttle.tryAcquire('naver', 'X');
    assert.strictEqual(r.allowed, false);
  });

  test('throttle: adaptFromHeaders 헤더 반영', () => {
    throttle._reset();
    throttle.adaptFromHeaders('naver', 'Y', { remaining: '3', replenishRate: '20', burstCapacity: '40' });
    // 단순 적용 검증 — 다음 acquire는 허용 (3토큰)
    const r = throttle.tryAcquire('naver', 'Y');
    assert.strictEqual(typeof r.remaining, 'number');
  });

  test('throttle: getPriority 분류', () => {
    assert.strictEqual(throttle.getPriority('order_received'), throttle.PRIORITY.immediate);
    assert.strictEqual(throttle.getPriority('register_product'), throttle.PRIORITY.fast);
    assert.strictEqual(throttle.getPriority('price_update'), throttle.PRIORITY.batch);
  });

  // ================================================================
  // 4. retry-engine (DB 의존 X — 순수 함수만)
  // ================================================================
  test('retry: nextRetryAt 단계별 backoff', () => {
    const now = new Date('2026-04-28T00:00:00Z');
    const t0 = retryEngine.nextRetryAt(0, now);
    const t1 = retryEngine.nextRetryAt(1, now);
    const t4 = retryEngine.nextRetryAt(4, now);
    assert.strictEqual(t0.getTime() - now.getTime(), 60_000);
    assert.strictEqual(t1.getTime() - now.getTime(), 5 * 60_000);
    assert.strictEqual(t4.getTime() - now.getTime(), 24 * 60 * 60_000);
  });

  test('retry: BACKOFF_INTERVALS_MS 5단계', () => {
    assert.strictEqual(retryEngine.BACKOFF_INTERVALS_MS.length, 5);
    assert.strictEqual(retryEngine.MAX_RETRY_COUNT, 5);
  });

  // ================================================================
  // 5. coupang-adapter (모킹 모드 + transform)
  // ================================================================
  test('coupang: transformToCoupangPayload 단품', () => {
    const lumi = schema.fromAiResponse({ product_name: '단품테스트', price: 10000 }, ['https://x/1.jpg']);
    const p = coupangAdapter.transformToCoupangPayload(lumi, 'A00012345');
    assert.strictEqual(p.sellerProductName, '단품테스트');
    assert.strictEqual(p.vendorId, 'A00012345');
    assert.ok(Array.isArray(p.items));
    assert.strictEqual(p.items[0].itemName, '단품');
  });

  test('coupang: transformToCoupangPayload 옵션 직교곱', () => {
    const lumi = schema.fromAiResponse({
      product_name: '옵션테스트', price: 20000,
      options: [{ name: '색상', values: ['빨강', '파랑'] }, { name: '사이즈', values: ['M', 'L'] }],
    }, ['https://x/1.jpg']);
    const p = coupangAdapter.transformToCoupangPayload(lumi, 'A00012345');
    assert.strictEqual(p.items.length, 4); // 2*2
    assert.ok(p.items.some((it) => it.itemName.includes('빨강')));
  });

  test('coupang: buildCoupangDirectLink', () => {
    const link = coupangAdapter.buildCoupangDirectLink({ data: { productId: '12345' } });
    assert.strictEqual(link, 'https://www.coupang.com/vp/products/12345');
  });

  await asyncTest('coupang: registerProduct mock 모드 직링크 응답', async () => {
    const lumi = {
      title: '테스트 상품',
      category_suggestions: { coupang: { tree: ['A'], confidence: 0.9 }, naver: { tree: ['A'], confidence: 0.9 } },
      price_suggested: 10000,
      options: [],
      keywords: ['t'],
      policy_warnings: [],
      image_urls: ['https://x/1.jpg'],
      ai_confidence: 0.9,
    };
    const r = await coupangAdapter.registerProduct({ lumiProduct: lumi, market_seller_id: 'A00012345', mock: true });
    assert.strictEqual(r.success, true);
    assert.ok(r.market_product_id.startsWith('MOCK_'));
    assert.ok(r.direct_link.includes('coupang.com/vp/products/MOCK_'));
  });

  await asyncTest('coupang: registerProduct 스키마 오류 시 400', async () => {
    const r = await coupangAdapter.registerProduct({ lumiProduct: { title: '' }, mock: true });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.status, 400);
  });

  // ================================================================
  // 6. naver-adapter
  // ================================================================
  test('naver: transformToNaverPayload 기본', () => {
    const lumi = schema.fromAiResponse({ product_name: '네이버 단품', price: 15000 }, ['https://x/1.jpg']);
    const p = naverAdapter.transformToNaverPayload(lumi);
    assert.strictEqual(p.originProduct.name, '네이버 단품');
    assert.strictEqual(p.originProduct.salePrice, 15000);
    assert.strictEqual(p.originProduct.images.representativeImage.url, 'https://x/1.jpg');
  });

  test('naver: shouldRefreshToken 만료 30분 이내', () => {
    const exp = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    assert.strictEqual(naverAdapter.shouldRefreshToken(exp), true);
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    assert.strictEqual(naverAdapter.shouldRefreshToken(future), false);
    assert.strictEqual(naverAdapter.shouldRefreshToken(null), true);
  });

  test('naver: buildNaverDirectLink with storeId', () => {
    const link = naverAdapter.buildNaverDirectLink({ smartstoreChannelProductNo: '99999' }, 'mystore');
    assert.strictEqual(link, 'https://smartstore.naver.com/mystore/products/99999');
  });

  test('naver: buildNaverDirectLink without storeId fallback main', () => {
    const link = naverAdapter.buildNaverDirectLink({ smartstoreProductId: '88888' });
    assert.strictEqual(link, 'https://smartstore.naver.com/main/products/88888');
  });

  await asyncTest('naver: registerProduct mock 모드 직링크 응답', async () => {
    const lumi = {
      title: '네이버 모킹',
      category_suggestions: { coupang: { tree: ['A'], confidence: 0.9 }, naver: { tree: ['A'], confidence: 0.9 } },
      price_suggested: 25000,
      options: [],
      keywords: ['n'],
      policy_warnings: [],
      image_urls: ['https://x/1.jpg'],
      ai_confidence: 0.88,
    };
    const r = await naverAdapter.registerProduct({ lumiProduct: lumi, store_id: 'lumi', mock: true });
    assert.strictEqual(r.success, true);
    assert.ok(r.market_product_id.startsWith('NV_MOCK_'));
    assert.ok(r.direct_link.includes('smartstore.naver.com/lumi/products/NV_MOCK_'));
  });

  // ================================================================
  // 7. 통합 — 정책 워닝이 LumiProduct에 반영되는지
  // ================================================================
  test('integration: AI 응답 → schema 변환 → 정책 검사', () => {
    const ai = { product_name: '최고급 스마트폰 케이스', price: 9900, keywords: ['케이스'] };
    const lumi = schema.fromAiResponse(ai, ['https://x/1.jpg']);
    const warnings = policy.checkPolicyWords(lumi.title);
    lumi.policy_warnings = warnings;
    assert.ok(lumi.policy_warnings.length >= 1);
    assert.strictEqual(lumi.policy_warnings[0].word, '최고급');
  });

  // ================================================================
  // Summary
  // ================================================================
  console.log(`\n총 ${pass + fail} 테스트 — ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
})();
