const { getStore } = require('@netlify/blobs');
const googleTrends = require('google-trends-api');

// 업종별 Google Trends 카테고리 코드 + 추적 키워드
const CATEGORY_CONFIG = {
  cafe: {
    code: 71, // 음식·음료
    keywords: ['카페', '커피', '디저트', '베이커리', '브런치', '아메리카노', '라떼', '케이크'],
    label: '카페·음료'
  },
  food: {
    code: 71,
    keywords: ['맛집', '점심', '배달', '한식', '파스타', '고기', '회', '라멘'],
    label: '음식·외식'
  },
  beauty: {
    code: 44, // 뷰티·피트니스
    keywords: ['네일', '헤어', '피부관리', '속눈썹', '왁싱', '염색', '펌', '메이크업'],
    label: '뷰티·케어'
  },
  other: {
    code: 18, // 쇼핑
    keywords: ['이벤트', '할인', '신상', '추천', '인기', '트렌드', '선물', '시즌'],
    label: '일반'
  }
};

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

// Google Trends에서 일간 급상승 검색어 가져오기
async function fetchDailyTrends() {
  try {
    const result = await googleTrends.dailyTrends({ geo: 'KR' });
    const parsed = JSON.parse(result);
    const days = parsed.default?.trendingSearchesDays || [];
    const trends = [];

    for (const day of days.slice(0, 2)) { // 최근 2일
      for (const item of (day.trendingSearches || []).slice(0, 10)) {
        trends.push({
          keyword: item.title?.query || '',
          traffic: item.formattedTraffic || '',
          articles: (item.articles || []).slice(0, 1).map(a => ({
            title: a.title || '',
            source: a.source || ''
          }))
        });
      }
    }
    return trends.slice(0, 15);
  } catch(e) {
    console.error('dailyTrends error:', e.message);
    return [];
  }
}

// 업종별 키워드 관심도 변화 가져오기
async function fetchKeywordTrends(category) {
  const config = CATEGORY_CONFIG[category] || CATEGORY_CONFIG.other;
  const keywords = config.keywords.slice(0, 5); // 최대 5개씩

  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const results = [];

  try {
    const data = await googleTrends.interestOverTime({
      keyword: keywords,
      geo: 'KR',
      startTime: twoWeeksAgo,
      category: config.code
    });

    const parsed = JSON.parse(data);
    const timeline = parsed.default?.timelineData || [];

    if (timeline.length < 2) return [];

    // 전반부(지난주) vs 후반부(이번주) 평균 비교
    const mid = Math.floor(timeline.length / 2);
    const lastWeek = timeline.slice(0, mid);
    const thisWeek = timeline.slice(mid);

    for (let i = 0; i < keywords.length; i++) {
      const lastAvg = lastWeek.reduce((s, t) => s + (t.value?.[i] || 0), 0) / (lastWeek.length || 1);
      const thisAvg = thisWeek.reduce((s, t) => s + (t.value?.[i] || 0), 0) / (thisWeek.length || 1);

      let changeRate = 0;
      if (lastAvg > 0) {
        changeRate = Math.round(((thisAvg - lastAvg) / lastAvg) * 100);
      } else if (thisAvg > 0) {
        changeRate = 100;
      }

      results.push({
        keyword: keywords[i],
        thisWeek: Math.round(thisAvg),
        lastWeek: Math.round(lastAvg),
        changeRate,
        trend: changeRate > 10 ? 'up' : changeRate < -10 ? 'down' : 'stable'
      });
    }

    // 변화율 절대값 기준 정렬 (가장 큰 변화부터)
    results.sort((a, b) => Math.abs(b.changeRate) - Math.abs(a.changeRate));
    return results;
  } catch(e) {
    console.error('interestOverTime error:', e.message);
    return [];
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  let category = 'cafe';
  const params = new URLSearchParams(event.rawQuery || '');
  category = params.get('category') || 'cafe';

  const knownCategories = ['cafe', 'food', 'beauty'];
  const storeKey = knownCategories.includes(category) ? category : 'other';

  // 1. Blobs 캐시 확인 (6시간)
  let store;
  try {
    store = getStore({
      name: 'trends',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN
    });

    let raw = null;
    try { raw = await store.get('gtrends:' + storeKey); } catch(e) {}

    if (raw) {
      const cached = JSON.parse(raw);
      const hoursDiff = (Date.now() - cached.timestamp) / (1000 * 60 * 60);
      if (hoursDiff < 6) {
        return { statusCode: 200, headers: CORS, body: JSON.stringify(cached.data) };
      }
    }
  } catch(e) {
    console.error('Blobs init error:', e.message);
  }

  // 2. Google Trends 호출
  const [dailyTrends, keywordTrends] = await Promise.all([
    fetchDailyTrends(),
    fetchKeywordTrends(storeKey)
  ]);

  const config = CATEGORY_CONFIG[storeKey] || CATEGORY_CONFIG.other;
  const responseData = {
    category: storeKey,
    categoryLabel: config.label,
    daily: dailyTrends,       // 급상승 검색어
    keywords: keywordTrends,  // 업종별 키워드 변화율
    updatedAt: new Date().toISOString(),
    source: dailyTrends.length > 0 || keywordTrends.length > 0 ? 'google' : 'unavailable'
  };

  // 3. 캐시 저장
  if (store && (dailyTrends.length > 0 || keywordTrends.length > 0)) {
    try {
      await store.set('gtrends:' + storeKey, JSON.stringify({ data: responseData, timestamp: Date.now() }));
    } catch(e) {}
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify(responseData) };
};
