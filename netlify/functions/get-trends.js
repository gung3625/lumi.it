const { getStore } = require('@netlify/blobs');

// 업종 라벨
const CATEGORY_LABELS = {
  cafe: '카페·음료',
  food: '음식·외식',
  beauty: '뷰티·케어',
  flower: '꽃집·플라워',
  fashion: '패션·의류',
  fitness: '헬스·필라테스',
  pet: '반려동물·펫',
  interior: '인테리어·가구',
  education: '학원·교육',
  laundry: '세탁·수선',
  studio: '사진·스튜디오',
  other: '일반',
};

// 월별 시즌 키워드 (last30days 데이터 없을 때 최소 fallback)
const SEASON_EVENTS = {
  1: ['신년', '새해', '겨울간식', '따뜻한음료'],
  2: ['발렌타인', '딸기시즌', '봄신메뉴', '설날'],
  3: ['벚꽃', '봄나들이', '화이트데이', '봄맞이'],
  4: ['봄꽃', '피크닉', '야외테라스', '꽃놀이'],
  5: ['어버이날', '스승의날', '가정의달', '감사이벤트'],
  6: ['여름시작', '빙수', '아이스메뉴', '냉면'],
  7: ['빙수', '여름휴가', '수박', '시즌한정'],
  8: ['가을준비', '얼리가을', '빙수라스트', '방학'],
  9: ['추석', '명절선물', '단풍', '가을감성'],
  10: ['핼러윈', '단풍', '가을축제', '고구마'],
  11: ['수능', '블랙프라이데이', '겨울준비', '연말'],
  12: ['크리스마스', '연말파티', '겨울한정', '송년'],
};

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

function getSeasonInfo() {
  const month = new Date().getMonth() + 1;
  const now = SEASON_EVENTS[month] || [];
  const next = SEASON_EVENTS[(month % 12) + 1] || [];
  return { now, upcoming: next.slice(0, 3) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const params = new URLSearchParams(event.rawQuery || '');
  const category = params.get('category') || 'cafe';
  const scope = params.get('scope') || '';  // 'domestic', 'global', or '' (default=combined)
  const knownCategories = ['cafe', 'food', 'beauty', 'flower', 'fashion', 'fitness', 'pet', 'interior', 'education', 'laundry', 'studio'];
  const storeKey = knownCategories.includes(category) ? category : 'other';
  const season = getSeasonInfo();
  const label = CATEGORY_LABELS[storeKey] || '일반';

  try {
    const store = getStore({
      name: 'trends',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN,
    });

    // scope=domestic 또는 scope=global → GPT 분류 결과 반환
    if (scope === 'domestic' || scope === 'global') {
      const scopeKey = `l30d-${scope}:${storeKey}`;
      const prevKey = `l30d-${scope}-prev:${storeKey}`;
      let scopeRaw = null;
      let prevRaw = null;
      try { scopeRaw = await store.get(scopeKey); } catch(e) {}
      try { prevRaw = await store.get(prevKey); } catch(e) {}

      if (scopeRaw) {
        const scopeData = JSON.parse(scopeRaw);
        const prevData = prevRaw ? JSON.parse(prevRaw) : null;
        const prevKeywords = prevData && prevData.keywords ? prevData.keywords.map(k => (k.keyword || '').replace(/^#/, '')) : [];

        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({
            category: storeKey,
            categoryLabel: label,
            scope,
            keywords: (scopeData.keywords || []).map((k, i) => {
              const kw = (k.keyword || '').replace(/^#/, '');
              const prevIdx = prevKeywords.indexOf(kw);
              let rankChange = null;
              if (prevIdx === -1) rankChange = 'new';
              else if (prevIdx > i) rankChange = prevIdx - i;
              else if (prevIdx < i) rankChange = prevIdx - i;
              else rankChange = 0;
              return {
                keyword: kw,
                source: k.source || 'gpt-classified',
                rank: i + 1,
                rankChange,
              };
            }),
            insight: scopeData.insight || '',
            season: scope === 'domestic' ? season : undefined,
            updatedAt: scopeData.updatedAt || new Date().toISOString(),
            source: 'gpt-classified',
          }),
        };
      }

      // 데이터 없으면 빈 응답
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          category: storeKey,
          categoryLabel: label,
          scope,
          keywords: [],
          insight: '',
          season: scope === 'domestic' ? season : undefined,
          updatedAt: new Date().toISOString(),
          source: 'none',
        }),
      };
    }

    // 기존 합산 데이터 (scope 미지정)
    let l30dRaw = null;
    try { l30dRaw = await store.get('l30d:' + storeKey); } catch(e) {}

    if (l30dRaw) {
      const l30d = JSON.parse(l30dRaw);
      if (l30d.keywords && l30d.keywords.length > 0) {
        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({
            category: storeKey,
            categoryLabel: label,
            keywords: l30d.keywords.map(k => ({
              keyword: k.keyword.replace(/^#/, ''),
              score: k.score || 0,
              mentions: k.mentions || 0,
              trend: 'up',
              source: 'last30days',
            })),
            season,
            updatedAt: l30d.updatedAt || new Date().toISOString(),
            source: 'last30days',
            findingsCount: l30d.findingsCount || null,
            dataSources: l30d.sources || null,
              insights: l30d.insights || '',
          }),
        };
      }
    }

    // trends: 키 fallback (태그만 있는 경우)
    let trendsRaw = null;
    try { trendsRaw = await store.get('trends:' + storeKey); } catch(e) {}

    if (trendsRaw) {
      const cached = JSON.parse(trendsRaw);
      if (cached.tags && cached.tags.length > 0) {
        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({
            category: storeKey,
            categoryLabel: label,
            keywords: cached.tags.map(tag => ({
              keyword: tag.replace(/^#/, ''),
              trend: 'up',
              source: cached.source || 'last30days',
            })),
            season,
            updatedAt: cached.updatedAt || new Date().toISOString(),
            source: cached.source || 'last30days',
          }),
        };
      }
    }
  } catch(e) {
    console.error('get-trends error:', e.message);
  }

  // 데이터 없으면 시즌 키워드만 반환
  return {
    statusCode: 200, headers: CORS,
    body: JSON.stringify({
      category: storeKey,
      categoryLabel: label,
      keywords: season.now.map(s => ({ keyword: s, trend: 'up', source: 'season' })),
      season,
      updatedAt: new Date().toISOString(),
      source: 'season',
    }),
  };
};
