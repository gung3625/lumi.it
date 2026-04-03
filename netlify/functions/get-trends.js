const { getStore } = require('@netlify/blobs');
const googleTrends = require('google-trends-api');

// 월별 시즌 키워드 (소상공인 게시물·캡션용)
const SEASON_KEYWORDS = {
  1: ['신년', '새해', '겨울간식', '따뜻한음료', '연말정산'],
  2: ['발렌타인', '초콜릿', '딸기시즌', '봄신메뉴', '설날'],
  3: ['벚꽃', '봄나들이', '화이트데이', '개강', '봄맞이'],
  4: ['봄꽃', '피크닉', '야외테라스', '꽃놀이', '봄한정'],
  5: ['어버이날', '스승의날', '가정의달', '선물세트', '감사이벤트'],
  6: ['여름시작', '빙수', '아이스메뉴', '시원한', '냉면'],
  7: ['빙수', '여름휴가', '수박', '아이스크림', '시즌한정'],
  8: ['여름끝물', '가을준비', '빙수라스트', '얼리가을', '방학'],
  9: ['가을신메뉴', '추석', '명절선물', '단풍', '가을감성'],
  10: ['핼러윈', '단풍', '가을축제', '밤', '고구마'],
  11: ['수능', '블랙프라이데이', '김장', '겨울준비', '연말'],
  12: ['크리스마스', '연말파티', '겨울한정', '선물세트', '송년']
};

// 업종별 Google Trends 카테고리 코드 + 실용 트렌드 키워드
const CATEGORY_CONFIG = {
  cafe: {
    code: 71,
    keywords: ['크로플', '약과라떼', '생딸기', '당일케이크', '소금빵', '뚱카롱', '수플레', '흑임자'],
    label: '카페·음료'
  },
  food: {
    code: 71,
    keywords: ['오마카세', '숙성고기', '밀키트', '브런치', '비건', '제철해산물', '로컬맛집', '혼밥세트'],
    label: '음식·외식'
  },
  beauty: {
    code: 44,
    keywords: ['글레이즈네일', '레이어드컷', '두피케어', '속눈썹펌', '워터웨이브', '톤온톤염색', '클린뷰티', '피부장벽'],
    label: '뷰티·케어'
  },
  other: {
    code: 18,
    keywords: ['당일배송', '한정판', '콜라보', '팝업스토어', '소량입고', '시즌오프', '얼리버드', '신상입고'],
    label: '일반'
  }
};

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

// 현재 월 기반 시즌 키워드 반환
function getSeasonKeywords() {
  const month = new Date().getMonth() + 1;
  const current = SEASON_KEYWORDS[month] || [];
  const next = SEASON_KEYWORDS[(month % 12) + 1] || [];
  return {
    now: current,
    upcoming: next.slice(0, 3)
  };
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
    try { raw = await store.get('gtrends2:' + storeKey); } catch(e) {}

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

  // 2. Google Trends + 시즌 키워드
  const keywordTrends = await fetchKeywordTrends(storeKey);
  const season = getSeasonKeywords();

  const config = CATEGORY_CONFIG[storeKey] || CATEGORY_CONFIG.other;
  const responseData = {
    category: storeKey,
    categoryLabel: config.label,
    keywords: keywordTrends,  // 업종별 키워드 변화율
    season,                   // 시즌 키워드 (now + upcoming)
    updatedAt: new Date().toISOString(),
    source: keywordTrends.length > 0 ? 'google' : 'season-only'
  };

  // 3. 캐시 저장
  if (store && keywordTrends.length > 0) {
    try {
      await store.set('gtrends2:' + storeKey, JSON.stringify({ data: responseData, timestamp: Date.now() }));
    } catch(e) {}
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify(responseData) };
};
