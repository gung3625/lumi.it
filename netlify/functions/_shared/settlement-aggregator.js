// settlement-aggregator.js — 월별 정산 집계 + VAT 분리 유틸
// _shared/profit-calculator.js의 calculatePeriodProfit 결과를 정산 형식으로 재구성
// 메모리 project_phase1_strategic_differentiation.md 11단계 (Profit Analytics)
//
// 한국 부가세(VAT) 10% — 일반과세 사업자 기준
//   매출세액 = 공급가액 × 10% (즉, total_price × 1/11)
//   매입세액 = 광고비·포장재·결제수수료의 1/11 (사업자 매입증빙 가정)
//   납부세액 = 매출세액 - 매입세액 (음수면 환급)

const VAT_RATE = 10; // %

/**
 * 'YYYY-MM' 기간을 ISO 범위로 변환 (UTC, KST 1일~말일)
 * @param {string} period — 'YYYY-MM'
 * @returns {{ start: string, end: string }}
 */
function periodToRange(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(period || '');
  if (!m) {
    throw new Error("period 형식이 올바르지 않아요. 예: '2026-04'");
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error('월(month)은 1~12 사이여야 해요.');

  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  // 다음 달 0일 = 해당 달 마지막 날
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * 직전 월 period 'YYYY-MM' 반환
 */
function previousPeriod(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(period || '');
  if (!m) return null;
  let year = Number(m[1]);
  let month = Number(m[2]) - 1;
  if (month < 1) { month = 12; year -= 1; }
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * 'YYYY-Q[1-4]' → ISO 범위
 */
function quarterToRange(quarter) {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter || '');
  if (!m) throw new Error("quarter 형식이 올바르지 않아요. 예: '2026-Q2'");
  const year = Number(m[1]);
  const q = Number(m[2]);
  const startMonth = (q - 1) * 3; // 0, 3, 6, 9
  const start = new Date(Date.UTC(year, startMonth, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, startMonth + 3, 0, 23, 59, 59, 999));
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * 매출액에서 VAT 분리 (부가세포함 → 공급가액·세액)
 * @param {number} amount — 부가세포함 금액
 * @returns {{ supply: number, vat: number }}
 */
function splitVat(amount) {
  const total = Math.round(Number(amount || 0));
  // 11분의 1 = VAT, 11분의 10 = 공급가액
  const vat = Math.round(total / 11);
  const supply = total - vat;
  return { supply, vat };
}

/**
 * 마켓별 그룹핑 결과 빌드
 * @param {Array} orders
 * @param {Object} costSettings
 * @param {Map} marketFeeMap
 * @param {Function} calculateOrderProfit — profit-calculator의 함수 주입
 */
function groupByMarket(orders, costSettings, marketFeeMap, calculateOrderProfit) {
  const groups = new Map();
  for (const o of orders || []) {
    const market = o.market || 'unknown';
    if (!groups.has(market)) {
      groups.set(market, {
        market,
        order_count: 0,
        gross_revenue: 0,
        marketplace_fees: 0,
        net_profit: 0,
      });
    }
    const g = groups.get(market);
    const p = calculateOrderProfit(o, costSettings, marketFeeMap);
    g.order_count += 1;
    g.gross_revenue += p.grossRevenue;
    g.marketplace_fees += p.marketFee;
    g.net_profit += p.netProfit;
  }
  return Array.from(groups.values()).sort((a, b) => b.gross_revenue - a.gross_revenue);
}

/**
 * 월별 정산 요약 빌드
 * @param {Object} totals — calculatePeriodProfit 결과
 * @param {Array} byMarket — groupByMarket 결과
 * @param {Object} options — { vat_applicable }
 */
function buildSettlementSummary(totals, byMarket, options = {}) {
  const vatApplicable = options.vat_applicable !== false;

  // 매출 부가세 분리 (총매출 → 공급가액·매출세액)
  const salesSplit = vatApplicable ? splitVat(totals.grossRevenue) : { supply: totals.grossRevenue, vat: 0 };

  // 매입세액 = 광고비·포장재·결제수수료의 VAT (1/11)
  // (마켓 수수료는 마켓이 부가세 별도 발행 — 1/11 환급 가능)
  let vatRefundable = 0;
  if (vatApplicable) {
    vatRefundable = Math.round(totals.marketFees / 11)
                  + Math.round(totals.adSpend / 11)
                  + Math.round(totals.packagingCost / 11)
                  + Math.round(totals.paymentFees / 11);
  }

  // 마켓별 점유율 (₩ 합계 → 개별 객체)
  const marketsObj = {};
  for (const m of byMarket) {
    marketsObj[m.market] = {
      gross_revenue: m.gross_revenue,
      marketplace_fees: m.marketplace_fees,
      order_count: m.order_count,
      net_profit: m.net_profit,
    };
  }

  return {
    gross_revenue: totals.grossRevenue,
    sales_supply: salesSplit.supply,
    marketplace_fees: marketsObj,
    marketplace_fees_total: totals.marketFees,
    ad_fees: totals.adSpend,
    packaging_fees: totals.packagingCost,
    shipping_fees: totals.shippingCost,
    payment_fees: totals.paymentFees,
    vat_payable: salesSplit.vat,
    vat_refundable: vatRefundable,
    vat_due: salesSplit.vat - vatRefundable,
    net_profit: totals.netProfit,
    profit_margin: totals.profitMargin,
    order_count: totals.orderCount,
    units_sold: totals.unitsSold,
    by_marketplace: byMarket,
    vat_disclaimer: '본 자료는 추정치이며 실 신고는 세금계산서 첨부 필수. 세무사 검토 권고',
  };
}

/**
 * 거래 라인 빌드 (CSV용)
 * @param {Array} orders
 * @param {Function} calculateOrderProfit
 * @param {Object} costSettings
 * @param {Map} marketFeeMap
 */
function buildTransactionLines(orders, calculateOrderProfit, costSettings, marketFeeMap) {
  const lines = [];
  for (const o of orders || []) {
    const p = calculateOrderProfit(o, costSettings, marketFeeMap);
    const vatSplit = splitVat(p.grossRevenue);
    const totalDeduction = p.marketFee + p.adSpend + p.packagingCost + p.shippingCost + p.paymentFee;
    lines.push({
      occurred_at: o.created_at,
      market: o.market,
      market_order_id: o.market_order_id || o.id,
      product_title: o.product_title || '',
      gross_amount: p.grossRevenue,
      fee_amount: totalDeduction,
      vat_amount: vatSplit.vat,
      net_amount: p.grossRevenue - totalDeduction - vatSplit.vat,
      tax_category: 'sales',
    });
  }
  return lines.sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
}

/**
 * UTF-8 BOM + CSV 직렬화 (한국 엑셀 호환)
 */
function escapeCsvField(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function buildTaxAccountantCsv(lines) {
  const headers = ['일자', '마켓', '주문번호', '상품명', '매출액', '수수료', '부가세', '실수령액'];
  const rows = [headers.join(',')];
  for (const l of lines) {
    const date = (l.occurred_at || '').slice(0, 10);
    rows.push([
      escapeCsvField(date),
      escapeCsvField(l.market || ''),
      escapeCsvField(l.market_order_id || ''),
      escapeCsvField(l.product_title || ''),
      l.gross_amount || 0,
      l.fee_amount || 0,
      l.vat_amount || 0,
      l.net_amount || 0,
    ].join(','));
  }
  // UTF-8 BOM 추가 → Excel 한글 호환
  return '\uFEFF' + rows.join('\r\n');
}

module.exports = {
  VAT_RATE,
  periodToRange,
  previousPeriod,
  quarterToRange,
  splitVat,
  groupByMarket,
  buildSettlementSummary,
  buildTransactionLines,
  buildTaxAccountantCsv,
  escapeCsvField,
};
