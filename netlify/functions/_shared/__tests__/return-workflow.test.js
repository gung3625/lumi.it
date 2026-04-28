// 반품 워크플로우 단위 테스트
// - 4 마켓 어댑터 × 4 케이스 (16 PASS) — coupang/naver/toss processReturn
// - return-workflow 헬퍼 (위험 임계값, 상태 전이)
// - return-process / return-request-list / return-history 핸들러 (mock)
//
// 사용: node netlify/functions/_shared/__tests__/return-workflow.test.js

process.env.COUPANG_VERIFY_MOCK = 'true';
process.env.NAVER_VERIFY_MOCK = 'true';
process.env.TOSS_VERIFY_MOCK = 'true';
process.env.SIGNUP_MOCK = 'true';
process.env.JWT_SECRET = 'test-jwt-secret-min-32-characters-long-padding';

const path = require('path');
const assert = require('assert');

const tests = [];
function t(name, fn) { tests.push({ name, fn }); }

const coupangOrders = require(path.resolve(__dirname, '..', 'market-adapters', 'coupang-orders-adapter'));
const naverOrders = require(path.resolve(__dirname, '..', 'market-adapters', 'naver-orders-adapter'));
const tossOrders = require(path.resolve(__dirname, '..', 'market-adapters', 'toss-orders-adapter'));
const workflow = require(path.resolve(__dirname, '..', 'return-workflow'));
const sellerJwt = require(path.resolve(__dirname, '..', 'seller-jwt'));
const throttle = require(path.resolve(__dirname, '..', 'throttle'));

const returnProcessHandler = require(path.resolve(__dirname, '..', '..', 'return-process.js')).handler;
const returnListHandler = require(path.resolve(__dirname, '..', '..', 'return-request-list.js')).handler;
const returnHistoryHandler = require(path.resolve(__dirname, '..', '..', 'return-history.js')).handler;

function makeAuthHeader(sellerId) {
  const token = sellerJwt.signSellerToken({ seller_id: sellerId });
  return { authorization: `Bearer ${token}` };
}

function makeEvent({ method = 'POST', body = {}, query = null, sellerId = '00000000-0000-0000-0000-000000000001', auth = true } = {}) {
  return {
    httpMethod: method,
    headers: auth ? makeAuthHeader(sellerId) : {},
    body: typeof body === 'string' ? body : JSON.stringify(body),
    queryStringParameters: query,
  };
}

// =========================================================================
// 1. 마켓 어댑터 × 케이스 — 4 케이스 × 3 마켓 = 12 + 4 검증 = 16
// =========================================================================

// --- Coupang ---
t('coupang.processReturn refund 모킹', async () => {
  const r = await coupangOrders.processReturn({ market_order_id: 'CP_1', reason: '단순 변심', type: 'refund', mock: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.type, 'refund');
  assert.ok(r.refund_id.startsWith('CP_RET_'));
});

t('coupang.processReturn exchange 모킹', async () => {
  const r = await coupangOrders.processReturn({ market_order_id: 'CP_2', reason: '사이즈', type: 'exchange', mock: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.type, 'exchange');
});

t('coupang.processReturn partial_refund 모킹', async () => {
  const r = await coupangOrders.processReturn({ market_order_id: 'CP_3', reason: '하자', type: 'partial_refund', amount: 5000, mock: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.type, 'partial_refund');
  assert.strictEqual(r.amount, 5000);
});

t('coupang.processReturn partial_refund 0원 거부', async () => {
  const r = await coupangOrders.processReturn({ market_order_id: 'CP_4', type: 'partial_refund', amount: 0, mock: true });
  assert.strictEqual(r.ok, false);
  assert.ok(/0원/.test(r.error));
});

// --- Naver ---
t('naver.processReturn refund 모킹', async () => {
  const r = await naverOrders.processReturn({ market_order_id: 'NV_1', reason: '단순 변심', type: 'refund', mock: true });
  assert.strictEqual(r.ok, true);
  assert.ok(r.refund_id.startsWith('NV_RET_'));
});

t('naver.processReturn exchange 모킹', async () => {
  const r = await naverOrders.processReturn({ market_order_id: 'NV_2', reason: '교환', type: 'exchange', mock: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.type, 'exchange');
});

t('naver.processReturn partial_refund 모킹', async () => {
  const r = await naverOrders.processReturn({ market_order_id: 'NV_3', reason: '부분', type: 'partial_refund', amount: 3000, mock: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.type, 'partial_refund');
});

t('naver.processReturn order_id 누락', async () => {
  const r = await naverOrders.processReturn({ type: 'refund', mock: true });
  assert.strictEqual(r.ok, false);
});

// --- Toss ---
t('toss.processReturn refund 모킹', async () => {
  const r = await tossOrders.processReturn({ market_order_id: 'TOSS_1', reason: '단순 변심', type: 'refund', mock: true });
  assert.strictEqual(r.ok, true);
  assert.ok(r.refund_id.startsWith('TOSS_RET_'));
});

t('toss.processReturn exchange 모킹', async () => {
  const r = await tossOrders.processReturn({ market_order_id: 'TOSS_2', type: 'exchange', mock: true });
  assert.strictEqual(r.ok, true);
});

t('toss.processReturn partial_refund 모킹', async () => {
  const r = await tossOrders.processReturn({ market_order_id: 'TOSS_3', type: 'partial_refund', amount: 7000, mock: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.amount, 7000);
});

t('toss.processReturn invalid type → refund fallback', async () => {
  const r = await tossOrders.processReturn({ market_order_id: 'TOSS_4', type: 'invalid', mock: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.type, 'refund');
});

// =========================================================================
// 2. workflow 헬퍼 — 위험 임계값
// =========================================================================
t('evaluateRisk partial_refund = 항상 위험', () => {
  const r = workflow.evaluateRisk({ requestType: 'partial_refund', totalPrice: 10000 });
  assert.strictEqual(r.isHighRisk, true);
  assert.ok(r.riskReason.includes('부분환불'));
});

t('evaluateRisk ₩100,000+ 위험', () => {
  const r = workflow.evaluateRisk({ requestType: 'refund', totalPrice: 150000 });
  assert.strictEqual(r.isHighRisk, true);
});

t('evaluateRisk ₩50,000 정상', () => {
  const r = workflow.evaluateRisk({ requestType: 'refund', totalPrice: 50000 });
  assert.strictEqual(r.isHighRisk, false);
  assert.strictEqual(r.riskReason, null);
});

t('buildPreviewResponse 환불 메시지', () => {
  const r = workflow.buildPreviewResponse({
    order: { id: 'o1', total_price: 39000, quantity: 1, market: 'coupang', market_order_id: 'CP_1' },
    type: 'refund',
    action: 'approve',
    reason: 'x',
    isHighRisk: false,
  });
  assert.strictEqual(r.preview, true);
  assert.ok(/환불 처리/.test(r.message));
});

// =========================================================================
// 3. return-process 핸들러
// =========================================================================
t('return-process 401 인증 없음', async () => {
  const res = await returnProcessHandler(makeEvent({ auth: false, body: { orderId: 'o1' } }));
  assert.strictEqual(res.statusCode, 401);
});

t('return-process 400 orderId/requestId 둘 다 누락', async () => {
  const res = await returnProcessHandler(makeEvent({ body: { requestType: 'refund' } }));
  assert.strictEqual(res.statusCode, 400);
});

t('return-process partial_refund amount 누락 400', async () => {
  const res = await returnProcessHandler(makeEvent({ body: { orderId: 'o1', requestType: 'partial_refund', action: 'approve' } }));
  assert.strictEqual(res.statusCode, 400);
});

t('return-process preview (confirm 없음) → 200 + preview=true', async () => {
  const res = await returnProcessHandler(makeEvent({ body: { orderId: 'o1', requestType: 'refund', action: 'approve', reason: 'x' } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.strictEqual(json.preview, true);
  assert.strictEqual(json.confirmRequired, true);
});

t('return-process pending action mock 등록', async () => {
  const res = await returnProcessHandler(makeEvent({ body: { orderId: 'o1', requestType: 'refund', action: 'pending', reason: 'x' } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.strictEqual(json.action, 'pending');
});

t('return-process reject preview', async () => {
  const res = await returnProcessHandler(makeEvent({ body: { orderId: 'o1', action: 'reject', reason: 'x' } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.strictEqual(json.preview, true);
});

t('return-process reject confirm=true', async () => {
  const res = await returnProcessHandler(makeEvent({ body: { orderId: 'o1', action: 'reject', reason: 'x', confirm: true, note: '거절 사유' } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.strictEqual(json.success, true);
  assert.strictEqual(json.action, 'reject');
});

t('return-process approve confirm=true (mock=10000원, low risk)', async () => {
  const res = await returnProcessHandler(makeEvent({ body: { orderId: 'o1', requestType: 'refund', action: 'approve', reason: 'x', confirm: true } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.strictEqual(json.success, true);
  assert.strictEqual(json.type, 'refund');
});

t('return-process partial_refund acknowledge 필수', async () => {
  // partial_refund = 항상 high_risk, acknowledgeRisk 없이 confirm=true 시 게이트
  const res = await returnProcessHandler(makeEvent({ body: { orderId: 'o1', requestType: 'partial_refund', amount: 5000, action: 'approve', confirm: true } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.strictEqual(json.confirmRequired, true);
  assert.strictEqual(json.isHighRisk, true);
});

t('return-process partial_refund 통과 (acknowledgeRisk=true)', async () => {
  const res = await returnProcessHandler(makeEvent({ body: { orderId: 'o1', requestType: 'partial_refund', amount: 5000, action: 'approve', confirm: true, acknowledgeRisk: true, reason: '하자' } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.strictEqual(json.success, true);
  assert.strictEqual(json.type, 'partial_refund');
});

t('return-process exchange confirm=true', async () => {
  const res = await returnProcessHandler(makeEvent({ body: { orderId: 'o1', requestType: 'exchange', action: 'approve', reason: '사이즈', confirm: true } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.strictEqual(json.success, true);
  assert.strictEqual(json.type, 'exchange');
});

t('return-process OPTIONS 204 CORS', async () => {
  const res = await returnProcessHandler({ httpMethod: 'OPTIONS', headers: {}, body: '' });
  assert.strictEqual(res.statusCode, 204);
});

t('return-process 405 GET 거부', async () => {
  const res = await returnProcessHandler({ httpMethod: 'GET', headers: makeAuthHeader('s1'), body: '' });
  assert.strictEqual(res.statusCode, 405);
});

// =========================================================================
// 4. return-request-list 핸들러
// =========================================================================
t('return-request-list 401 인증', async () => {
  const res = await returnListHandler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} });
  assert.strictEqual(res.statusCode, 401);
});

t('return-request-list 200 mock pending', async () => {
  const res = await returnListHandler(makeEvent({ method: 'GET', query: { status: 'pending' } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.strictEqual(json.success, true);
  assert.ok(Array.isArray(json.requests));
  assert.ok(json.requests.length >= 1);
});

t('return-request-list 200 mock all', async () => {
  const res = await returnListHandler(makeEvent({ method: 'GET', query: { status: 'all' } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.ok(json.requests.length >= 1);
});

t('return-request-list invalid status → pending fallback', async () => {
  const res = await returnListHandler(makeEvent({ method: 'GET', query: { status: 'bogus' } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  // 모든 mock 데이터가 pending이므로 다 노출
  assert.ok(json.requests.every((r) => r.status === 'pending'));
});

t('return-request-list 405 POST 거부', async () => {
  const res = await returnListHandler({ httpMethod: 'POST', headers: makeAuthHeader('s1'), body: '' });
  assert.strictEqual(res.statusCode, 405);
});

// =========================================================================
// 5. return-history 핸들러
// =========================================================================
t('return-history 401 인증', async () => {
  const res = await returnHistoryHandler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} });
  assert.strictEqual(res.statusCode, 401);
});

t('return-history 200 mock all', async () => {
  const res = await returnHistoryHandler(makeEvent({ method: 'GET', query: { status: 'all' } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.ok(Array.isArray(json.history));
  assert.ok(json.summary);
});

t('return-history 200 mock completed 필터', async () => {
  const res = await returnHistoryHandler(makeEvent({ method: 'GET', query: { status: 'completed' } }));
  assert.strictEqual(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.ok(json.history.every((h) => h.status === 'completed'));
});

t('return-history 405 POST 거부', async () => {
  const res = await returnHistoryHandler({ httpMethod: 'POST', headers: makeAuthHeader('s1'), body: '' });
  assert.strictEqual(res.statusCode, 405);
});

// =========================================================================
// 실행
// =========================================================================
(async () => {
  let pass = 0, fail = 0;
  const failures = [];
  for (const test of tests) {
    try {
      throttle._reset && throttle._reset();
      await test.fn();
      pass += 1;
      console.log(`[PASS] ${test.name}`);
    } catch (e) {
      fail += 1;
      failures.push({ name: test.name, error: e.message });
      console.log(`[FAIL] ${test.name} — ${e.message}`);
    }
  }
  console.log(`\n총 ${tests.length} — ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) {
    console.log('\n실패 상세:');
    failures.forEach((f) => console.log(`  - ${f.name}: ${f.error}`));
    process.exit(1);
  }
})();
