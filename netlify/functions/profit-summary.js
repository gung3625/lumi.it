// profit-summary.js — Sprint 4 Profit Card API
// 메모리 project_phase1_strategic_differentiation.md 11단계 (Profit Analytics)
// "100개 팔렸는데 통장에 얼마 남았나"
//
// GET /api/profit-summary?period=week|month|day

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const {
  calculatePeriodProfit,
  buildMarketFeeMap,
  calculateDelta,
  buildProfitMessage,
} = require('./_shared/profit-calculator');

const { corsHeaders, getOrigin } = require('./_shared/auth');

function periodRange(period) {
  const now = new Date();
  const end = new Date(now);
  end.setUTCHours(23, 59, 59, 999);
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);

  if (period === 'day') {
    // 오늘 00:00 ~ 23:59
  } else if (period === 'month') {
    start.setUTCDate(start.getUTCDate() - 29);
  } else {
    // week (default)
    start.setUTCDate(start.getUTCDate() - 6);
  }

  return { start: start.toISOString(), end: end.toISOString() };
}

function previousPeriodRange(period) {
  const { start, end } = periodRange(period);
  const days = period === 'day' ? 1 : period === 'month' ? 30 : 7;
  const prevEnd = new Date(start);
  prevEnd.setUTCMilliseconds(prevEnd.getUTCMilliseconds() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - (days - 1));
  prevStart.setUTCHours(0, 0, 0, 0);
  return { start: prevStart.toISOString(), end: prevEnd.toISOString() };
}

async function fetchOrders(admin, sellerId, range) {
  try {
    const { data, error } = await admin
      .from('marketplace_orders')
      .select('id, market, total_price, quantity, status, market_product_id, product_id, created_at')
      .eq('seller_id', sellerId)
      .in('status', ['paid', 'shipping', 'delivered'])
      .gte('created_at', range.start)
      .lte('created_at', range.end);
    if (error) return [];
    return data || [];
  } catch (_) {
    return [];
  }
}

async function fetchCostSettings(admin, sellerId) {
  try {
    const { data } = await admin
      .from('seller_cost_settings')
      .select('*')
      .eq('seller_id', sellerId)
      .maybeSingle();
    if (data) return data;
  } catch (_) {}
  // Default settings (가입 직후 셀러)
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
  } catch (_) {
    return new Map();
  }
}

/**
 * 일자별 시계열 (PC 차트용)
 */
function bucketByDay(orders, costSettings, marketFeeMap, range) {
  const buckets = new Map();
  const startMs = new Date(range.start).getTime();
  const endMs = new Date(range.end).getTime();
  const days = Math.ceil((endMs - startMs) / (24 * 60 * 60 * 1000)) + 1;

  for (let i = 0; i < days; i++) {
    const d = new Date(startMs + i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, []);
  }

  for (const o of orders) {
    const day = (o.created_at || '').slice(0, 10);
    if (buckets.has(day)) buckets.get(day).push(o);
  }

  const series = [];
  for (const [day, dayOrders] of buckets.entries()) {
    const p = calculatePeriodProfit(dayOrders, costSettings, marketFeeMap);
    series.push({
      date: day,
      gross_revenue: p.grossRevenue,
      net_profit: p.netProfit,
      order_count: p.orderCount,
    });
  }
  series.sort((a, b) => a.date.localeCompare(b.date));
  return series;
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event));
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
  const period = ['day', 'week', 'month'].includes(params.get('period')) ? params.get('period') : 'week';
  const includeSeries = params.get('series') === 'true';

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase 초기화 실패' }) };
  }

  try {
    const range = periodRange(period);
    const prevRange = previousPeriodRange(period);

    const [costSettings, marketFeeMap, orders, prevOrders] = await Promise.all([
      fetchCostSettings(admin, sellerId),
      fetchMarketFeeMap(admin),
      fetchOrders(admin, sellerId, range),
      fetchOrders(admin, sellerId, prevRange),
    ]);

    const totals = calculatePeriodProfit(orders, costSettings, marketFeeMap);
    const prevTotals = calculatePeriodProfit(prevOrders, costSettings, marketFeeMap);
    const deltaPct = calculateDelta(totals.netProfit, prevTotals.netProfit);

    const message = buildProfitMessage(totals, deltaPct);

    const response = {
      ok: true,
      period,
      range,
      totals,
      previous: prevTotals,
      deltaPct,
      message,
      breakdown: {
        gross_revenue: totals.grossRevenue,
        market_fees: totals.marketFees,
        ad_spend: totals.adSpend,
        packaging_cost: totals.packagingCost,
        shipping_cost: totals.shippingCost,
        payment_fees: totals.paymentFees,
        vat: totals.vat,
        net_profit: totals.netProfit,
        profit_margin: totals.profitMargin,
      },
      // PC 차트는 시계열 (모바일은 단일 카드만)
      series: includeSeries ? bucketByDay(orders, costSettings, marketFeeMap, range) : null,
      cost_settings_applied: {
        packaging_cost_per_unit: costSettings.packaging_cost_per_unit,
        shipping_cost_per_unit: costSettings.shipping_cost_per_unit,
        ad_spend_ratio: Number(costSettings.ad_spend_ratio),
        payment_fee_ratio: Number(costSettings.payment_fee_ratio),
        vat_applicable: costSettings.vat_applicable,
      },
      updatedAt: new Date().toISOString(),
    };

    return { statusCode: 200, headers: CORS, body: JSON.stringify(response) };
  } catch (e) {
    console.error('[profit-summary] error:', e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '수익 정보를 가져오지 못했어요.' }),
    };
  }
};
