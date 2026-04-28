// _shared/insight-builder.js — AI 인사이트 보고서 공용 빌더
// 메모리 근거:
//   - project_intelligence_strategy_doctrine_0428.md (Tier 2 = gpt-4o + JSON 강제)
//   - project_phase1_strategic_differentiation.md (Profit Analytics)
//   - project_proactive_ux_paradigm.md (선제 제안)
//
// 데이터 소스 통합:
//   1. profit-calculator.js (매출·수수료)
//   2. naver-shopping-insight.js (트렌드 — DB 캐시)
//   3. marketplace_orders 테이블 (거래 이력)
//   4. priority-queue 결과 (해야 할 일 압박감)
//
// 비용 정책:
//   - 캐싱: weekly 7일 / monthly 30일 / on_demand 24시간
//   - 셀러당 월 ₩200 (4회 × ₩50 평균) — insight_cost_ledger
//   - Tier 2 (gpt-4o) 평균 비용 = ₩50/회
//
// 출력 JSON 스키마 (4o 응답 강제):
//   {
//     period: "2026-04-21~04-27",
//     summary: "...",
//     top_performers: [...],
//     bottom_performers: [...],
//     trend_match: [...],
//     predictions: { next_week_revenue, confidence, risks: [...] },
//     actions: ["..."]
//   }

const { call4o } = require('./llm-router');
const {
  calculatePeriodProfit,
  buildMarketFeeMap,
} = require('./profit-calculator');

const MONTHLY_COST_LIMIT_KRW = 200;
const COST_PER_CALL_KRW = 50;

/**
 * 기간 범위 계산
 * @param {string} reportType - 'weekly' / 'monthly' / 'on_demand'
 * @param {Object} [opts] - { customStart, customEnd } (on_demand)
 * @returns {{ start, end, label }}
 */
function periodRange(reportType, opts = {}) {
  const now = new Date();
  const end = new Date(now);
  end.setUTCHours(23, 59, 59, 999);

  if (reportType === 'monthly') {
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - 29);
    start.setUTCHours(0, 0, 0, 0);
    return {
      start: start.toISOString(),
      end: end.toISOString(),
      label: `${start.toISOString().slice(0, 10)}~${end.toISOString().slice(0, 10)}`,
    };
  }

  if (reportType === 'on_demand' && opts.customStart && opts.customEnd) {
    const cs = new Date(opts.customStart);
    const ce = new Date(opts.customEnd);
    cs.setUTCHours(0, 0, 0, 0);
    ce.setUTCHours(23, 59, 59, 999);
    return {
      start: cs.toISOString(),
      end: ce.toISOString(),
      label: `${cs.toISOString().slice(0, 10)}~${ce.toISOString().slice(0, 10)}`,
    };
  }

  // weekly (default + on_demand 기본값)
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - 6);
  start.setUTCHours(0, 0, 0, 0);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    label: `${start.toISOString().slice(0, 10)}~${end.toISOString().slice(0, 10)}`,
  };
}

function previousPeriodRange(current, reportType) {
  const startDate = new Date(current.start);
  const endDate = new Date(current.end);
  const days = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)));
  const prevEnd = new Date(startDate.getTime() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - (days - 1));
  prevStart.setUTCHours(0, 0, 0, 0);
  return {
    start: prevStart.toISOString(),
    end: prevEnd.toISOString(),
    label: `${prevStart.toISOString().slice(0, 10)}~${prevEnd.toISOString().slice(0, 10)}`,
  };
}

/**
 * 셀러 데이터 수집 (단일 셀러)
 */
async function collectSellerData(admin, sellerId, range, prevRange) {
  const [
    ordersRes,
    prevOrdersRes,
    productsRes,
    costSettingsRes,
    feeMapRes,
    trendCacheRes,
  ] = await Promise.all([
    admin.from('marketplace_orders')
      .select('id, market, total_price, quantity, status, market_product_id, product_id, created_at')
      .eq('seller_id', sellerId)
      .in('status', ['paid', 'shipping', 'delivered'])
      .gte('created_at', range.start)
      .lte('created_at', range.end)
      .then(r => r.data || []).catch(() => []),
    admin.from('marketplace_orders')
      .select('id, market, total_price, quantity, status, market_product_id, product_id, created_at')
      .eq('seller_id', sellerId)
      .in('status', ['paid', 'shipping', 'delivered'])
      .gte('created_at', prevRange.start)
      .lte('created_at', prevRange.end)
      .then(r => r.data || []).catch(() => []),
    admin.from('products')
      .select('id, name, category, stock, price')
      .eq('seller_id', sellerId)
      .limit(200)
      .then(r => r.data || []).catch(() => []),
    admin.from('seller_cost_settings')
      .select('*')
      .eq('seller_id', sellerId)
      .maybeSingle()
      .then(r => r.data || null).catch(() => null),
    admin.from('market_fee_table')
      .select('market, category_key, fee_ratio')
      .eq('active', true)
      .then(r => r.data || []).catch(() => []),
    admin.from('shopping_insights')
      .select('category_code, category_name, summary, period_end')
      .eq('keyword', '')
      .eq('metric_type', 'category_overall')
      .order('period_end', { ascending: false })
      .limit(20)
      .then(r => r.data || []).catch(() => []),
  ]);

  const costSettings = costSettingsRes || {
    seller_id: sellerId,
    packaging_cost_per_unit: 500,
    shipping_cost_per_unit: 3000,
    ad_spend_ratio: 0.0,
    payment_fee_ratio: 3.30,
    vat_applicable: true,
    market_fee_overrides: {},
  };

  const marketFeeMap = buildMarketFeeMap(feeMapRes);
  const totals = calculatePeriodProfit(ordersRes, costSettings, marketFeeMap);
  const prevTotals = calculatePeriodProfit(prevOrdersRes, costSettings, marketFeeMap);

  // 상품별 매출 집계
  const productSales = new Map();
  for (const o of ordersRes) {
    const pid = o.product_id || o.market_product_id || 'unknown';
    const prev = productSales.get(pid) || { revenue: 0, units: 0, market: o.market };
    prev.revenue += Number(o.total_price || 0);
    prev.units += Number(o.quantity || 1);
    productSales.set(pid, prev);
  }
  const productMap = new Map((productsRes || []).map(p => [p.id, p]));
  const ranked = [...productSales.entries()].map(([pid, s]) => {
    const meta = productMap.get(pid) || {};
    return {
      product_id: pid,
      name: meta.name || '(상품 정보 없음)',
      category: meta.category || null,
      stock: meta.stock ?? null,
      market: s.market,
      revenue: s.revenue,
      units: s.units,
    };
  }).sort((a, b) => b.revenue - a.revenue);

  const topPerformers = ranked.slice(0, 5);
  const bottomPerformers = ranked.length > 5 ? ranked.slice(-3).reverse() : [];

  // 재고 부족 (5개 미만)
  const lowStock = (productsRes || []).filter(p => p.stock !== null && p.stock < 5).slice(0, 5);

  // 트렌드 (DB 캐시)
  const trendKeywords = (trendCacheRes || []).slice(0, 8).map(t => ({
    category: t.category_name,
    summary: t.summary,
  }));

  return {
    range,
    prevRange,
    totals,
    prevTotals,
    ranked,
    topPerformers,
    bottomPerformers,
    lowStock,
    productCount: (productsRes || []).length,
    trendKeywords,
    costSettings: {
      packaging_cost_per_unit: costSettings.packaging_cost_per_unit,
      shipping_cost_per_unit: costSettings.shipping_cost_per_unit,
      ad_spend_ratio: Number(costSettings.ad_spend_ratio),
    },
  };
}

/**
 * 4o 시스템 프롬프트 — JSON 강제
 */
const SYSTEM_PROMPT = `너는 1인 셀러를 돕는 AI 인사이트 분석가다.
주어진 매출/주문/상품/트렌드 데이터를 보고 셀러가 즉시 행동할 수 있는 보고서를 JSON으로 생성한다.

원칙:
1. 추측 금지. 숫자 근거 없는 주장은 출력 금지.
2. 한국 1인 셀러 사장님 톤 — 친근하지만 짧고 명확.
3. summary는 1~2문장. 긍정/부정 모두 사실대로.
4. predictions.confidence는 데이터 양 기준 (주문 < 5건이면 0.4 이하).
5. actions는 셀러가 1~2분 안에 실행 가능한 구체 행동만 (3~5개).
6. trend_match에는 "사장님 매장에 이 트렌드 상품이 있냐 없냐"를 명시.

출력 JSON 스키마:
{
  "period": "YYYY-MM-DD~YYYY-MM-DD",
  "summary": "한 줄 요약",
  "top_performers": [{ "name": "", "revenue": 0, "units": 0, "market": "" }],
  "bottom_performers": [{ "name": "", "revenue": 0, "units": 0 }],
  "trend_match": [{ "trend": "", "match_in_store": false, "suggestion": "" }],
  "predictions": { "next_week_revenue": 0, "confidence": 0.0, "risks": [""] },
  "actions": [{ "title": "", "type": "price_adjust|restock|register_trend|pause_ad|other", "priority": 0 }]
}`;

function buildUserPrompt(reportType, data) {
  const t = data.totals;
  const pt = data.prevTotals;
  const deltaPct = pt.netProfit > 0 ? Math.round(((t.netProfit - pt.netProfit) / Math.abs(pt.netProfit)) * 1000) / 10 : null;

  return JSON.stringify({
    report_type: reportType,
    period: data.range.label,
    previous_period: data.prevRange.label,
    profit: {
      gross_revenue: t.grossRevenue,
      market_fees: t.marketFees,
      net_profit: t.netProfit,
      order_count: t.orderCount,
      units_sold: t.unitsSold,
      profit_margin_pct: t.profitMargin,
      delta_vs_previous_pct: deltaPct,
    },
    top_performers: data.topPerformers,
    bottom_performers: data.bottomPerformers,
    low_stock_products: data.lowStock,
    product_count: data.productCount,
    trends: data.trendKeywords,
  });
}

/**
 * 셀러 비용 한도 체크 (월 ₩200)
 * @returns {Promise<{ allowed: boolean, used: number, remaining: number }>}
 */
async function checkCostLimit(admin, sellerId) {
  const monthBucket = new Date().toISOString().slice(0, 7) + '-01';
  try {
    const { data } = await admin
      .from('insight_cost_ledger')
      .select('total_cost_krw, call_count')
      .eq('seller_id', sellerId)
      .eq('bucket_month', monthBucket)
      .maybeSingle();
    const used = data?.total_cost_krw || 0;
    const remaining = MONTHLY_COST_LIMIT_KRW - used;
    return { allowed: used + COST_PER_CALL_KRW <= MONTHLY_COST_LIMIT_KRW, used, remaining };
  } catch (_) {
    return { allowed: true, used: 0, remaining: MONTHLY_COST_LIMIT_KRW };
  }
}

async function bumpCost(admin, sellerId, costKrw) {
  const monthBucket = new Date().toISOString().slice(0, 7) + '-01';
  try {
    const { data: existing } = await admin
      .from('insight_cost_ledger')
      .select('id, total_cost_krw, call_count')
      .eq('seller_id', sellerId)
      .eq('bucket_month', monthBucket)
      .maybeSingle();
    if (existing) {
      await admin.from('insight_cost_ledger').update({
        total_cost_krw: existing.total_cost_krw + costKrw,
        call_count: existing.call_count + 1,
        updated_at: new Date().toISOString(),
      }).eq('id', existing.id);
    } else {
      await admin.from('insight_cost_ledger').insert({
        seller_id: sellerId,
        bucket_month: monthBucket,
        total_cost_krw: costKrw,
        call_count: 1,
      });
    }
  } catch (_) { /* silent */ }
}

/**
 * 캐시 조회 (insight_reports 테이블)
 */
async function loadCachedReport(admin, sellerId, reportType, range) {
  try {
    const { data } = await admin
      .from('insight_reports')
      .select('*')
      .eq('seller_id', sellerId)
      .eq('report_type', reportType)
      .eq('period_start', range.start.slice(0, 10))
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return null;
    if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) return null;
    return data;
  } catch (_) {
    return null;
  }
}

/**
 * 보고서 저장 (insight_reports + insight_predictions + insight_actions 일괄)
 */
async function persistReport(admin, sellerId, reportType, range, reportJson, meta = {}) {
  const ttlHours = reportType === 'monthly' ? 30 * 24 : reportType === 'weekly' ? 7 * 24 : 24;
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();

  const insertRow = {
    seller_id: sellerId,
    report_type: reportType,
    period_start: range.start.slice(0, 10),
    period_end: range.end.slice(0, 10),
    report_json: reportJson,
    summary: reportJson.summary || null,
    llm_cost_krw: meta.cached ? 0 : COST_PER_CALL_KRW,
    llm_cached: !!meta.cached,
    cache_key: `${reportType}:${sellerId}:${range.start.slice(0, 10)}`,
    expires_at: expiresAt,
  };

  let reportId = null;
  try {
    const { data, error } = await admin
      .from('insight_reports')
      .upsert(insertRow, { onConflict: 'seller_id,report_type,period_start' })
      .select('id')
      .single();
    if (error) {
      console.error('[insight-builder] upsert 실패:', error.message);
    } else {
      reportId = data?.id || null;
    }
  } catch (e) {
    console.error('[insight-builder] persist 에러:', e.message);
  }

  // 예측 저장
  if (reportId && reportJson.predictions) {
    try {
      await admin.from('insight_predictions').insert({
        seller_id: sellerId,
        report_id: reportId,
        prediction_type: reportType === 'monthly' ? 'next_month_revenue' : 'next_week_revenue',
        predicted_value: { value: reportJson.predictions.next_week_revenue, currency: 'KRW' },
        confidence: Math.min(1, Math.max(0, Number(reportJson.predictions.confidence) || 0.5)),
        message: (reportJson.predictions.risks || []).join(' / '),
        expires_at: expiresAt,
      });
    } catch (_) { /* silent */ }
  }

  // 액션 제안 저장 (priority 기준 정렬)
  if (reportId && Array.isArray(reportJson.actions)) {
    const rows = reportJson.actions.slice(0, 10).map((a, i) => ({
      seller_id: sellerId,
      report_id: reportId,
      action_type: typeof a === 'string' ? 'other' : (a.type || 'other'),
      title: typeof a === 'string' ? a : (a.title || '(액션 제안)'),
      description: typeof a === 'string' ? null : (a.description || null),
      priority: typeof a === 'string' ? 50 - i : (Number(a.priority) || 50 - i),
      status: 'proposed',
      expires_at: expiresAt,
    }));
    if (rows.length > 0) {
      try { await admin.from('insight_actions').insert(rows); } catch (_) { /* silent */ }
    }
  }

  return { reportId, expiresAt };
}

/**
 * 보고서 생성 메인 (Tier 2 호출 + 캐시 + 비용 차감)
 *
 * @param {Object} params
 *   - admin: Supabase admin client
 *   - sellerId: string
 *   - reportType: 'weekly' / 'monthly' / 'on_demand'
 *   - mock: boolean (테스트용 — 4o 호출 생략)
 *   - forceRefresh: boolean (캐시 무시)
 *   - customStart, customEnd: on_demand 기간
 */
async function buildReport({ admin, sellerId, reportType = 'weekly', mock = false, forceRefresh = false, customStart, customEnd }) {
  if (!admin || !sellerId) {
    return { ok: false, error: 'admin/sellerId 필요' };
  }
  if (!['weekly', 'monthly', 'on_demand'].includes(reportType)) {
    return { ok: false, error: `유효하지 않은 reportType: ${reportType}` };
  }

  const range = periodRange(reportType, { customStart, customEnd });
  const prevRange = previousPeriodRange(range, reportType);

  // 캐시 hit
  if (!forceRefresh) {
    const cached = await loadCachedReport(admin, sellerId, reportType, range);
    if (cached) {
      return {
        ok: true,
        reportId: cached.id,
        report: cached.report_json,
        cached: true,
        cost_krw: 0,
        period: range,
      };
    }
  }

  // 비용 한도 체크
  const limit = await checkCostLimit(admin, sellerId);
  if (!limit.allowed) {
    return {
      ok: false,
      error: `이번 달 인사이트 비용 한도(₩${MONTHLY_COST_LIMIT_KRW})를 모두 사용했어요.`,
      limit_used: limit.used,
    };
  }

  // 데이터 수집
  const data = await collectSellerData(admin, sellerId, range, prevRange);

  // Mock 모드 (테스트/주문 0건 시 fallback)
  if (mock || data.totals.orderCount === 0) {
    const fallback = buildFallbackReport(reportType, range, data);
    const persisted = await persistReport(admin, sellerId, reportType, range, fallback, { cached: false });
    return {
      ok: true,
      reportId: persisted.reportId,
      report: fallback,
      cached: false,
      cost_krw: 0,
      mock: true,
      period: range,
    };
  }

  // Tier 2 (gpt-4o) 호출
  const userPrompt = buildUserPrompt(reportType, data);
  const llmRes = await call4o({
    system: SYSTEM_PROMPT,
    user: userPrompt,
    max_tokens: 1200,
    sellerId,
    cacheKind: 'insight_report',
  });

  if (!llmRes.ok) {
    // LLM 실패 시 fallback 보고서
    const fallback = buildFallbackReport(reportType, range, data, llmRes.error);
    const persisted = await persistReport(admin, sellerId, reportType, range, fallback, { cached: false });
    return {
      ok: true,
      reportId: persisted.reportId,
      report: fallback,
      cached: false,
      cost_krw: 0,
      degraded: true,
      llm_error: llmRes.error,
      period: range,
    };
  }

  // JSON 파싱 검증 + 기본값
  const reportJson = normalizeReport(llmRes.result, range);

  const persisted = await persistReport(admin, sellerId, reportType, range, reportJson, { cached: !!llmRes.cached });
  if (!llmRes.cached) {
    await bumpCost(admin, sellerId, COST_PER_CALL_KRW);
  }

  return {
    ok: true,
    reportId: persisted.reportId,
    report: reportJson,
    cached: !!llmRes.cached,
    cost_krw: llmRes.cached ? 0 : COST_PER_CALL_KRW,
    period: range,
  };
}

/**
 * 4o 응답에 누락 필드 보강
 */
function normalizeReport(raw, range) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    period: r.period || range.label,
    summary: r.summary || '이번 기간 데이터를 정리했어요.',
    top_performers: Array.isArray(r.top_performers) ? r.top_performers.slice(0, 5) : [],
    bottom_performers: Array.isArray(r.bottom_performers) ? r.bottom_performers.slice(0, 3) : [],
    trend_match: Array.isArray(r.trend_match) ? r.trend_match.slice(0, 5) : [],
    predictions: {
      next_week_revenue: Number(r.predictions?.next_week_revenue) || 0,
      confidence: Number(r.predictions?.confidence) || 0.5,
      risks: Array.isArray(r.predictions?.risks) ? r.predictions.risks.slice(0, 5) : [],
    },
    actions: Array.isArray(r.actions) ? r.actions.slice(0, 6) : [],
  };
}

/**
 * Fallback 보고서 (LLM 실패 또는 데이터 없음)
 */
function buildFallbackReport(reportType, range, data, errorNote = null) {
  const t = data.totals;
  const pretty = (n) => '₩' + (Number(n) || 0).toLocaleString('ko-KR');
  const summary = t.orderCount === 0
    ? `이번 ${reportType === 'monthly' ? '달' : '주'}는 주문이 아직 없어요. 트렌드 카드를 확인해 보세요.`
    : `이번 ${reportType === 'monthly' ? '달' : '주'} 매출 ${pretty(t.grossRevenue)}, 통장에 ${pretty(t.netProfit)} 남았어요.`;

  return {
    period: range.label,
    summary,
    top_performers: data.topPerformers.slice(0, 5).map(p => ({
      name: p.name, revenue: p.revenue, units: p.units, market: p.market,
    })),
    bottom_performers: data.bottomPerformers.map(p => ({
      name: p.name, revenue: p.revenue, units: p.units,
    })),
    trend_match: (data.trendKeywords || []).slice(0, 3).map(tk => ({
      trend: tk.category, match_in_store: false, suggestion: '[트렌드 페이지에서 확인]',
    })),
    predictions: {
      next_week_revenue: Math.round(t.grossRevenue * (reportType === 'monthly' ? 0.25 : 1.0)),
      confidence: t.orderCount >= 5 ? 0.6 : 0.3,
      risks: data.lowStock.length > 0 ? [`재고 5개 미만 ${data.lowStock.length}개`] : [],
    },
    actions: data.lowStock.length > 0
      ? [{ title: `재고 부족 ${data.lowStock.length}개 재발주 검토`, type: 'restock', priority: 80 }]
      : [],
    _fallback: true,
    _error: errorNote || undefined,
  };
}

module.exports = {
  buildReport,
  collectSellerData,
  periodRange,
  previousPeriodRange,
  checkCostLimit,
  bumpCost,
  persistReport,
  buildFallbackReport,
  normalizeReport,
  MONTHLY_COST_LIMIT_KRW,
  COST_PER_CALL_KRW,
};
