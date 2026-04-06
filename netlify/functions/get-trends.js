const { getStore } = require('@netlify/blobs');

// 업종+월별 맞춤 트렌드 키워드 (API 실패 시에도 항상 유용한 데이터 제공)
const BIZ_MONTHLY = {
  cafe: {
    label: '카페·음료',
    monthly: {
      1: ['신년라떼', '겨울딸기', '따뜻한음료추천', '카페신메뉴', '핫초코'],
      2: ['딸기라떼', '발렌타인케이크', '생딸기디저트', '봄메뉴준비', '초콜릿음료'],
      3: ['벚꽃라떼', '봄시즌음료', '화이트데이케이크', '개강카페', '꽃디저트'],
      4: ['야외테라스', '봄피크닉세트', '아이스시즌시작', '크로플', '꽃빙수'],
      5: ['어버이날케이크', '카네이션케이크', '아이스음료', '시즌과일디저트', '테이크아웃세트'],
      6: ['빙수시즌', '아이스신메뉴', '망고디저트', '수박주스', '냉음료추천'],
      7: ['빙수맛집', '여름한정메뉴', '수박빙수', '아이스크림', '에이드신메뉴'],
      8: ['얼리가을메뉴', '복숭아디저트', '빙수라스트', '가을준비신메뉴', '아이스할인'],
      9: ['가을음료', '추석선물세트', '밤라떼', '단풍카페', '고구마라떼'],
      10: ['핼러윈디저트', '단풍피크닉', '밤디저트', '고구마케이크', '가을한정'],
      11: ['수능음료세트', '겨울신메뉴', '연말케이크예약', '따뜻한라떼', '크리스마스준비'],
      12: ['크리스마스케이크', '연말파티세트', '겨울한정음료', '딸기케이크', '송년모임']
    }
  },
  food: {
    label: '음식·외식',
    monthly: {
      1: ['신년회식', '겨울보양식', '따끈한국물', '떡국맛집', '새해모임'],
      2: ['발렌타인디너', '딸기맛집', '봄나물', '설날맛집', '겨울별미'],
      3: ['봄나들이도시락', '제철해산물', '브런치맛집', '화이트데이디너', '봄한정메뉴'],
      4: ['야외테라스', '피크닉도시락', '봄제철', '꽃놀이세트', '가든레스토랑'],
      5: ['어버이날외식', '가정의달이벤트', '감사메뉴', '가족외식', '스승의날'],
      6: ['냉면시즌', '여름보양식', '콩국수', '삼계탕', '시원한메뉴'],
      7: ['복날삼계탕', '여름별미', '해산물축제', '야외바베큐', '시즌냉면'],
      8: ['가을메뉴준비', '제철과일', '얼리가을메뉴', '늦여름별미', '방학맛집'],
      9: ['추석선물세트', '가을제철', '명절메뉴', '송이버섯', '단풍맛집'],
      10: ['핼러윈파티', '가을축제', '제철대게', '밤고구마', '와인페어링'],
      11: ['수능이벤트', '김장철', '겨울메뉴시작', '연말모임예약', '블프이벤트'],
      12: ['크리스마스디너', '연말파티', '송년회세트', '겨울특선', '신년예약']
    }
  },
  beauty: {
    label: '뷰티·케어',
    monthly: {
      1: ['새해셀프케어', '겨울보습', '신년네일', '두피케어', '건조피부관리'],
      2: ['발렌타인네일', '봄헤어컬러', '피부장벽케어', '속눈썹펌', '봄맞이관리'],
      3: ['봄네일트렌드', '벚꽃컬러', '봄웨이브', '화이트데이네일', '피부톤업'],
      4: ['봄네일아트', '자외선차단', '레이어드컷', '꽃네일', '투명피부'],
      5: ['가정의달기프트', '웨딩헤어', '여름준비제모', '글로우업', '바디관리'],
      6: ['여름단발', '쿨톤네일', '바디스크럽', '여름펌', '시원한컬러'],
      7: ['여름네일', '바캉스헤어', '워터프루프', '시원한두피', '글레이즈네일'],
      8: ['가을헤어준비', '피부재생', '얼리가을컬러', '환절기케어', '보습관리'],
      9: ['가을네일', '추석관리', '톤다운컬러', '환절기피부', '가을웨이브'],
      10: ['핼러윈네일', '가을컬러체인지', '다크톤네일', '보습헤어팩', '촉촉피부'],
      11: ['겨울네일트렌드', '연말파티헤어', '크리스마스네일', '겨울보습', '연말관리'],
      12: ['크리스마스네일', '연말파티룩', '겨울헤어', '신년관리예약', '윈터컬러']
    }
  },
  other: {
    label: '일반',
    monthly: {
      1: ['신년세일', '새해이벤트', '겨울한정', '연초할인', '새해선물'],
      2: ['발렌타인기획', '봄신상', '설날이벤트', '딸기시즌', '봄맞이세일'],
      3: ['봄시즌오픈', '화이트데이', '신학기이벤트', '봄한정판', '벚꽃콜라보'],
      4: ['봄나들이세트', '피크닉기획', '야외이벤트', '꽃놀이특가', '시즌상품'],
      5: ['가정의달기획', '감사이벤트', '어버이날선물', '스승의날', '가족세트'],
      6: ['여름세일', '시즌오프', '아이스이벤트', '여름한정', '쿨서머기획'],
      7: ['여름대세일', '바캉스기획', '시즌한정', '여름특가', '핫서머이벤트'],
      8: ['얼리가을', '시즌마감세일', '가을신상', '방학이벤트', '여름끝물특가'],
      9: ['추석선물세트', '가을이벤트', '명절기획', '시즌오픈', '가을신상입고'],
      10: ['핼러윈이벤트', '가을축제', '시즌콜라보', '얼리윈터', '가을세일'],
      11: ['블랙프라이데이', '수능이벤트', '연말기획', '겨울신상', '크리스마스준비'],
      12: ['크리스마스기획', '연말세일', '송년이벤트', '겨울한정판', '신년준비']
    }
  }
};

// 월별 공통 시즌 이벤트
const SEASON_EVENTS = {
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

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

function getBizMonthlyKeywords(category) {
  const month = new Date().getMonth() + 1;
  const biz = BIZ_MONTHLY[category] || BIZ_MONTHLY.other;
  const keywords = biz.monthly[month] || [];
  return keywords.map((kw, i) => ({
    keyword: kw,
    changeRate: 0,
    trend: 'up',
    source: 'curated'
  }));
}

function getSeasonInfo() {
  const month = new Date().getMonth() + 1;
  const now = SEASON_EVENTS[month] || [];
  const next = SEASON_EVENTS[(month % 12) + 1] || [];
  return { now, upcoming: next.slice(0, 3) };
}

// Google Trends API (성공하면 실시간 데이터, 실패하면 null)
async function fetchGoogleTrends(category) {
  const biz = BIZ_MONTHLY[category] || BIZ_MONTHLY.other;
  const keywords = (biz.monthly[new Date().getMonth() + 1] || []).slice(0, 5);
  if (keywords.length === 0) return null;

  try {
    const googleTrends = require('google-trends-api');
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const data = await googleTrends.interestOverTime({
      keyword: keywords,
      geo: 'KR',
    });

    const parsed = JSON.parse(data);
    const timeline = parsed.default?.timelineData || [];
    if (timeline.length < 2) return null;

    const mid = Math.floor(timeline.length / 2);
    const lastWeek = timeline.slice(0, mid);
    const thisWeek = timeline.slice(mid);
    const results = [];

    for (let i = 0; i < keywords.length; i++) {
      const lastAvg = lastWeek.reduce((s, t) => s + (t.value?.[i] || 0), 0) / (lastWeek.length || 1);
      const thisAvg = thisWeek.reduce((s, t) => s + (t.value?.[i] || 0), 0) / (thisWeek.length || 1);
      let changeRate = 0;
      if (lastAvg > 0) changeRate = Math.round(((thisAvg - lastAvg) / lastAvg) * 100);
      else if (thisAvg > 0) changeRate = 100;

      results.push({
        keyword: keywords[i],
        changeRate,
        trend: changeRate > 10 ? 'up' : changeRate < -10 ? 'down' : 'stable',
        source: 'google'
      });
    }
    results.sort((a, b) => Math.abs(b.changeRate) - Math.abs(a.changeRate));
    return results;
  } catch(e) {
    console.error('Google Trends error:', e.message);
    return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const params = new URLSearchParams(event.rawQuery || '');
  const category = params.get('category') || 'cafe';
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
    try { raw = await store.get('gtrends3:' + storeKey); } catch(e) {}
    if (raw) {
      const cached = JSON.parse(raw);
      if ((Date.now() - cached.timestamp) / (1000 * 60 * 60) < 6) {
        return { statusCode: 200, headers: CORS, body: JSON.stringify(cached.data) };
      }
    }
  } catch(e) {
    console.error('Blobs init error:', e.message);
  }

  // 2. Google Trends 시도 → 실패 시 업종+월별 키워드 fallback
  const googleData = await fetchGoogleTrends(storeKey);
  const keywords = googleData || getBizMonthlyKeywords(storeKey);
  const season = getSeasonInfo();
  const biz = BIZ_MONTHLY[storeKey] || BIZ_MONTHLY.other;

  const responseData = {
    category: storeKey,
    categoryLabel: biz.label,
    keywords,
    season,
    updatedAt: new Date().toISOString(),
    source: googleData ? 'google' : 'curated'
  };

  // 3. 캐시 저장
  if (store) {
    try {
      await store.set('gtrends3:' + storeKey, JSON.stringify({ data: responseData, timestamp: Date.now() }));
    } catch(e) {}
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify(responseData) };
};
