// settlement-monthly.js — 월별 정산 집계 API
// GET /api/settlement-monthly?period=YYYY-MM
//
// 응답: 매출·마켓수수료(마켓별)·광고·포장·VAT(매출세액·매입세액)·순이익
//        + transactions 리스트 + 마켓별 그룹

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const {
  calculateOrderProfit,
  calculatePeriodProfit,
  buildMarketFeeMap,
  calculateDelta,
} = require('./_shared/profit-calculator');
const {
  periodToRange,
  previousPeriod,
  groupByMarket,
  buildSettlementSummary,
  buildTransactionLines,
} = require('./_shared/settlement-aggregator');

const { corsHeaders, getOrigin } = require('./_shared/auth');

function currentPeriod() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function fetchOrders(admin, sellerId, range) {
  try {
    const { data, error } = await admin
      .from('marketplace_orders')
      .select('id, market, market_order_id, total_price, quantity, status, product_title, created_at')
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
  const period = params.get('period') || currentPeriod();

  let range;
  let prevRange;
  try {
    range = periodToRange(period);
    const prev = previousPeriod(period);
    prevRange = prev ? periodToRange(prev) : null;
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (_) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase 초기화 실패' }) };
  }

  try {
    const [costSettings, marketFeeMap, orders, prevOrders] = await Promise.all([
      fetchCostSettings(admin, sellerId),
      fetchMarketFeeMap(admin),
      fetchOrders(admin, sellerId, range),
      prevRange ? fetchOrders(admin, sellerId, prevRange) : Promise.resolve([]),
    ]);

    const totals = calculatePeriodProfit(orders, costSettings, marketFeeMap);
    const prevTotals = calculatePeriodProfit(prevOrders, costSettings, marketFeeMap);
    const byMarket = groupByMarket(orders, costSettings, marketFeeMap, calculateOrderProfit);

    const summary = buildSettlementSummary(totals, byMarket, {
      vat_applicable: costSettings.vat_applicable !== false,
    });

    const transactions = buildTransactionLines(orders, calculateOrderProfit, costSettings, marketFeeMap);

    const deltaPct = calculateDelta(totals.netProfit, prevTotals.netProfit);
    const previousMonth = previousPeriod(period);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        period,
        range,
        summary,
        transactions,
        by_marketplace: byMarket,
        previous: {
          period: previousMonth,
          net_profit: prevTotals.netProfit,
          gross_revenue: prevTotals.grossRevenue,
          delta_pct: deltaPct,
        },
        cost_settings_applied: {
          packaging_cost_per_unit: costSettings.packaging_cost_per_unit,
          shipping_cost_per_unit: costSettings.shipping_cost_per_unit,
          ad_spend_ratio: Number(costSettings.ad_spend_ratio),
          payment_fee_ratio: Number(costSettings.payment_fee_ratio),
          vat_applicable: costSettings.vat_applicable !== false,
        },
        updatedAt: new Date().toISOString(),
      }),
    };
  } catch (e) {
    console.error('[settlement-monthly] error:', e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '월별 정산을 불러오지 못했어요.' }),
    };
  }
};
