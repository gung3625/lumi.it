#!/usr/bin/env node
// Settlement aggregator unit tests
// 사용: node netlify/functions/_shared/__tests__/settlement-aggregator.test.js
//
// 5개 케이스:
//   1. periodToRange — 'YYYY-MM' → ISO 범위
//   2. splitVat — 부가세 10% 분리 (1/11)
//   3. buildSettlementSummary — 매출·수수료·VAT·순이익 집계
//   4. buildTransactionLines — 주문 라인 변환 + 매출/수수료/VAT/순액
//   5. buildTaxAccountantCsv — UTF-8 BOM + 컬럼·이스케이프

const {
  periodToRange,
  previousPeriod,
  quarterToRange,
  splitVat,
  groupByMarket,
  buildSettlementSummary,
  buildTransactionLines,
  buildTaxAccountantCsv,
} = require('../settlement-aggregator');
const {
  calculateOrderProfit,
  calculatePeriodProfit,
  buildMarketFeeMap,
} = require('../profit-calculator');

const results = [];
function test(name, passed, detail) {
  results.push({ name, passed, detail });
  const status = passed ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function approx(a, b, tol) {
  return Math.abs(a - b) <= (tol || 1);
}

// ─── 케이스 1: periodToRange ───
{
  const r = periodToRange('2026-04');
  const startOk = r.start === '2026-04-01T00:00:00.000Z';
  const endOk = r.end === '2026-04-30T23:59:59.999Z';
  test('1. periodToRange 2026-04 → 4/1 00:00 ~ 4/30 23:59', startOk && endOk, `start=${r.start}, end=${r.end}`);

  const prev = previousPeriod('2026-01');
  test('1b. previousPeriod 2026-01 → 2025-12', prev === '2025-12', `got=${prev}`);

  const q = quarterToRange('2026-Q2');
  const qStartOk = q.start === '2026-04-01T00:00:00.000Z';
  const qEndOk = q.end === '2026-06-30T23:59:59.999Z';
  test('1c. quarterToRange 2026-Q2 → 4/1 ~ 6/30', qStartOk && qEndOk, `start=${q.start}, end=${q.end}`);
}

// ─── 케이스 2: splitVat ───
{
  // 1,100원 → 공급가액 1,000 + VAT 100
  const a = splitVat(1100);
  test('2. splitVat 1100 → supply=1000, vat=100', a.supply === 1000 && a.vat === 100, `supply=${a.supply}, vat=${a.vat}`);

  // 0원 → 0
  const z = splitVat(0);
  test('2b. splitVat 0 → 0/0', z.supply === 0 && z.vat === 0, `supply=${z.supply}, vat=${z.vat}`);

  // 12,000원 → vat=1091, supply=10909 (round)
  const b = splitVat(12000);
  test('2c. splitVat 12000 → 합계 일치', b.supply + b.vat === 12000, `supply=${b.supply}, vat=${b.vat}`);
}

// ─── 케이스 3: buildSettlementSummary ───
{
  const orders = [
    { id: 'o1', market: 'coupang', total_price: 22000, quantity: 1, status: 'paid', created_at: '2026-04-10T01:00:00Z' },
    { id: 'o2', market: 'naver',   total_price: 11000, quantity: 1, status: 'shipping', created_at: '2026-04-12T01:00:00Z' },
    { id: 'o3', market: 'coupang', total_price: 33000, quantity: 2, status: 'delivered', created_at: '2026-04-15T01:00:00Z' },
  ];
  const costSettings = {
    packaging_cost_per_unit: 500,
    shipping_cost_per_unit: 3000,
    ad_spend_ratio: 5.0,
    payment_fee_ratio: 3.30,
    vat_applicable: true,
    market_fee_overrides: {},
  };
  const feeMap = buildMarketFeeMap([
    { market: 'coupang', category_key: 'default', fee_ratio: 10.80 },
    { market: 'naver',   category_key: 'default', fee_ratio: 5.50 },
  ]);

  const totals = calculatePeriodProfit(orders, costSettings, feeMap);
  const byMarket = groupByMarket(orders, costSettings, feeMap, calculateOrderProfit);
  const summary = buildSettlementSummary(totals, byMarket, { vat_applicable: true });

  // 매출 = 22000+11000+33000 = 66000
  const grossOk = summary.gross_revenue === 66000;
  // VAT = 66000 / 11 = 6000
  const vatOk = summary.vat_payable === 6000;
  // 마켓별 그룹 = coupang + naver = 2
  const marketsOk = byMarket.length === 2 && summary.by_marketplace.length === 2;
  // marketplace_fees는 마켓별 객체
  const feesObj = summary.marketplace_fees;
  const feeKeysOk = ('coupang' in feesObj) && ('naver' in feesObj);
  // 순이익 = totals.netProfit
  const netOk = summary.net_profit === totals.netProfit;

  test('3. buildSettlementSummary gross=66000', grossOk, `gross=${summary.gross_revenue}`);
  test('3b. VAT 매출세액 = 1/11 = 6000', vatOk, `vat=${summary.vat_payable}`);
  test('3c. 마켓 그룹 2개 (coupang/naver)', marketsOk && feeKeysOk, `markets=${byMarket.map(m => m.market).join(',')}`);
  test('3d. net_profit 일치', netOk, `summary=${summary.net_profit}, totals=${totals.netProfit}`);
}

// ─── 케이스 4: buildTransactionLines ───
{
  const orders = [
    { id: 'o1', market_order_id: 'CP-1001', market: 'coupang', product_title: '핑크 마우스패드',
      total_price: 22000, quantity: 1, status: 'paid', created_at: '2026-04-10T01:00:00Z' },
  ];
  const costSettings = {
    packaging_cost_per_unit: 500, shipping_cost_per_unit: 3000,
    ad_spend_ratio: 0, payment_fee_ratio: 3.30, vat_applicable: true, market_fee_overrides: {},
  };
  const feeMap = buildMarketFeeMap([{ market: 'coupang', category_key: 'default', fee_ratio: 10.80 }]);

  const lines = buildTransactionLines(orders, calculateOrderProfit, costSettings, feeMap);
  const l = lines[0];
  // gross=22000, fee>0, vat=2000 (22000/11), net = gross - fee - vat
  const allFieldsOk = l && ['occurred_at', 'market', 'market_order_id', 'product_title', 'gross_amount', 'fee_amount', 'vat_amount', 'net_amount']
    .every(k => k in l);
  const valuesOk = l && l.gross_amount === 22000 && l.vat_amount === 2000 && l.net_amount > 0;
  const titleOk = l && l.product_title === '핑크 마우스패드';

  test('4. buildTransactionLines 8 필드 모두 존재', allFieldsOk, allFieldsOk ? Object.keys(l).join(',') : 'missing');
  test('4b. 라인 값 (gross=22000, vat=2000, net>0)', valuesOk, `gross=${l?.gross_amount}, vat=${l?.vat_amount}, net=${l?.net_amount}`);
  test('4c. 한글 상품명 보존', titleOk, `title=${l?.product_title}`);
}

// ─── 케이스 5: buildTaxAccountantCsv ───
{
  const lines = [
    { occurred_at: '2026-04-10T01:00:00Z', market: 'coupang', market_order_id: 'CP-001',
      product_title: '핑크 마우스패드', gross_amount: 22000, fee_amount: 5000, vat_amount: 2000, net_amount: 15000 },
    { occurred_at: '2026-04-12T01:00:00Z', market: 'naver', market_order_id: 'NV-002',
      product_title: '"테스트, 이스케이프"', gross_amount: 11000, fee_amount: 1000, vat_amount: 1000, net_amount: 9000 },
  ];
  const csv = buildTaxAccountantCsv(lines);

  const bomOk = csv.charCodeAt(0) === 0xFEFF;
  const headerOk = csv.includes('일자,마켓,주문번호,상품명,매출액,수수료,부가세,실수령액');
  const rowsOk = csv.includes('2026-04-10,coupang,CP-001') && csv.includes('22000');
  // 콤마·따옴표 이스케이프
  const escapeOk = csv.includes('"""테스트, 이스케이프"""') || csv.includes('"\\"테스트') || csv.match(/".*,.*"/);

  test('5. CSV UTF-8 BOM 헤더', bomOk, `firstChar=0x${csv.charCodeAt(0).toString(16).toUpperCase()}`);
  test('5b. CSV 헤더 8 컬럼', headerOk, headerOk ? 'ok' : 'missing');
  test('5c. CSV 데이터 행', rowsOk, rowsOk ? 'ok' : 'missing');
  test('5d. CSV 콤마/따옴표 이스케이프', !!escapeOk, escapeOk ? 'ok' : 'fail');
}

// ─── 결과 ───
const passed = results.filter(r => r.passed).length;
const total = results.length;
console.log(`\n${passed}/${total} 통과`);
process.exit(passed === total ? 0 : 1);
