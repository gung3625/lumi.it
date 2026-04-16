const { getStore } = require('@netlify/blobs');

// 뻔한 상시 검색어 블랙리스트 (트렌드 카드에서 제외)
const BLACKLIST = [
  '맛집', '핫플레이스', '브런치', '카페', '맛집추천', '카페추천',
  '뷰티', '네일', '헤어', '피부관리', '다이어트',
  '인스타', '인스타그램', '팔로우', '좋아요',
  '일상', '데일리', '오늘', '주말',
  '서울', '강남', '홍대', '이태원', '성수',
  '맛있는', '예쁜', '좋은', '추천', '인기',
  '소통', '선팔', '맞팔', '팔로워',
  '먹스타그램', '카페스타그램', '맛스타그램',
  '푸드', '디저트', '음식', '요리',
  '패션', '코디', '스타일', '옷',
  '운동', '헬스', '피트니스',
  '반려동물', '강아지', '고양이',
  '꽃', '플라워', '꽃집',
  // 뉴스매체·신문사
  '중앙일보', '조선일보', '동아일보', '한겨레', '경향신문', '매일경제', '한국경제',
  '푸드투데이', '뉴시스', '연합뉴스', '노컷뉴스', '머니투데이', '헤럴드경제',
  // 경쟁 브랜드 (캡션 언급 금지 규칙과 동일)
  '스타벅스', '이디야커피', '이디야', '투썸플레이스', '투썸', '메가커피', '컴포즈커피',
  '빽다방', '할리스', '엔제리너스', '폴바셋', '블루보틀', '파스쿠찌',
  // 영어 뻔한 단어
  'coffee', 'cafe', 'desserts', 'dessert', 'menu', 'food', 'world', 'new', 'best',
  'love', 'like', 'good', 'free', 'sale', 'shop', 'store', 'day', 'time',
];

// 트렌드가 아닌 뻔한 콘텐츠 주제 키워드 (부분 매칭)
const FILLER_WORDS = [
  '아이디어', '방법', '추천', '정보', '모음', '리스트', '팁', '가이드',
  '비교', '순위', '종류', '차이', '후기', '리뷰', '장단점', '선택',
  '입문', '초보', '기초', '필수', '인기', '베스트', '총정리',
];

function filterBlacklist(keywords) {
  // 1. 중복 제거 (keyword 기준, 첫 등장만 유지)
  const seen = new Set();
  const deduped = keywords.filter(k => {
    const kw = (k.keyword || '').replace(/^#/, '').trim().toLowerCase();
    if (seen.has(kw)) return false;
    seen.add(kw);
    return true;
  });
  // 2. 블랙리스트 + 뻔한 콘텐츠 주제 필터
  const filtered = deduped.filter(k => {
    const kw = (k.keyword || '').replace(/^#/, '').trim().toLowerCase();
    if (BLACKLIST.includes(kw)) return false;
    if (FILLER_WORDS.some(fw => kw.includes(fw))) return false;
    return true;
  });
  return filtered.length >= 3 ? filtered : deduped;
}

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
  all: '종합',
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
  const rawCategory = (params.get('category') || 'cafe').trim();
  const scope = params.get('scope') || '';  // 'domestic', 'global', or '' (default=combined)
  const fromDate = params.get('from') || '';  // YYYY-MM-DD
  const toDate = params.get('to') || '';      // YYYY-MM-DD
  const knownCategories = ['cafe', 'food', 'beauty', 'flower', 'fashion', 'fitness', 'pet', 'interior', 'education', 'laundry', 'studio', 'all'];

  // 카테고리 별칭 매핑 (다양한 입력을 표준 키로 변환)
  const CATEGORY_ALIAS = {
    // 한글 별칭
    '카페': 'cafe', '카페·음료': 'cafe', '카페·베이커리': 'cafe', '커피': 'cafe', '베이커리': 'cafe',
    '음식점': 'food', '식당': 'food', '식당·음식점': 'food', '맛집': 'food', '레스토랑': 'food',
    '뷰티': 'beauty', '뷰티·케어': 'beauty', '뷰티·헤어·네일': 'beauty', '네일': 'beauty', '헤어': 'beauty', '미용실': 'beauty',
    '꽃집': 'flower', '꽃집·플라워': 'flower', '플라워': 'flower',
    '패션': 'fashion', '패션·의류': 'fashion', '쇼핑·의류': 'fashion', '의류': 'fashion',
    '헬스': 'fitness', '필라테스': 'fitness', '헬스·필라테스': 'fitness', '요가': 'fitness', '운동': 'fitness',
    '반려동물': 'pet', '반려동물·펫': 'pet', '펫': 'pet',
    '인테리어': 'interior', '인테리어·가구': 'interior', '인테리어·소품': 'interior', '가구': 'interior',
    '학원': 'education', '학원·교육': 'education', '교육': 'education',
    '세탁': 'laundry', '세탁·수선': 'laundry',
    '사진': 'studio', '사진·스튜디오': 'studio', '스튜디오': 'studio',
    '기타': 'other',
    // 영문 별칭
    'restaurant': 'food', 'bakery': 'cafe', 'hair': 'beauty', 'nail': 'beauty',
    'gym': 'fitness', 'pilates': 'fitness', 'yoga': 'fitness',
    'florist': 'flower', 'clothing': 'fashion',
    'health_fitness': 'fitness', 'bar': 'food',
  };

  const category = CATEGORY_ALIAS[rawCategory] || rawCategory;
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

    // from + to 있으면 날짜 범위 히스토리 조회
    if (fromDate && toDate) {
      const fromTs = new Date(fromDate).getTime();
      const toTs = new Date(toDate).getTime();
      if (isNaN(fromTs) || isNaN(toTs)) {
        return {
          statusCode: 400, headers: CORS,
          body: JSON.stringify({ error: 'from/to 날짜 형식이 올바르지 않습니다. YYYY-MM-DD 형식을 사용하세요.' }),
        };
      }

      // scope 기반 prefix 결정
      let prefix;
      if (scope === 'domestic') prefix = `l30d-domestic:${storeKey}:`;
      else if (scope === 'global') prefix = `l30d-global:${storeKey}:`;
      else prefix = `l30d:${storeKey}:`;

      const listResult = await store.list({ prefix });
      const blobs = (listResult && listResult.blobs) ? listResult.blobs : [];

      // 날짜 범위 필터링 후 데이터 조회
      const inRange = blobs.filter(b => {
        const match = b.key.match(/:(\d{4}-\d{2}-\d{2})$/);
        if (!match) return false;
        const ts = new Date(match[1]).getTime();
        return ts >= fromTs && ts <= toTs;
      }).sort((a, b) => {
        const da = a.key.match(/:(\d{4}-\d{2}-\d{2})$/)[1];
        const db = b.key.match(/:(\d{4}-\d{2}-\d{2})$/)[1];
        return da.localeCompare(db);
      });

      const history = [];
      for (const blob of inRange) {
        try {
          const raw = await store.get(blob.key);
          if (raw) {
            const dateMatch = blob.key.match(/:(\d{4}-\d{2}-\d{2})$/);
            history.push({ date: dateMatch ? dateMatch[1] : null, data: JSON.parse(raw) });
          }
        } catch(e) {}
      }

      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          category: storeKey,
          categoryLabel: label,
          scope: scope || 'combined',
          from: fromDate,
          to: toDate,
          history,
        }),
      };
    }

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
            keywords: filterBlacklist((scopeData.keywords || []).map((k, i) => ({
              keyword: (k.keyword || '').replace(/^#/, ''),
              source: k.source || 'gpt-classified',
              rank: i + 1,
              rankChange: (() => {
                const kw = (k.keyword || '').replace(/^#/, '');
                const prevIdx = prevKeywords.indexOf(kw);
                if (prevIdx === -1) return 'new';
                if (prevIdx !== i) return prevIdx - i;
                return 0;
              })(),
              ...(k.bizCategory ? { bizCategory: k.bizCategory } : {}),
            }))),
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
            keywords: filterBlacklist(l30d.keywords.map(k => ({
              keyword: k.keyword.replace(/^#/, ''),
              score: k.score || 0,
              mentions: k.mentions || 0,
              trend: 'up',
              source: 'last30days',
            }))),
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
            keywords: filterBlacklist(cached.tags.map(tag => ({
              keyword: tag.replace(/^#/, ''),
              trend: 'up',
              source: cached.source || 'last30days',
            }))),
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
