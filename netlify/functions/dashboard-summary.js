// dashboard-summary.js — Sprint 4 PC 대시보드 통합 카드 API
// 한 번 호출로 트렌드·우선순위·Profit·Sync·Live 5개 카드 합산
// 모바일 홈도 동일 응답 사용 (한 번에 5개 카드 렌더)
//
// GET /api/dashboard-summary

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { buildPriorityCards, buildMockPriorityCards } = require('./_shared/priority-queue');
const {
  calculatePeriodProfit,
  buildMarketFeeMap,
  calculateDelta,
  buildProfitMessage,
} = require('./_shared/profit-calculator');
const { fetchSyncStatus, buildHealthMessage } = require('./_shared/sync-status');
const { fetchRecentEvents } = require('./_shared/live-events');
const {
  matchTrendsToSeller,
  enrichWithSeasonEvents,
  buildTrendCardCta,
} = require('./_shared/trend-matcher');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const MARKET_LABELS = { coupang: '쿠팡', naver: '네이버', toss: '토스쇼핑' };

function weekRange() {
  const now = new Date();
  const end = new Date(now);
  end.setUTCHours(23, 59, 59, 999);
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - 6);
  start.setUTCHours(0, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString() };
}
function prevWeekRange() {
  const { start } = weekRange();
  const prevEnd = new Date(start);
  prevEnd.setUTCMilliseconds(prevEnd.getUTCMilliseconds() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - 6);
  prevStart.setUTCHours(0, 0, 0, 0);
  return { start: prevStart.toISOString(), end: prevEnd.toISOString() };
}

async function getProfitCard(admin, sellerId) {
  const range = weekRange();
  const prev = prevWeekRange();

  const [costSettings, feeRows, orders, prevOrders] = await Promise.all([
    admin.from('seller_cost_settings').select('*').eq('seller_id', sellerId).maybeSingle().then(r => r.data || {
      packaging_cost_per_unit: 500, shipping_cost_per_unit: 3000, ad_spend_ratio: 0.0,
      payment_fee_ratio: 3.30, vat_applicable: true, market_fee_overrides: {},
    }),
    admin.from('market_fee_table').select('market, category_key, fee_ratio').eq('active', true).then(r => r.data || []),
    admin.from('marketplace_orders')
      .select('id, market, total_price, quantity, status, created_at')
      .eq('seller_id', sellerId)
      .in('status', ['paid', 'shipping', 'delivered'])
      .gte('created_at', range.start).lte('created_at', range.end)
      .then(r => r.data || []),
    admin.from('marketplace_orders')
      .select('id, market, total_price, quantity, status, created_at')
      .eq('seller_id', sellerId)
      .in('status', ['paid', 'shipping', 'delivered'])
      .gte('created_at', prev.start).lte('created_at', prev.end)
      .then(r => r.data || []),
  ]);

  const feeMap = buildMarketFeeMap(feeRows);
  const totals = calculatePeriodProfit(orders, costSettings, feeMap);
  const prevTotals = calculatePeriodProfit(prevOrders, costSettings, feeMap);
  const deltaPct = calculateDelta(totals.netProfit, prevTotals.netProfit);

  return {
    period: 'week',
    headline: buildProfitMessage(totals, deltaPct),
    net_profit: totals.netProfit,
    gross_revenue: totals.grossRevenue,
    profit_margin: totals.profitMargin,
    delta_pct: deltaPct,
    breakdown: {
      market_fees: totals.marketFees,
      ad_spend: totals.adSpend,
      packaging: totals.packagingCost,
      shipping: totals.shippingCost,
      payment_fees: totals.paymentFees,
      vat: totals.vat,
    },
    order_count: totals.orderCount,
  };
}

async function getSyncCard(admin, sellerId) {
  const r = await fetchSyncStatus(admin, sellerId);
  const cards = (r.statuses || []).map(s => {
    const msg = buildHealthMessage(s);
    return {
      market: s.market,
      market_label: MARKET_LABELS[s.market] || s.market,
      health_status: s.health_status,
      tone: msg.tone,
      message: msg.text,
      last_synced_at: s.last_synced_at,
      orders_24h: s.orders_synced_24h,
    };
  });

  const failing = cards.filter(c => c.health_status === 'failing').length;
  const degraded = cards.filter(c => c.health_status === 'degraded').length;
  let headline = '모든 마켓 정상';
  let tone = 'ok';
  if (failing > 0) { headline = `${failing}개 마켓 점검 필요`; tone = 'error'; }
  else if (degraded > 0) { headline = `${degraded}개 일시 불안정`; tone = 'warn'; }

  return { headline, tone, markets: cards };
}

async function getTrendCard(admin, sellerId) {
  // 셀러 프로필
  let industry = 'shop';
  try {
    const { data } = await admin.from('sellers').select('industry').eq('id', sellerId).maybeSingle();
    if (data?.industry) industry = data.industry;
  } catch (_) {}

  // 보유 상품 키워드 + 거절
  let productKeywords = [];
  let dismissedKeywords = new Set();
  try {
    const { data: products } = await admin.from('products').select('title').eq('seller_id', sellerId).limit(30);
    for (const p of products || []) {
      if (p.title) productKeywords.push(...String(p.title).split(/\s+/).filter(w => w.length >= 2 && w.length <= 12));
    }
    productKeywords = [...new Set(productKeywords)].slice(0, 30);
  } catch (_) {}
  try {
    const { data: dms } = await admin.from('trend_dismissals').select('trend_keyword').eq('seller_id', sellerId);
    const counts = new Map();
    for (const d of dms || []) counts.set(d.trend_keyword, (counts.get(d.trend_keyword) || 0) + 1);
    for (const [k, c] of counts.entries()) if (c >= 3) dismissedKeywords.add(k);
  } catch (_) {}

  // 트렌드 키워드
  const indMap = {
    cafe: ['cafe', 'food'], restaurant: ['food'], beauty: ['beauty', 'hair', 'nail'],
    hair: ['hair'], nail: ['nail'], florist: ['flower'], fashion: ['fashion'],
    fitness: ['fitness'], pet: ['pet'], kids: ['kids'], shop: ['shop'],
  };
  const cats = [...(indMap[industry] || ['shop']), 'all'];
  let trendRows = [];
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data } = await admin
      .from('trend_keywords')
      .select('keyword, category, weighted_score, velocity_pct, signal_tier, is_new, sub_category')
      .in('category', cats)
      .gte('collected_date', cutoff)
      .order('weighted_score', { ascending: false })
      .limit(30);
    trendRows = (data || []).map(r => ({
      keyword: r.keyword, category: r.category,
      velocity_pct: r.velocity_pct || 0, signal_tier: r.signal_tier || (r.is_new ? 'rising' : 'general'),
    }));
  } catch (_) {}

  // 시즌 이벤트 보강
  let seasonEvents = [];
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await admin.from('season_events').select('*').eq('active', true).gte('event_date', today).order('event_date');
    seasonEvents = data || [];
  } catch (_) {}
  trendRows = enrichWithSeasonEvents(trendRows, seasonEvents);

  const matches = matchTrendsToSeller(trendRows, { industry, productKeywords, dismissedKeywords }, { limit: 3, minScore: 30 });
  const cards = matches.map(m => ({
    ...m,
    cta_label: buildTrendCardCta(m),
    register_href: `/register-product?from=trend&keyword=${encodeURIComponent(m.keyword)}&category=${encodeURIComponent(m.category)}&min_price=${m.estimated_revenue_min}&max_price=${m.estimated_revenue_max}`,
  }));

  return {
    headline: cards.length > 0 ? '오늘 사장님께 어울리는 키워드' : '오늘 새 키워드를 찾고 있어요',
    cards,
    industry,
  };
}

async function getLiveFeedCard(admin, sellerId) {
  const r = await fetchRecentEvents(admin, sellerId, { limit: 5 });
  return {
    headline: r.events.length > 0 ? '최근 알림' : '새 알림이 없어요',
    events: (r.events || []).map(e => ({
      id: e.id,
      type: e.event_type,
      title: e.title,
      message: e.message,
      icon: e.icon,
      severity: e.severity,
      created_at: e.created_at,
      read: !!e.read_at,
    })),
  };
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

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase 초기화 실패' }) };
  }

  try {
    // 5개 카드 병렬 조회
    const [trendCard, priorityResult, profitCard, syncCard, liveFeed] = await Promise.all([
      getTrendCard(admin, sellerId).catch(() => ({ headline: '트렌드 데이터를 불러오는 중', cards: [] })),
      buildPriorityCards(admin, sellerId).catch(() => ({ ok: false, cards: [], totals: {} })),
      getProfitCard(admin, sellerId).catch(() => null),
      getSyncCard(admin, sellerId).catch(() => ({ headline: '동기화 상태 확인 중', tone: 'info', markets: [] })),
      getLiveFeedCard(admin, sellerId).catch(() => ({ headline: '알림 없음', events: [] })),
    ]);

    // 셀러 인사
    let businessName = '사장님';
    try {
      const { data } = await admin.from('sellers').select('business_name').eq('id', sellerId).maybeSingle();
      if (data?.business_name) businessName = `${data.business_name} 사장님`;
    } catch (_) {}

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        greeting: `안녕하세요, ${businessName}`,
        // 시장 중심 피벗 = 트렌드를 1번에
        cards: {
          trend: trendCard,                                     // 1번 (NEW MAIN)
          priority: {                                            // 2번 (처리할 일)
            cards: priorityResult.cards || [],
            totals: priorityResult.totals || {},
          },
          profit: profitCard,                                    // 3번 (이번 주 순이익)
          sync: syncCard,                                        // 4번 (마켓 헬스)
          live: liveFeed,                                        // 5번 (실시간 알림)
        },
        updatedAt: new Date().toISOString(),
      }),
    };
  } catch (e) {
    console.error('[dashboard-summary] error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
