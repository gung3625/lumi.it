// Sprint 4 단위 테스트 — Profit Calculator + Trend Matcher + Live Events + Sync Status
// 사용: node netlify/functions/_shared/__tests__/sprint-4-dashboard-trend.test.js
process.env.TREND_RECO_MOCK = 'true';

const path = require('path');

const tests = [];
function t(name, fn) { tests.push({ name, fn }); }
function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg || ''} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
  }
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function approx(a, b, tol, msg) { if (Math.abs(a - b) > (tol || 1)) throw new Error(`${msg || ''} expected ${b}±${tol}, got ${a}`); }

const profit = require(path.resolve(__dirname, '..', 'profit-calculator'));
const matcher = require(path.resolve(__dirname, '..', 'trend-matcher'));
const liveEv = require(path.resolve(__dirname, '..', 'live-events'));
const sync = require(path.resolve(__dirname, '..', 'sync-status'));

// =========================================================================
// 1. Profit Calculator (12 tests)
// =========================================================================
const defaultCost = {
  packaging_cost_per_unit: 500,
  shipping_cost_per_unit: 3000,
  ad_spend_ratio: 5.0,        // 5%
  payment_fee_ratio: 3.30,
  vat_applicable: true,
  market_fee_overrides: {},
};
const feeMap = profit.buildMarketFeeMap([
  { market: 'coupang', category_key: 'default', fee_ratio: 10.80 },
  { market: 'naver', category_key: 'default', fee_ratio: 5.50 },
  { market: 'toss', category_key: 'default', fee_ratio: 8.00 },
]);

t('profit.buildMarketFeeMap 3개', () => eq(feeMap.size, 3));

t('profit.calculateOrderProfit 쿠팡 ₩30,000 1개', () => {
  const r = profit.calculateOrderProfit(
    { total_price: 30000, quantity: 1, market: 'coupang' },
    defaultCost, feeMap
  );
  // 마켓수수료 = 30000 * 10.8% = 3240
  // 광고비 = 30000 * 5% = 1500
  // 포장 = 500, 송장 = 3000
  // 결제수수료 = 30000 * 3.3% = 990
  // 부가세 = 30000 / 11 = 2727
  // 합계 = 3240 + 1500 + 500 + 3000 + 990 + 2727 = 11957
  // net = 30000 - 11957 = 18043
  eq(r.marketFee, 3240);
  approx(r.adSpend, 1500, 1);
  eq(r.packagingCost, 500);
  eq(r.shippingCost, 3000);
  approx(r.paymentFee, 990, 1);
  approx(r.vat, 2727, 1);
  approx(r.netProfit, 18043, 5);
});

t('profit.calculateOrderProfit 네이버 ₩50,000 2개', () => {
  const r = profit.calculateOrderProfit(
    { total_price: 50000, quantity: 2, market: 'naver' },
    defaultCost, feeMap
  );
  approx(r.marketFee, 2750, 1);   // 50000 * 5.5%
  eq(r.packagingCost, 1000);       // 500 * 2
  eq(r.shippingCost, 6000);        // 3000 * 2
  ok(r.netProfit > 0);
});

t('profit.calculateOrderProfit override 적용', () => {
  const cost = { ...defaultCost, market_fee_overrides: { coupang: 7.0 } };
  const r = profit.calculateOrderProfit(
    { total_price: 10000, quantity: 1, market: 'coupang' },
    cost, feeMap
  );
  eq(r.marketFee, 700);  // override 7% 적용
});

t('profit.calculateOrderProfit vat 비활성', () => {
  const cost = { ...defaultCost, vat_applicable: false };
  const r = profit.calculateOrderProfit(
    { total_price: 11000, quantity: 1, market: 'naver' },
    cost, feeMap
  );
  eq(r.vat, 0);
});

t('profit.calculatePeriodProfit 합산 3건', () => {
  const orders = [
    { total_price: 10000, quantity: 1, market: 'coupang' },
    { total_price: 20000, quantity: 1, market: 'naver' },
    { total_price: 15000, quantity: 1, market: 'toss' },
  ];
  const r = profit.calculatePeriodProfit(orders, defaultCost, feeMap);
  eq(r.grossRevenue, 45000);
  eq(r.orderCount, 3);
  eq(r.unitsSold, 3);
  ok(r.netProfit > 0 && r.netProfit < 45000);
});

t('profit.calculatePeriodProfit 빈 배열', () => {
  const r = profit.calculatePeriodProfit([], defaultCost, feeMap);
  eq(r.netProfit, 0);
  eq(r.orderCount, 0);
});

t('profit.calculateDelta +20%', () => {
  const d = profit.calculateDelta(120000, 100000);
  eq(d, 20);
});

t('profit.calculateDelta -10%', () => {
  const d = profit.calculateDelta(90000, 100000);
  eq(d, -10);
});

t('profit.calculateDelta null when prev=0', () => {
  eq(profit.calculateDelta(50000, 0), null);
});

t('profit.buildProfitMessage 양수 delta', () => {
  const msg = profit.buildProfitMessage({ netProfit: 250000 }, 15);
  ok(msg.includes('+15%'));
  ok(msg.includes('250,000'));
});

t('profit.buildProfitMessage 음수 delta', () => {
  const msg = profit.buildProfitMessage({ netProfit: 150000 }, -8);
  ok(msg.includes('-8%'));
});

t('profit.buildProfitMessage null delta', () => {
  const msg = profit.buildProfitMessage({ netProfit: 100000 }, null);
  ok(!msg.includes('대비'));
});

// =========================================================================
// 2. Trend Matcher (10 tests)
// =========================================================================
const sellerProfile = {
  industry: 'fashion',
  productKeywords: ['원피스', '봄', '시폰'],
  dismissedKeywords: new Set(['옷']),
};

t('matcher.calculateMatchScore 카테고리 매칭', () => {
  const s = matcher.calculateMatchScore(
    { keyword: '봄 원피스', category: 'fashion', velocity_pct: 200, signal_tier: 'rising' },
    sellerProfile
  );
  ok(s >= 80, 'high score for matching category + velocity');
});

t('matcher.calculateMatchScore 거절 키워드 0', () => {
  const s = matcher.calculateMatchScore(
    { keyword: '옷', category: 'fashion', velocity_pct: 500 },
    sellerProfile
  );
  eq(s, 0);
});

t('matcher.calculateMatchScore 다른 카테고리 낮은 점수', () => {
  const s = matcher.calculateMatchScore(
    { keyword: '오마카세', category: 'food', velocity_pct: 50 },
    sellerProfile
  );
  ok(s < 30);
});

t('matcher.calculateMatchScore 시즌 가산점', () => {
  const s = matcher.calculateMatchScore(
    { keyword: '카네이션', category: 'flower', velocity_pct: 500, signal_tier: 'season' },
    { industry: 'florist', productKeywords: [], dismissedKeywords: new Set() }
  );
  ok(s >= 70);
});

t('matcher.estimateRevenue fashion velocity 200+', () => {
  const r = matcher.estimateRevenue({ category: 'fashion', velocity_pct: 250 });
  ok(r.min > 0 && r.max > r.min);
  ok(r.max > 25000);
});

t('matcher.matchTrendsToSeller limit + sort', () => {
  const trends = [
    { keyword: '봄 원피스', category: 'fashion', velocity_pct: 300, signal_tier: 'rising' },
    { keyword: '오마카세', category: 'food', velocity_pct: 100 },
    { keyword: '시폰 블라우스', category: 'fashion', velocity_pct: 180, signal_tier: 'rising' },
    { keyword: '옷', category: 'fashion', velocity_pct: 500 }, // dismissed
  ];
  const r = matcher.matchTrendsToSeller(trends, sellerProfile, { limit: 2, minScore: 30 });
  eq(r.length, 2);
  ok(r[0].match_score >= r[1].match_score);
  ok(!r.find(x => x.keyword === '옷'));
});

t('matcher.enrichWithSeasonEvents 추가', () => {
  const trends = [{ keyword: '꽃다발', category: 'flower', velocity_pct: 100 }];
  const events = [
    {
      event_name: '어버이날',
      event_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      alert_lead_days: 14,
      related_categories: ['flower'],
      related_keywords: ['카네이션'],
    },
  ];
  const r = matcher.enrichWithSeasonEvents(trends, events);
  ok(r.length >= 2);
  ok(r.find(x => x.keyword === '카네이션' && x.season_event === '어버이날'));
});

t('matcher.enrichWithSeasonEvents 기존 키워드 보강', () => {
  const trends = [{ keyword: '카네이션', category: 'flower', velocity_pct: 200 }];
  const events = [
    {
      event_name: '어버이날',
      event_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      alert_lead_days: 14,
      related_categories: ['flower'],
      related_keywords: ['카네이션'],
    },
  ];
  const r = matcher.enrichWithSeasonEvents(trends, events);
  eq(r.length, 1);
  eq(r[0].season_event, '어버이날');
});

t('matcher.buildTrendCardCta 시즌', () => {
  const cta = matcher.buildTrendCardCta({ season_event: '어버이날', velocity_pct: 250 });
  ok(cta.includes('시즌'));
});

t('matcher.buildTrendCardCta 일반', () => {
  const cta = matcher.buildTrendCardCta({ velocity_pct: 50 });
  ok(cta.includes('등록'));
});

// =========================================================================
// 3. Live Events (3 tests)
// =========================================================================
t('liveEv.SEVERITY_BY_TYPE 검증', () => {
  eq(liveEv.SEVERITY_BY_TYPE.new_order, 'success');
  eq(liveEv.SEVERITY_BY_TYPE.kill_switch_activated, 'critical');
  eq(liveEv.SEVERITY_BY_TYPE.stock_low, 'warning');
});

t('liveEv.ICON_BY_TYPE 매핑', () => {
  eq(liveEv.ICON_BY_TYPE.new_order, 'shopping-bag');
  eq(liveEv.ICON_BY_TYPE.trend_alert, 'flame');
});

t('liveEv.publishEvent guard', async () => {
  const r = await liveEv.publishEvent(null, null, null);
  eq(r.ok, false);
});

// =========================================================================
// 4. Sync Status (3 tests)
// =========================================================================
t('sync.buildHealthMessage healthy', () => {
  const m = sync.buildHealthMessage({
    health_status: 'healthy',
    last_synced_at: new Date(Date.now() - 5 * 60000).toISOString(),
  });
  eq(m.tone, 'ok');
  ok(m.text.includes('정상'));
});

t('sync.buildHealthMessage failing', () => {
  const m = sync.buildHealthMessage({ health_status: 'failing', last_synced_at: null });
  eq(m.tone, 'error');
  ok(m.text.includes('점검'));
});

t('sync.buildHealthMessage degraded warn', () => {
  const m = sync.buildHealthMessage({
    health_status: 'degraded',
    last_synced_at: new Date(Date.now() - 60000).toISOString(),
  });
  eq(m.tone, 'warn');
});

// =========================================================================
// 실행
// =========================================================================
(async () => {
  let pass = 0, fail = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      pass++;
    } catch (e) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${e.message}`);
      fail++;
    }
  }
  console.log('\n' + '═'.repeat(60));
  console.log(`  ${pass}/${tests.length} PASS, ${fail} FAIL`);
  console.log('═'.repeat(60));
  process.exit(fail === 0 ? 0 : 1);
})();
