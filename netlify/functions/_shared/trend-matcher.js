// trend-matcher.js — Sprint 4 시장 중심 피벗 (메모리 project_market_centric_pivot_0428.md)
// 셀러 카테고리 + 보유 상품 + 트렌드 키워드 → 매칭 점수 → 추천 카드
//
// 입력: 셀러 industry, 보유 상품 키워드, 트렌드 키워드 7소스
// 출력: { keyword, category, match_score, match_reason, velocity_pct, season_event }

/**
 * 셀러 industry → 트렌드 카테고리 매핑
 */
const INDUSTRY_TO_CATEGORY = {
  cafe: ['cafe', 'food'],
  restaurant: ['food'],
  beauty: ['beauty', 'hair', 'nail'],
  hair: ['hair', 'beauty'],
  nail: ['nail', 'beauty'],
  florist: ['flower'],
  fashion: ['fashion'],
  fitness: ['fitness', 'health'],
  pet: ['pet'],
  kids: ['kids'],
  shop: ['shop'],
  studio: ['shop'],
  interior: ['shop'],
  education: ['kids'],
};

/**
 * 평균 매출 추정 가격대 (카테고리 × 셀러 평균 단가)
 */
const ESTIMATED_REVENUE_RANGE = {
  cafe: { min: 8000, max: 25000 },
  food: { min: 12000, max: 45000 },
  beauty: { min: 15000, max: 60000 },
  hair: { min: 25000, max: 80000 },
  nail: { min: 25000, max: 80000 },
  flower: { min: 18000, max: 55000 },
  fashion: { min: 25000, max: 90000 },
  fitness: { min: 20000, max: 80000 },
  health: { min: 15000, max: 60000 },
  pet: { min: 12000, max: 50000 },
  kids: { min: 18000, max: 65000 },
  shop: { min: 12000, max: 45000 },
  default: { min: 15000, max: 50000 },
};

/**
 * 키워드 매칭 점수 계산
 * @param {Object} trendKw — { keyword, category, velocity_pct, signal_tier }
 * @param {Object} sellerProfile — { industry, productKeywords: [], dismissedKeywords: Set }
 * @returns {number} 0.00 ~ 100.00
 */
function calculateMatchScore(trendKw, sellerProfile) {
  if (!trendKw || !trendKw.keyword) return 0;

  // 거절 키워드는 완전 제외
  if (sellerProfile?.dismissedKeywords?.has(trendKw.keyword)) return 0;

  let score = 0;

  // 1. 카테고리 매칭 (최대 40점)
  const sellerCats = INDUSTRY_TO_CATEGORY[sellerProfile?.industry] || [];
  if (sellerCats.includes(trendKw.category)) {
    score += 40;
  } else if (trendKw.category === 'all') {
    score += 15;
  }

  // 2. velocity (급상승 가속도, 최대 30점)
  const velocity = Number(trendKw.velocity_pct || 0);
  if (velocity >= 300) score += 30;
  else if (velocity >= 200) score += 25;
  else if (velocity >= 100) score += 18;
  else if (velocity >= 50) score += 10;
  else if (velocity > 0) score += 5;

  // 3. signal_tier (신호 강도, 최대 15점)
  if (trendKw.signal_tier === 'rising') score += 15;
  else if (trendKw.signal_tier === 'peaking') score += 12;
  else if (trendKw.signal_tier === 'season') score += 13;

  // 4. 셀러 보유 상품 키워드 매칭 (최대 15점)
  const productKws = sellerProfile?.productKeywords || [];
  const trendLower = (trendKw.keyword || '').toLowerCase();
  const overlapCount = productKws.filter(pk =>
    trendLower.includes((pk || '').toLowerCase()) ||
    (pk || '').toLowerCase().includes(trendLower)
  ).length;
  if (overlapCount > 0) {
    score += Math.min(15, overlapCount * 5);
  }

  return Math.round(Math.min(100, score) * 100) / 100;
}

/**
 * 매칭 사유 친절한 카피 (메모리 카피 톤)
 */
function buildMatchReason(trendKw, sellerProfile, score) {
  const parts = [];
  const sellerCats = INDUSTRY_TO_CATEGORY[sellerProfile?.industry] || [];
  if (sellerCats.includes(trendKw.category)) {
    parts.push('사장님 매장에 잘 어울려요');
  }
  const velocity = Number(trendKw.velocity_pct || 0);
  if (velocity >= 200) parts.push(`+${velocity}% 급상승`);
  else if (velocity >= 50) parts.push(`+${velocity}% 상승`);

  if (trendKw.signal_tier === 'rising') parts.push('지금 뜨고 있어요');
  if (trendKw.season_event) parts.push(`${trendKw.season_event} 시즌`);

  if (parts.length === 0) {
    parts.push(score >= 50 ? '관심 가질 만한 키워드' : '참고 트렌드');
  }
  return parts.join(' · ');
}

/**
 * 매출 추정 범위 계산
 */
function estimateRevenue(trendKw) {
  const range = ESTIMATED_REVENUE_RANGE[trendKw.category] || ESTIMATED_REVENUE_RANGE.default;
  // velocity 기반 가중치 (높을수록 가격대 ↑)
  const velocity = Number(trendKw.velocity_pct || 0);
  const factor = velocity >= 200 ? 1.15 : velocity >= 100 ? 1.0 : 0.85;
  return {
    min: Math.round(range.min * factor),
    max: Math.round(range.max * factor),
  };
}

/**
 * 트렌드 키워드 배열 → 매칭된 추천 카드 배열
 * 상위 N개만 반환 (default 5)
 */
function matchTrendsToSeller(trendKeywords, sellerProfile, opts = {}) {
  const limit = opts.limit || 5;
  const minScore = opts.minScore || 30;

  const matched = (trendKeywords || [])
    .map(kw => {
      const score = calculateMatchScore(kw, sellerProfile);
      if (score < minScore) return null;

      const revenue = estimateRevenue(kw);
      return {
        keyword: kw.keyword,
        category: kw.category,
        match_score: score,
        match_reason: buildMatchReason(kw, sellerProfile, score),
        velocity_pct: Number(kw.velocity_pct || 0),
        signal_tier: kw.signal_tier || null,
        estimated_revenue_min: revenue.min,
        estimated_revenue_max: revenue.max,
        season_event: kw.season_event || null,
        season_peak_at: kw.season_peak_at || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, limit);

  return matched;
}

/**
 * 시즌 이벤트 → 트렌드 키워드 보강
 * @param {Array} trendKeywords
 * @param {Array} seasonEvents — season_events DB rows
 * @param {Date} now
 */
function enrichWithSeasonEvents(trendKeywords, seasonEvents, now) {
  const today = now || new Date();
  const enriched = [...(trendKeywords || [])];

  for (const ev of seasonEvents || []) {
    const eventDate = new Date(ev.event_date);
    const daysUntil = Math.ceil((eventDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    if (daysUntil < -2 || daysUntil > (ev.alert_lead_days || 14)) continue;

    for (const kw of (ev.related_keywords || [])) {
      // 이미 트렌드에 있으면 메타만 보강
      const existing = enriched.find(t => t.keyword === kw);
      if (existing) {
        existing.season_event = ev.event_name;
        existing.season_peak_at = ev.event_date;
        if (!existing.signal_tier) existing.signal_tier = 'season';
        continue;
      }
      // 없으면 시즌 키워드 추가
      enriched.push({
        keyword: kw,
        category: (ev.related_categories && ev.related_categories[0]) || 'all',
        velocity_pct: 250,
        signal_tier: 'season',
        season_event: ev.event_name,
        season_peak_at: ev.event_date,
        source: 'season_event',
      });
    }
  }

  return enriched;
}

/**
 * 친절한 CTA 카피
 */
function buildTrendCardCta(trendKw) {
  if (trendKw.season_event) {
    return '시즌 임박 — 지금 등록';
  }
  if ((trendKw.velocity_pct || 0) >= 200) {
    return '지금 등록하기';
  }
  return '내 매장에 등록';
}

module.exports = {
  calculateMatchScore,
  buildMatchReason,
  estimateRevenue,
  matchTrendsToSeller,
  enrichWithSeasonEvents,
  buildTrendCardCta,
  INDUSTRY_TO_CATEGORY,
  ESTIMATED_REVENUE_RANGE,
};
