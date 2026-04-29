// settlement-vat-form.js — 분기별 부가가치세 신고 양식
// GET /api/settlement-vat-form?quarter=YYYY-Q[1-4]
//
// 홈택스 일반과세 사업자 부가세 신고서 호환 필드
//   매출세액·매입세액 자동 분리 + 납부세액 계산 (VAT 10%)

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const {
  calculateOrderProfit,
  calculatePeriodProfit,
  buildMarketFeeMap,
} = require('./_shared/profit-calculator');
const {
  quarterToRange,
  groupByMarket,
  splitVat,
  VAT_RATE,
} = require('./_shared/settlement-aggregator');

const { corsHeaders, getOrigin } = require('./_shared/auth');

function currentQuarter() {
  const d = new Date();
  const month = d.getUTCMonth() + 1;
  const q = Math.floor((month - 1) / 3) + 1;
  return `${d.getUTCFullYear()}-Q${q}`;
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
  const quarter = params.get('quarter') || currentQuarter();

  let range;
  try {
    range = quarterToRange(quarter);
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
    const [costSettings, marketFeeMap, orders, sellerRow] = await Promise.all([
      fetchCostSettings(admin, sellerId),
      fetchMarketFeeMap(admin),
      fetchOrders(admin, sellerId, range),
      admin.from('sellers').select('business_name, business_number_masked').eq('id', sellerId).maybeSingle()
        .then(r => r.data).catch(() => null),
    ]);

    const totals = calculatePeriodProfit(orders, costSettings, marketFeeMap);
    const byMarket = groupByMarket(orders, costSettings, marketFeeMap, calculateOrderProfit);

    const vatApplicable = costSettings.vat_applicable !== false;
    // 매출세액 = 총매출 / 11 (부가세 포함 금액 → 1/11이 VAT)
    const sales = vatApplicable ? splitVat(totals.grossRevenue) : { supply: totals.grossRevenue, vat: 0 };

    // 매입세액 = 마켓수수료·광고·포장·결제수수료의 부가세 부분
    // (사업자 매입증빙 가정 — 실 신고 시 세금계산서 첨부 필요)
    const purchaseTotal = totals.marketFees + totals.adSpend + totals.packagingCost + totals.paymentFees;
    const purchase = vatApplicable
      ? { supply: purchaseTotal - Math.round(purchaseTotal / 11), vat: Math.round(purchaseTotal / 11) }
      : { supply: purchaseTotal, vat: 0 };

    const vatDue = sales.vat - purchase.vat;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        quarter,
        range,
        period_start: range.start.slice(0, 10),
        period_end: range.end.slice(0, 10),
        // 사업자 정보 (홈택스 신고서 헤더)
        seller: {
          business_name: sellerRow?.business_name || '',
          business_number_masked: sellerRow?.business_number_masked || payload.business_number_masked || '',
        },
        vat_rate: VAT_RATE,
        vat_applicable: vatApplicable,
        // 홈택스 일반과세 신고서 핵심 칸
        sales: {
          total: totals.grossRevenue,                  // 합계 (공급가액 + 세액)
          supply: sales.supply,                         // 공급가액
          vat: sales.vat,                               // 매출세액
          order_count: totals.orderCount,
        },
        purchase: {
          total: purchaseTotal,                         // 합계 (수수료·광고·포장·결제)
          supply: purchase.supply,                      // 매입 공급가액
          vat: purchase.vat,                            // 매입세액 (환급 가능)
          breakdown: {
            marketplace_fees: totals.marketFees,
            ad_spend: totals.adSpend,
            packaging: totals.packagingCost,
            payment_fees: totals.paymentFees,
          },
        },
        vat_due: vatDue,                                // 납부세액 (음수면 환급)
        vat_status: vatDue >= 0 ? 'payable' : 'refundable',
        by_marketplace: byMarket.map(m => ({
          market: m.market,
          gross_revenue: m.gross_revenue,
          supply: vatApplicable ? splitVat(m.gross_revenue).supply : m.gross_revenue,
          vat: vatApplicable ? splitVat(m.gross_revenue).vat : 0,
          order_count: m.order_count,
        })),
        message: buildVatMessage(vatDue),
        vat_disclaimer: '본 자료는 추정치이며 실 신고는 세금계산서 첨부 필수. 세무사 검토 권고',
        updatedAt: new Date().toISOString(),
      }),
    };
  } catch (e) {
    console.error('[settlement-vat-form] error:', e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '부가세 신고 자료를 만들지 못했어요.' }),
    };
  }
};

function buildVatMessage(vatDue) {
  const abs = Math.abs(vatDue).toLocaleString('ko-KR');
  if (vatDue > 0) return `이번 분기 부가세 납부 예상 ₩${abs}`;
  if (vatDue < 0) return `이번 분기 부가세 환급 예상 ₩${abs}`;
  return '이번 분기 납부세액이 0원이에요';
}
