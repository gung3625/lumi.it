// settlement-csv.js — 세무사용 거래 명세 CSV 다운로드
// GET /api/settlement-csv?period=YYYY-MM
//
// 컬럼: 일자·마켓·주문번호·상품명·매출액·수수료·VAT·실수령액
// UTF-8 BOM (한국 엑셀 호환)

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const {
  calculateOrderProfit,
  buildMarketFeeMap,
} = require('./_shared/profit-calculator');
const {
  periodToRange,
  buildTransactionLines,
  buildTaxAccountantCsv,
} = require('./_shared/settlement-aggregator');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

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
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const token = extractBearerToken(event);
  const { payload, error: jwtErr } = verifySellerToken(token);
  if (jwtErr) {
    return {
      statusCode: 401,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: jwtErr }),
    };
  }
  const sellerId = payload.seller_id;

  const params = new URLSearchParams(event.rawQuery || '');
  const period = params.get('period') || currentPeriod();

  let range;
  try {
    range = periodToRange(period);
  } catch (e) {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message }),
    };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (_) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Supabase 초기화 실패' }),
    };
  }

  try {
    const [costSettings, marketFeeMap, orders] = await Promise.all([
      fetchCostSettings(admin, sellerId),
      fetchMarketFeeMap(admin),
      fetchOrders(admin, sellerId, range),
    ]);

    const lines = buildTransactionLines(orders, calculateOrderProfit, costSettings, marketFeeMap);
    const csv = buildTaxAccountantCsv(lines);
    const filename = `lumi-settlement-${period}.csv`;

    return {
      statusCode: 200,
      headers: {
        ...CORS,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
      body: csv,
    };
  } catch (e) {
    console.error('[settlement-csv] error:', e.message);
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '정산 CSV를 만들지 못했어요.' }),
    };
  }
};
