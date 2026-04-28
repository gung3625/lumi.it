// profit-calculator.js — Sprint 4 통장 남는 돈 계산
// 메모리 project_phase1_strategic_differentiation.md 11단계 (Profit Analytics)
// 자동 차감: 마켓 수수료 / 광고비 / 포장재 / 송장비 / 결제 수수료 / 부가세

/**
 * 마켓별 카테고리 수수료 (시스템 default — DB 룩업 실패 시 fallback)
 */
const DEFAULT_MARKET_FEES = {
  coupang: 10.80,
  naver: 5.50,
  toss: 8.00,
};

/**
 * 단일 주문에 대한 Profit 계산
 * @param {Object} order — { total_price, market, quantity }
 * @param {Object} costSettings — seller_cost_settings row
 * @param {Map} marketFeeMap — Map<`${market}:${category}`, fee_ratio>
 */
function calculateOrderProfit(order, costSettings, marketFeeMap) {
  const grossRevenue = Number(order.total_price || 0);
  const quantity = Number(order.quantity || 1);
  const market = order.market;
  const categoryKey = order.category_key || 'default';

  // 마켓 수수료 (default 또는 카테고리별)
  const lookupKey = `${market}:${categoryKey}`;
  const fallbackKey = `${market}:default`;
  let marketFeeRatio;
  if (marketFeeMap && marketFeeMap.has(lookupKey)) {
    marketFeeRatio = marketFeeMap.get(lookupKey);
  } else if (marketFeeMap && marketFeeMap.has(fallbackKey)) {
    marketFeeRatio = marketFeeMap.get(fallbackKey);
  } else {
    marketFeeRatio = DEFAULT_MARKET_FEES[market] || 10.0;
  }

  // 셀러 override 확인 (market_fee_overrides JSONB)
  const overrides = costSettings?.market_fee_overrides || {};
  if (overrides[market] !== undefined) {
    marketFeeRatio = Number(overrides[market]);
  }

  const marketFee = Math.round(grossRevenue * (marketFeeRatio / 100));

  // 광고비 (셀러 입력 비율)
  const adSpend = Math.round(grossRevenue * (Number(costSettings?.ad_spend_ratio || 0) / 100));

  // 포장재 + 송장비 (수량 × 단가)
  const packagingCost = Number(costSettings?.packaging_cost_per_unit || 500) * quantity;
  const shippingCost = Number(costSettings?.shipping_cost_per_unit || 3000) * quantity;

  // 결제 수수료
  const paymentFee = Math.round(grossRevenue * (Number(costSettings?.payment_fee_ratio || 3.30) / 100));

  // 부가세 (10%)
  const vat = costSettings?.vat_applicable === false ? 0 : Math.round(grossRevenue / 11);

  // 통장 남는 돈
  const totalDeduction = marketFee + adSpend + packagingCost + shippingCost + paymentFee + vat;
  const netProfit = grossRevenue - totalDeduction;
  const profitMargin = grossRevenue > 0 ? (netProfit / grossRevenue) * 100 : 0;

  return {
    grossRevenue,
    marketFee,
    adSpend,
    packagingCost,
    shippingCost,
    paymentFee,
    vat,
    totalDeduction,
    netProfit,
    profitMargin: Math.round(profitMargin * 100) / 100,
    breakdown: {
      market_fee_pct: marketFeeRatio,
      ad_spend_pct: Number(costSettings?.ad_spend_ratio || 0),
      payment_fee_pct: Number(costSettings?.payment_fee_ratio || 3.30),
    },
  };
}

/**
 * 기간 합산 Profit 계산
 * @param {Array} orders
 * @param {Object} costSettings
 * @param {Map} marketFeeMap
 */
function calculatePeriodProfit(orders, costSettings, marketFeeMap) {
  const totals = {
    grossRevenue: 0,
    marketFees: 0,
    adSpend: 0,
    packagingCost: 0,
    shippingCost: 0,
    paymentFees: 0,
    vat: 0,
    netProfit: 0,
    orderCount: 0,
    unitsSold: 0,
  };

  for (const order of orders || []) {
    const p = calculateOrderProfit(order, costSettings, marketFeeMap);
    totals.grossRevenue += p.grossRevenue;
    totals.marketFees += p.marketFee;
    totals.adSpend += p.adSpend;
    totals.packagingCost += p.packagingCost;
    totals.shippingCost += p.shippingCost;
    totals.paymentFees += p.paymentFee;
    totals.vat += p.vat;
    totals.netProfit += p.netProfit;
    totals.orderCount += 1;
    totals.unitsSold += Number(order.quantity || 1);
  }

  totals.profitMargin = totals.grossRevenue > 0
    ? Math.round((totals.netProfit / totals.grossRevenue) * 10000) / 100
    : 0;

  return totals;
}

/**
 * 마켓 수수료 룩업 Map 생성 (DB 조회 결과 → Map)
 */
function buildMarketFeeMap(rows) {
  const map = new Map();
  for (const r of rows || []) {
    map.set(`${r.market}:${r.category_key}`, Number(r.fee_ratio));
  }
  return map;
}

/**
 * delta % 계산 (전 기간 대비)
 */
function calculateDelta(current, previous) {
  if (!previous || previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 10000) / 100;
}

/**
 * Profit 카드 친절한 메시지 (메모리 proactive_ux_paradigm)
 */
function buildProfitMessage(totals, deltaPct) {
  const pretty = totals.netProfit.toLocaleString('ko-KR');
  let trend = '';
  if (deltaPct !== null) {
    if (deltaPct > 0) trend = ` (지난 주 대비 +${deltaPct}%)`;
    else if (deltaPct < 0) trend = ` (지난 주 대비 ${deltaPct}%)`;
  }
  return `이번 주 통장에 남는 돈 ₩${pretty}${trend}`;
}

module.exports = {
  calculateOrderProfit,
  calculatePeriodProfit,
  buildMarketFeeMap,
  calculateDelta,
  buildProfitMessage,
  DEFAULT_MARKET_FEES,
};
