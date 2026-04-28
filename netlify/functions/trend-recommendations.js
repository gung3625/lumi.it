// trend-recommendations.js — Sprint 4 시장 중심 피벗 메인 API
// 셀러 카테고리 + 트렌드 7소스 → 매칭된 추천 카드 (모바일 홈 1번 카드 + PC 사이드바)
//
// 메모리 근거:
//   - project_market_centric_pivot_0428.md (시장 추천 1순위)
//   - project_proactive_ux_paradigm.md (선제 제안)
//
// GET /api/trend-recommendations?limit=5&minScore=30

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const {
  matchTrendsToSeller,
  enrichWithSeasonEvents,
  buildTrendCardCta,
} = require('./_shared/trend-matcher');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

/**
 * 셀러 industry 또는 보유 상품 카테고리 추출
 */
async function fetchSellerProfile(admin, sellerId) {
  try {
    const { data: seller } = await admin
      .from('sellers')
      .select('id, industry, business_name')
      .eq('id', sellerId)
      .maybeSingle();

    // 보유 상품 키워드 (Sprint 2 products 테이블)
    let productKeywords = [];
    try {
      const { data: products } = await admin
        .from('products')
        .select('title, category, keywords')
        .eq('seller_id', sellerId)
        .limit(50);
      for (const p of products || []) {
        if (p.title) {
          // 단순 단어 split
          const words = String(p.title).split(/\s+/).filter(w => w.length >= 2 && w.length <= 12);
          productKeywords.push(...words);
        }
        if (Array.isArray(p.keywords)) productKeywords.push(...p.keywords);
      }
      productKeywords = [...new Set(productKeywords)].slice(0, 30);
    } catch (_) {
      productKeywords = [];
    }

    // 거절 키워드 (3회+ 거절은 비활성)
    const dismissedKeywords = new Set();
    try {
      const { data: dismissals } = await admin
        .from('trend_dismissals')
        .select('trend_keyword')
        .eq('seller_id', sellerId);
      const counts = new Map();
      for (const d of dismissals || []) {
        counts.set(d.trend_keyword, (counts.get(d.trend_keyword) || 0) + 1);
      }
      for (const [kw, c] of counts.entries()) {
        if (c >= 3) dismissedKeywords.add(kw);
      }
    } catch (_) {}

    return {
      industry: seller?.industry || 'shop',
      businessName: seller?.business_name || '',
      productKeywords,
      dismissedKeywords,
    };
  } catch (e) {
    return {
      industry: 'shop',
      businessName: '',
      productKeywords: [],
      dismissedKeywords: new Set(),
    };
  }
}

/**
 * 트렌드 키워드 7소스 합산 (모든 카테고리 + 셀러 industry 우선)
 */
async function fetchTrendKeywords(admin, sellerProfile) {
  const result = [];
  const sellerCats = new Set();

  // industry → category 매핑 (trend-matcher INDUSTRY_TO_CATEGORY와 동일)
  const indMap = {
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
  };
  const cats = indMap[sellerProfile.industry] || ['shop', 'food', 'cafe'];
  cats.forEach(c => sellerCats.add(c));
  // all 추가 (종합)
  sellerCats.add('all');

  try {
    // trend_keywords 테이블 (Phase 2 v2)
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data, error } = await admin
      .from('trend_keywords')
      .select('keyword, category, weighted_score, velocity_pct, signal_tier, is_new, axis, narrative, sub_category, related_keywords')
      .in('category', Array.from(sellerCats))
      .gte('collected_date', cutoff)
      .order('weighted_score', { ascending: false })
      .limit(50);

    if (!error && data) {
      for (const row of data) {
        result.push({
          keyword: row.keyword,
          category: row.category,
          velocity_pct: row.velocity_pct || 0,
          signal_tier: row.signal_tier || (row.is_new ? 'rising' : 'general'),
          score: row.weighted_score || 0,
          narrative: row.narrative || null,
          sub_category: row.sub_category || null,
        });
      }
    }
  } catch (_) {}

  // fallback: trends 테이블 (legacy)
  if (result.length === 0) {
    try {
      const cats = Array.from(sellerCats);
      for (const c of cats.slice(0, 3)) {
        const { data } = await admin
          .from('trends')
          .select('keywords, collected_at')
          .eq('category', `l30d-domestic:${c}`)
          .maybeSingle();
        const items = data?.keywords?.keywords || [];
        for (const k of items.slice(0, 10)) {
          result.push({
            keyword: (k.keyword || '').replace(/^#/, ''),
            category: c,
            velocity_pct: 100,
            signal_tier: 'rising',
            score: k.score || 50,
          });
        }
      }
    } catch (_) {}
  }

  return result;
}

/**
 * 시즌 이벤트 조회 (D-N)
 */
async function fetchActiveSeasonEvents(admin, now) {
  const today = (now || new Date()).toISOString().slice(0, 10);
  try {
    const { data } = await admin
      .from('season_events')
      .select('*')
      .eq('active', true)
      .gte('event_date', today)
      .order('event_date');
    return data || [];
  } catch (_) {
    return [];
  }
}

/**
 * 매칭 결과를 seller_trend_matches에 upsert (셀러 액션 추적용)
 */
async function persistMatches(admin, sellerId, matches) {
  if (!matches || matches.length === 0) return;
  try {
    // 기존 만료 안 된 매칭은 그대로, 새로 들어오는 것만 추가
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const rows = matches.map(m => ({
      seller_id: sellerId,
      trend_keyword: m.keyword,
      trend_category: m.category,
      match_score: m.match_score,
      match_reason: m.match_reason,
      velocity_pct: m.velocity_pct,
      signal_tier: m.signal_tier,
      estimated_revenue_min: m.estimated_revenue_min,
      estimated_revenue_max: m.estimated_revenue_max,
      season_event: m.season_event,
      season_peak_at: m.season_peak_at,
      expires_at: expiresAt,
    }));
    await admin.from('seller_trend_matches').insert(rows);
  } catch (_) {}
}

/**
 * Mock 모드 (데이터 없을 때 베타 시연용)
 */
function buildMockRecommendations(industry) {
  const mock = {
    cafe: [
      { keyword: '말차 라떼', category: 'cafe', velocity_pct: 342, signal_tier: 'rising' },
      { keyword: '시즌 한정 케이크', category: 'cafe', velocity_pct: 215, signal_tier: 'rising' },
      { keyword: '아이스 크림 빙수', category: 'cafe', velocity_pct: 180, signal_tier: 'rising' },
    ],
    flower: [
      { keyword: '카네이션', category: 'flower', velocity_pct: 520, signal_tier: 'season', season_event: '어버이날', season_peak_at: '2026-05-08' },
      { keyword: '꽃다발', category: 'flower', velocity_pct: 230, signal_tier: 'rising' },
      { keyword: '봄 꽃', category: 'flower', velocity_pct: 145, signal_tier: 'rising' },
    ],
    fashion: [
      { keyword: '봄 시폰 원피스', category: 'fashion', velocity_pct: 342, signal_tier: 'rising' },
      { keyword: '린넨 셔츠', category: 'fashion', velocity_pct: 215, signal_tier: 'rising' },
      { keyword: '미디 스커트', category: 'fashion', velocity_pct: 168, signal_tier: 'rising' },
    ],
    food: [
      { keyword: '여름 보양식', category: 'food', velocity_pct: 280, signal_tier: 'season' },
      { keyword: '냉면 세트', category: 'food', velocity_pct: 195, signal_tier: 'rising' },
      { keyword: '도시락 메뉴', category: 'food', velocity_pct: 152, signal_tier: 'rising' },
    ],
    shop: [
      { keyword: '여름 텀블러', category: 'shop', velocity_pct: 185, signal_tier: 'rising' },
      { keyword: '캠핑 소품', category: 'shop', velocity_pct: 142, signal_tier: 'rising' },
      { keyword: '인테리어 디퓨저', category: 'shop', velocity_pct: 110, signal_tier: 'rising' },
    ],
  };

  const list = mock[industry] || mock.shop;
  return list.map(t => ({ ...t, score: 80 }));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // JWT 검증
  const token = extractBearerToken(event);
  const { payload, error: jwtErr } = verifySellerToken(token);
  if (jwtErr) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: jwtErr }) };
  }
  const sellerId = payload.seller_id;

  // 쿼리 파라미터
  const params = new URLSearchParams(event.rawQuery || '');
  const limit = Math.min(20, Math.max(1, parseInt(params.get('limit') || '5', 10)));
  const minScore = Math.max(0, parseInt(params.get('minScore') || '30', 10));
  const persist = params.get('persist') !== 'false';
  const mockMode = params.get('mock') === 'true' || process.env.TREND_RECO_MOCK === 'true';

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Supabase 초기화 실패' }),
    };
  }

  try {
    // 1. 셀러 프로필
    const sellerProfile = await fetchSellerProfile(admin, sellerId);

    // 2. 트렌드 키워드 (또는 mock)
    let trendKeywords = mockMode
      ? buildMockRecommendations(sellerProfile.industry)
      : await fetchTrendKeywords(admin, sellerProfile);

    // 3. 시즌 이벤트 보강
    const seasonEvents = await fetchActiveSeasonEvents(admin);
    trendKeywords = enrichWithSeasonEvents(trendKeywords, seasonEvents);

    // 4. 매칭
    const matches = matchTrendsToSeller(trendKeywords, sellerProfile, { limit, minScore });

    // 5. CTA 카피 추가
    const cards = matches.map(m => ({
      ...m,
      cta_label: buildTrendCardCta(m),
      // 등록 화면 직링크 (트렌드 키워드·카테고리·예상 가격 자동 입력)
      register_href: `/register-product?from=trend&keyword=${encodeURIComponent(m.keyword)}&category=${encodeURIComponent(m.category)}&min_price=${m.estimated_revenue_min}&max_price=${m.estimated_revenue_max}${m.season_event ? `&season=${encodeURIComponent(m.season_event)}` : ''}`,
    }));

    // 6. 영구화 (조회 추적용)
    if (persist && cards.length > 0) {
      await persistMatches(admin, sellerId, cards);
    }

    // 7. 친절한 메인 카피
    const headline = cards.length === 0
      ? '오늘 추천할 만한 새 키워드를 찾는 중이에요'
      : cards.length === 1
      ? '오늘 사장님께 어울리는 키워드 1개를 골라봤어요'
      : `오늘 사장님께 어울리는 키워드 ${cards.length}개를 골라봤어요`;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        headline,
        seller: {
          industry: sellerProfile.industry,
          businessName: sellerProfile.businessName,
        },
        cards,
        meta: {
          total_keywords: trendKeywords.length,
          season_events: seasonEvents.length,
          dismissed_count: sellerProfile.dismissedKeywords.size,
          mocked: mockMode,
        },
        updatedAt: new Date().toISOString(),
      }),
    };
  } catch (e) {
    console.error('[trend-recommendations] error:', e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '추천을 가져오지 못했어요. 잠시 후 다시 시도해 주세요.' }),
    };
  }
};
