// channel-roi.js — 채널별 ROI 분석 API
// 메모리 project_phase1_strategic_differentiation.md 4대 차별화 중 "수익 분석"
// 쿠팡·네이버·토스 채널별 주문수/매출/수수료/배송비/광고비/순이익/ROI
//
// GET /api/channel-roi?period=day|week|month

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { calculateOrderProfit, buildMarketFeeMap } = require('./_shared/profit-calculator');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const MARKET_LABELS = { coupang: '쿠팡', naver: '네이버', toss: '토스쇼핑' };
const VALID_PERIODS = ['day', 'week', 'month'];

function periodRange(period) {
  const now = new Date();
  const end = new Date(now);
  end.setUTCHours(23, 59, 59, 999);
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);

  if (period === 'month') {
    start.setUTCDate(start.getUTCDate() - 29);
  } else if (period === 'week') {
    start.setUTCDate(start.getUTCDate() - 6);
  }
  // 'day' = 오늘 00:00 ~ 23:59

  return { start: start.toISOString(), end: end.toISOString() };
}

async function fetchCostSettings(admin, sellerId) {
  try {
    const { data } = await admin
      .from('seller_cost_settings')
      .select('*')
      .eq('seller_id', sellerId)
      .maybeSingle();
    if (data) return data;
  } catch (e) {
    console.warn('[channel-roi] fetchCostSettings fallback:', e.message);
  }
  return {
    seller_id: sellerId,
    packaging_cost_per_unit: 500,
    shipping_cost_per_unit: 3000,
    ad_spend_ratio: 0.0,
    payment_fee_ratio: 3.30,
    vat_applicable: true,
    market_fee_overrides: {},
  };
}

async function fetchMarketFeeMap(admin) {
  try {
    const { data } = await admin
      .from('market_fee_table')
      .select('market, category_key, fee_ratio')
      .eq('active', true);
    return buildMarketFeeMap(data || []);
  } catch (e) {
    console.warn('[channel-roi] fetchMarketFeeMap fallback:', e.message);
    return new Map();
  }
}

async function fetchConnectedMarkets(admin, sellerId) {
  try {
    const { data } = await admin
      .from('market_connections')
      .select('market, status')
      .eq('seller_id', sellerId)
      .eq('status', 'connected');
    return (data || []).map((r) => r.market);
  } catch (e) {
    console.warn('[channel-roi] fetchConnectedMarkets fallback:', e.message);
    return [];
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error: jwtErr } = verifySellerToken(token);
  if (jwtErr) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: jwtErr }) };
  }
  const sellerId = payload.seller_id;

  const params = new URLSearchParams(event.rawQuery || '');
  const period = VALID_PERIODS.includes(params.get('period')) ? params.get('period') : 'week';

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase 초기화 실패' }) };
  }

  try {
    const range = periodRange(period);

    const [costSettings, marketFeeMap, connectedMarkets, ordersResult] = await Promise.all([
      fetchCostSettings(admin, sellerId),
      fetchMarketFeeMap(admin),
      fetchConnectedMarkets(admin, sellerId),
      admin
        .from('marketplace_orders')
        .select('id, market, total_price, quantity, status, created_at')
        .eq('seller_id', sellerId)
        .in('status', ['paid', 'shipping', 'delivered'])
        .gte('created_at', range.start)
        .lte('created_at', range.end),
    ]);

    const orders = ordersResult.data || [];
    const connectedSet = new Set(connectedMarkets);

    // 마켓별로 집계
    const marketMap = {};
    for (const o of orders) {
      const mkt = o.market;
      if (!marketMap[mkt]) {
        marketMap[mkt] = {
          orderCount: 0,
          revenue: 0,
          fees: 0,
          shippingCost: 0,
          adSpend: 0,
          packagingCost: 0,
          paymentFees: 0,
          vat: 0,
          profit: 0,
          totalInvestment: 0,
        };
      }
      const calc = calculateOrderProfit(o, costSettings, marketFeeMap);
      const m = marketMap[mkt];
      m.orderCount += 1;
      m.revenue += calc.grossRevenue;
      m.fees += calc.marketFee;
      m.shippingCost += calc.shippingCost;
      m.adSpend += calc.adSpend;
      m.packagingCost += calc.packagingCost;
      m.paymentFees += calc.paymentFee;
      m.vat += calc.vat;
      m.profit += calc.netProfit;
    }

    // 연결된 마켓 포함 보장 (주문 없어도 빈 채널 표시)
    for (const mkt of ['coupang', 'naver', 'toss']) {
      if (connectedSet.has(mkt) && !marketMap[mkt]) {
        marketMap[mkt] = {
          orderCount: 0, revenue: 0, fees: 0, shippingCost: 0,
          adSpend: 0, packagingCost: 0, paymentFees: 0, vat: 0,
          profit: 0, totalInvestment: 0,
        };
      }
    }

    const channels = Object.entries(marketMap).map(([market, m]) => {
      // ROI = 순이익 / (총 투자비용) × 100
      // 투자비용 = 수수료 + 배송비 + 광고비 + 포장비 + 결제수수료 + VAT
      const totalCost = m.fees + m.shippingCost + m.adSpend + m.packagingCost + m.paymentFees + m.vat;
      const roi = totalCost > 0 ? Math.round((m.profit / totalCost) * 100 * 10) / 10 : null;
      const profitMargin = m.revenue > 0 ? Math.round((m.profit / m.revenue) * 100 * 10) / 10 : null;

      return {
        market,
        name: MARKET_LABELS[market] || market,
        connected: connectedSet.has(market),
        orderCount: m.orderCount,
        revenue: Math.round(m.revenue),
        fees: Math.round(m.fees),
        shippingCost: Math.round(m.shippingCost),
        adSpend: Math.round(m.adSpend),
        profit: Math.round(m.profit),
        roi,                   // % (null if no data)
        profitMargin,          // % (null if no data)
        totalCost: Math.round(totalCost),
      };
    });

    // 정렬: 연결됨 우선, 매출 내림차순
    channels.sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      return b.revenue - a.revenue;
    });

    // 전체 합계
    const total = channels.reduce((acc, c) => ({
      orderCount: acc.orderCount + c.orderCount,
      revenue: acc.revenue + c.revenue,
      fees: acc.fees + c.fees,
      shippingCost: acc.shippingCost + c.shippingCost,
      adSpend: acc.adSpend + c.adSpend,
      profit: acc.profit + c.profit,
      totalCost: acc.totalCost + c.totalCost,
    }), { orderCount: 0, revenue: 0, fees: 0, shippingCost: 0, adSpend: 0, profit: 0, totalCost: 0 });

    const totalRoi = total.totalCost > 0
      ? Math.round((total.profit / total.totalCost) * 100 * 10) / 10
      : null;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        period,
        range,
        connectedMarkets,
        channels,
        total: { ...total, roi: totalRoi },
        updatedAt: new Date().toISOString(),
      }),
    };
  } catch (e) {
    console.error('[channel-roi] error:', e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '채널 ROI를 가져오지 못했어요.' }),
    };
  }
};
