// Sprint 5 기본기 단위 테스트 — 4 endpoint + 어댑터 신규 함수
// 외부 의존: node-fetch (이미 사용 중), Supabase 모듈은 모킹
// 사용: node netlify/functions/_shared/__tests__/sprint-5-basics.test.js

process.env.COUPANG_VERIFY_MOCK = 'true';
process.env.NAVER_VERIFY_MOCK = 'true';
process.env.SIGNUP_MOCK = 'true';
process.env.JWT_SECRET = 'test-jwt-secret-min-32-characters-long-padding';

const path = require('path');
const assert = require('assert');

const tests = [];
function t(name, fn) { tests.push({ name, fn }); }

const coupangOrders = require(path.resolve(__dirname, '..', 'market-adapters', 'coupang-orders-adapter'));
const naverOrders = require(path.resolve(__dirname, '..', 'market-adapters', 'naver-orders-adapter'));
const sellerJwt = require(path.resolve(__dirname, '..', 'seller-jwt'));
const throttle = require(path.resolve(__dirname, '..', 'throttle'));

// =========================================================================
// 1. 어댑터 신규 함수 — coupang
// =========================================================================
t('coupang.syncInventory mock 모드 성공', async () => {
  const r = await coupangOrders.syncInventory({ market_product_id: 'M_1', quantity: 50, mock: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.quantity, 50);
  assert.strictEqual(r.mocked, true);
});

t('coupang.syncInventory 음수 거부', async () => {
  const r = await coupangOrders.syncInventory({ market_product_id: 'M_1', quantity: -1, mock: true });
  assert.strictEqual(r.ok, false);
  assert.ok(/0 이상/.test(r.error));
});

t('coupang.syncInventory 상품 ID 누락', async () => {
  const r = await coupangOrders.syncInventory({ quantity: 10, mock: true });
  assert.strictEqual(r.ok, false);
  assert.ok(/상품/.test(r.error));
});

t('coupang.updatePrice mock 모드 성공', async () => {
  const r = await coupangOrders.updatePrice({ market_product_id: 'M_1', price: 19900, mock: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.price, 19900);
});

t('coupang.updatePrice 음수 가격 거부', async () => {
  const r = await coupangOrders.updatePrice({ market_product_id: 'M_1', price: -100, mock: true });
  assert.strictEqual(r.ok, false);
});

t('coupang.updateProduct fields 검증', async () => {
  const r = await coupangOrders.updateProduct({ market_product_id: 'M_1', fields: { title: '새 제목' }, mock: true });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.fields_updated, ['title']);
});

t('coupang.updateProduct 빈 fields 거부', async () => {
  const r = await coupangOrders.updateProduct({ market_product_id: 'M_1', fields: {}, mock: true });
  assert.strictEqual(r.ok, false);
});

t('coupang.processRefund mock 모드 성공', async () => {
  const r = await coupangOrders.processRefund({ market_order_id: 'CP_1', reason: '단순 변심', type: 'refund', mock: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.type, 'refund');
  assert.ok(r.refund_id.startsWith('CP_REF_'));
});

t('coupang.processRefund market_order_id 누락', async () => {
  const r = await coupangOrders.processRefund({ reason: 'x', type: 'refund', mock: true });
  assert.strictEqual(r.ok, false);
});

// =========================================================================
// 2. 어댑터 신규 함수 — naver
// =========================================================================
t('naver.syncInventory mock 모드', async () => {
  const r = await naverOrders.syncInventory({ market_product_id: 'NV_1', quantity: 30, mock: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.quantity, 30);
});

t('naver.updatePrice mock 모드', async () => {
  const r = await naverOrders.updatePrice({ market_product_id: 'NV_1', price: 25000, mock: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.price, 25000);
});

t('naver.updateProduct fields 변경', async () => {
  const r = await naverOrders.updateProduct({ market_product_id: 'NV_1', fields: { price: 12000 }, mock: true });
  assert.strictEqual(r.ok, true);
});

t('naver.processRefund mock 모드', async () => {
  const r = await naverOrders.processRefund({ market_order_id: 'NV_1', reason: '교환', type: 'exchange', mock: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.type, 'exchange');
});

// =========================================================================
// 3. bulk-update-price — computeNewPrice 헬퍼 (handler 검증)
// =========================================================================
const bulkUpdatePriceHandler = require(path.resolve(__dirname, '..', '..', 'bulk-update-price.js')).handler;
const syncInventoryHandler = require(path.resolve(__dirname, '..', '..', 'sync-inventory.js')).handler;
const updateProductHandler = require(path.resolve(__dirname, '..', '..', 'update-product.js')).handler;
const refundProcessHandler = require(path.resolve(__dirname, '..', '..', 'refund-process.js')).handler;

function makeAuthHeader(sellerId) {
  const token = sellerJwt.signSellerToken({ seller_id: sellerId });
  return { authorization: `Bearer ${token}` };
}

function makeEvent({ method = 'POST', body = {}, sellerId = '00000000-0000-0000-0000-000000000001', auth = true } = {}) {
  return {
    httpMethod: method,
    headers: auth ? makeAuthHeader(sellerId) : {},
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

// 401 인증 실패
t('sync-inventory 401 인증 없음', async () => {
  const res = await syncInventoryHandler(makeEvent({ auth: false, body: { productId: 'p1', absolute: 10 } }));
  assert.strictEqual(res.statusCode, 401);
});

t('sync-inventory 400 productId 누락', async () => {
  const res = await syncInventoryHandler(makeEvent({ body: { absolute: 10 } }));
  assert.strictEqual(res.statusCode, 400);
});

t('sync-inventory 400 delta·absolute 둘 다 없음', async () => {
  const res = await syncInventoryHandler(makeEvent({ body: { productId: 'p1' } }));
  assert.strictEqual(res.statusCode, 400);
});

t('sync-inventory 400 delta·absolute 동시 지정', async () => {
  const res = await syncInventoryHandler(makeEvent({ body: { productId: 'p1', delta: 5, absolute: 10 } }));
  assert.strictEqual(res.statusCode, 400);
});

t('sync-inventory 200 mock absolute', async () => {
  const res = await syncInventoryHandler(makeEvent({ body: { productId: 'p1', absolute: 100, marketplaces: ['coupang', 'naver'] } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.strictEqual(json.mode, 'absolute');
  assert.strictEqual(json.absolute, 100);
});

t('sync-inventory 200 mock delta-only', async () => {
  const res = await syncInventoryHandler(makeEvent({ body: { productId: 'p1', delta: -5 } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.strictEqual(json.mode, 'delta');
  assert.strictEqual(json.delta, -5);
});

// bulk-update-price
t('bulk-update-price 401 인증', async () => {
  const res = await bulkUpdatePriceHandler(makeEvent({ auth: false, body: { productIds: ['p1'], operation: 'set', value: 1000 } }));
  assert.strictEqual(res.statusCode, 401);
});

t('bulk-update-price 400 invalid operation', async () => {
  const res = await bulkUpdatePriceHandler(makeEvent({ body: { productIds: ['p1'], operation: 'invalid', value: 1000 } }));
  assert.strictEqual(res.statusCode, 400);
});

t('bulk-update-price 400 productIds 비어있음', async () => {
  const res = await bulkUpdatePriceHandler(makeEvent({ body: { productIds: [], operation: 'set', value: 1000 } }));
  assert.strictEqual(res.statusCode, 400);
});

t('bulk-update-price 400 200개 초과', async () => {
  const ids = Array.from({ length: 201 }, (_, i) => `p${i}`);
  const res = await bulkUpdatePriceHandler(makeEvent({ body: { productIds: ids, operation: 'set', value: 1000 } }));
  assert.strictEqual(res.statusCode, 400);
});

t('bulk-update-price 200 mock set 성공', async () => {
  const res = await bulkUpdatePriceHandler(makeEvent({ body: { productIds: ['p1', 'p2'], operation: 'set', value: 19900, marketplaces: ['coupang'] } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.strictEqual(json.operation, 'set');
  assert.strictEqual(json.results.length, 2);
});

t('bulk-update-price 200 mock multiply 1.1배', async () => {
  const res = await bulkUpdatePriceHandler(makeEvent({ body: { productIds: ['p1'], operation: 'multiply', value: 1.1 } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.strictEqual(json.results[0].new_price, 11000); // 10000 * 1.1
});

t('bulk-update-price 200 add 음수 → 차감', async () => {
  const res = await bulkUpdatePriceHandler(makeEvent({ body: { productIds: ['p1'], operation: 'add', value: -2000 } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.strictEqual(json.results[0].new_price, 8000); // 10000 - 2000
});

t('bulk-update-price MIN_PRICE 가드 — 0원 set 거부', async () => {
  const res = await bulkUpdatePriceHandler(makeEvent({ body: { productIds: ['p1'], operation: 'set', value: 0 } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.strictEqual(json.results[0].skipped, true);
});

t('bulk-update-price MAX_PRICE 가드 — 100억 거부', async () => {
  const res = await bulkUpdatePriceHandler(makeEvent({ body: { productIds: ['p1'], operation: 'set', value: 99_999_999_999 } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.strictEqual(json.results[0].skipped, true);
});

// update-product
t('update-product 401 인증', async () => {
  const res = await updateProductHandler(makeEvent({ auth: false, body: { productId: 'p1', fields: { title: 'x' } } }));
  assert.strictEqual(res.statusCode, 401);
});

t('update-product 400 productId 누락', async () => {
  const res = await updateProductHandler(makeEvent({ body: { fields: { title: 'new' } } }));
  assert.strictEqual(res.statusCode, 400);
});

t('update-product 400 fields 비어있음', async () => {
  const res = await updateProductHandler(makeEvent({ body: { productId: 'p1', fields: {} } }));
  assert.strictEqual(res.statusCode, 400);
});

t('update-product 400 title 1자', async () => {
  const res = await updateProductHandler(makeEvent({ body: { productId: 'p1', fields: { title: 'a' } } }));
  assert.strictEqual(res.statusCode, 400);
});

t('update-product 400 price 음수', async () => {
  const res = await updateProductHandler(makeEvent({ body: { productId: 'p1', fields: { price: -100 } } }));
  assert.strictEqual(res.statusCode, 400);
});

t('update-product 400 keywords 21개', async () => {
  const kws = Array.from({ length: 21 }, (_, i) => `kw${i}`);
  const res = await updateProductHandler(makeEvent({ body: { productId: 'p1', fields: { keywords: kws } } }));
  assert.strictEqual(res.statusCode, 400);
});

t('update-product 200 mock 성공', async () => {
  const res = await updateProductHandler(makeEvent({ body: { productId: 'p1', fields: { title: '새 제목', price: 25000 }, marketplaces: ['coupang'] } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.deepStrictEqual(json.fields_changed.sort(), ['price', 'title']);
});

t('update-product 화이트리스트 외 필드 무시', async () => {
  const res = await updateProductHandler(makeEvent({ body: { productId: 'p1', fields: { __admin: 'hack', random_field: 'x' } } }));
  assert.strictEqual(res.statusCode, 400);
});

t('update-product 정책 단어 워닝 반환', async () => {
  const res = await updateProductHandler(makeEvent({ body: { productId: 'p1', fields: { title: '최고급 프리미엄 상품' } } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.ok(Array.isArray(json.policy_warnings));
  assert.ok(json.policy_warnings.length >= 1);
});

// refund-process
t('refund-process 401 인증', async () => {
  const res = await refundProcessHandler(makeEvent({ auth: false, body: { orderId: 'o1', reason: 'x' } }));
  assert.strictEqual(res.statusCode, 401);
});

t('refund-process 400 orderId 누락', async () => {
  const res = await refundProcessHandler(makeEvent({ body: { reason: 'x' } }));
  assert.strictEqual(res.statusCode, 400);
});

t('refund-process preview (confirm 없음)', async () => {
  const res = await refundProcessHandler(makeEvent({ body: { orderId: 'o1', reason: '단순 변심', type: 'refund' } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.strictEqual(json.preview, true);
  assert.strictEqual(json.confirmRequired, true);
  assert.ok(json.message.length > 10);
});

t('refund-process confirm=true mock 성공 (refund)', async () => {
  const res = await refundProcessHandler(makeEvent({ body: { orderId: 'o1', reason: '단순 변심', type: 'refund', confirm: true } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.strictEqual(json.success, true);
  assert.strictEqual(json.type, 'refund');
});

t('refund-process confirm=true exchange 성공', async () => {
  const res = await refundProcessHandler(makeEvent({ body: { orderId: 'o1', reason: '사이즈 교환', type: 'exchange', confirm: true } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.strictEqual(json.type, 'exchange');
});

t('refund-process invalid type → refund fallback', async () => {
  const res = await refundProcessHandler(makeEvent({ body: { orderId: 'o1', reason: 'x', type: 'invalid' } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.strictEqual(json.action, 'refund');
});

t('refund-process OPTIONS 204 CORS', async () => {
  const res = await refundProcessHandler({ httpMethod: 'OPTIONS', headers: {}, body: '' });
  assert.strictEqual(res.statusCode, 204);
});

t('refund-process 405 GET 거부', async () => {
  const res = await refundProcessHandler({ httpMethod: 'GET', headers: makeAuthHeader('s1'), body: '' });
  assert.strictEqual(res.statusCode, 405);
});

// =========================================================================
// 실행
// =========================================================================
(async () => {
  let pass = 0, fail = 0;
  for (const test of tests) {
    try {
      throttle._reset();
      await test.fn();
      pass += 1;
      console.log(`[PASS] ${test.name}`);
    } catch (e) {
      fail += 1;
      console.error(`[FAIL] ${test.name}: ${e.message}`);
    }
  }
  console.log(`\n총 ${pass + fail} — ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
})();
