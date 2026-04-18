// get-trends.js — Supabase public.trends 기반 리더 (Phase 1 재구축)
// scheduled-trends.js 가 저장한 category 키 포맷을 그대로 조회해서 기존 응답 포맷으로 반환
// 응답 포맷은 변경 없음 (프론트 호환 유지)

const { getAdminClient } = require('./_shared/supabase-admin');

// 뻔한 상시 검색어 블랙리스트
const BLACKLIST = new Set([
  '맛집', '핫플레이스', '브런치', '카페', '맛집추천', '카페추천',
  '뷰티', '네일', '헤어', '피부관리', '다이어트', '화장품',
  '인스타', '인스타그램', '팔로우', '좋아요',
  '일상', '데일리', '오늘', '주말',
  '서울', '강남', '홍대', '이태원', '성수',
  '맛있는', '예쁜', '좋은', '추천', '인기',
  '소통', '선팔', '맞팔', '팔로워',
  '먹스타그램', '카페스타그램', '맛스타그램', '뷰티스타그램', '일상스타그램',
  '푸드', '디저트', '음식', '요리',
  '패션', '코디', '스타일', '옷',
  '운동', '헬스', '피트니스',
  '반려동물', '강아지', '고양이',
  '꽃', '플라워', '꽃집',
  '중앙일보', '조선일보', '동아일보', '한겨레', '경향신문', '매일경제', '한국경제',
  '푸드투데이', '뉴시스', '연합뉴스', '노컷뉴스', '머니투데이', '헤럴드경제',
  '코스모폴리탄', '보그', '얼루어', '하퍼스바자', '마리끌레르',
  'jtbc', 'kbs', 'sbs', 'mbc', 'tvn',
  '스타벅스', '이디야커피', '이디야', '투썸플레이스', '투썸', '메가커피', '컴포즈커피',
  '빽다방', '할리스', '엔제리너스', '폴바셋', '블루보틀', '파스쿠찌',
  'coffee', 'cafe', 'desserts', 'dessert', 'menu', 'food', 'world', 'new', 'best',
  'love', 'like', 'good', 'free', 'sale', 'shop', 'store', 'day', 'time', 'news',
  // 복합 제네릭 카테고리 구문 (정확 매치)
  '디저트 맛집', '카페 맛집', '맛있는 카페', '핫한 카페', '좋은 카페',
  '카페 추천', '맛집 추천', '분위기 좋은 카페', '맛있는 디저트', '디저트 추천',
  '아침밥', '점심메뉴', '저녁메뉴', '브런치 카페',
  '예쁜 네일', '좋은 미용실', '머리 잘하는 곳', '예쁜 매장', '추천 네일샵',
  '맛집 탐방', '카페 투어', '디저트 카페', '핫플 카페', '인기 카페',
  '예쁜 카페', '감성 카페', '분위기 카페', '힙한 카페',
  '맛있는 음식', '음식 추천', '맛집 소개', '핫한 맛집', '인기 맛집',
  '예쁜 꽃집', '좋은 꽃집', '꽃집 추천', '플라워 추천',
  '좋은 헤어샵', '헤어 추천', '네일 추천', '뷰티 추천',
  '펫샵 추천', '좋은 펫샵', '아동복 추천',
  // 확립된 메뉴/식사 포맷/장르 — 카테고리 명사지 트렌드 아님
  '오마카세', '스시', '초밥', '회', '사시미', '라멘', '돈부리', '규동', '가츠동',
  '텐동', '우동', '소바', '이자카야',
  '삼겹살', '갈비', '곱창', '막창', '대창', '불고기', '김밥', '분식',
  '찜닭', '닭갈비', '순대국', '해장국', '감자탕',
  '파스타', '피자', '스테이크', '리조또', '샐러드', '햄버거', '샌드위치',
  '짜장면', '짬뽕', '탕수육', '마라탕', '마라샹궈',
  '커피', '아메리카노', '라떼', '에스프레소', '카푸치노',
  '케이크', '쿠키', '도넛', '마카롱', '와플', '크로플', '팬케이크',
  '빙수', '푸딩', '젤라또', '아이스크림', '타르트',
  '코스요리', '뷔페', '파인다이닝',
  // 가성비/가격 서술어 복합 구문
  '가성비 스시', '가성비 오마카세', '가성비 파스타', '가성비 스테이크',
  '저렴한 맛집', '합리적인 카페',
]);

// 제네릭 카테고리 패턴 정규식 (복합 구문 필터)
const GENERIC_PATTERNS = [
  /^.+(맛집|핫플|핫한곳|맛집추천|핫플레이스)$/,
  /^(맛있는|맛난|존맛|jmt|예쁜|이쁜|좋은|핫한|분위기\s*좋은|감성적?인?|힙한|인기\s*있는|유명한|요즘\s*뜨는|뷰\s*좋은|뷰맛집)\s*.+/,
  /^.+\s*(추천|소개|맛집|핫플|탐방|투어|모음|리스트)$/,
  /^(카페|맛집|디저트|헤어|네일|뷰티|꽃집|펫샵|헬스|필라테스)\s*(추천|소개|탐방|투어|모음|가이드|정보|리뷰|후기)$/,
  /^(가성비|저렴한|가격대비|합리적인?|가격\s*착한|혜자)\s*.+/,
  /^(핫한|힙한|요즘\s*뜨는|요즘\s*핫한|뜨는|떠오르는)\s*.+/,
  /^(가볼\s*만한|가볼만한|갈\s*만한|놓치면\s*안되는)\s*.+/,
  /^(숨은|히든|숨겨진)\s*.+/,
  /^(추천|인기)\s*.+/,
];

const FILLER_WORDS = [
  '아이디어', '방법', '추천', '정보', '모음', '리스트', '팁', '가이드',
  '비교', '순위', '종류', '차이', '후기', '리뷰', '장단점', '선택',
  '입문', '초보', '기초', '필수', '인기', '베스트', '총정리',
  '유행하는', '유행중', '트렌드는', '트렌드가', '트렌드의', '뜨는', '떠오르는',
  '화제', '화제의', '주목', '주목받는', '밝혀', '밝혔다', '공개',
  '라고', '이라고', '이라는', '라는', '했다', '이다', '된다',
  '관계자', '업계', '전문가', '시민', '네티즌',
];

function isBadKeyword(raw) {
  const kw = (raw || '').replace(/^#/, '').trim().toLowerCase();
  if (!kw) return true;
  if (kw.length < 2 || kw.length > 25) return true;
  if (BLACKLIST.has(kw)) return true;
  if (FILLER_WORDS.some(fw => kw.includes(fw))) return true;
  if ((kw.match(/\s/g) || []).length >= 3) return true;
  if (/[?!,.]/.test(kw)) return true;
  if (GENERIC_PATTERNS.some(re => re.test(kw))) return true;
  return false;
}

function filterBlacklist(keywords) {
  const seen = new Set();
  const deduped = keywords.filter(k => {
    const kw = (k.keyword || '').replace(/^#/, '').trim().toLowerCase();
    if (!kw || seen.has(kw)) return false;
    seen.add(kw);
    return true;
  });
  const filtered = deduped.filter(k => !isBadKeyword(k.keyword));
  return filtered.length >= 3 ? filtered : deduped;
}

// 업종 라벨
const CATEGORY_LABELS = {
  cafe: '카페·음료',
  food: '음식·외식',
  beauty: '뷰티·스킨케어',
  hair: '헤어',
  nail: '네일',
  flower: '꽃집·플라워',
  fashion: '패션·의류',
  fitness: '헬스·필라테스',
  health: '건강·헬스',
  pet: '반려동물·펫',
  interior: '인테리어·가구',
  education: '학원·교육',
  studio: '사진·스튜디오',
  kids: '키즈',
  shop: '공방·소품',
  all: '종합',
};

// hair/nail 서빙 시점 분리 필터
// beauty DB row에서 카테고리별로 해당 키워드만 추출
const HAIR_PATTERN = /펌|염색|커트|컷|헤어|볼륨|레이어드|탈모|두피|스타일링|매직|리본펌|세미|데미지|트리트먼트|샴푸|컬|웨이브|앞머리|뱅|단발|장발|중단발|아이롱|고데기/;
const NAIL_PATTERN = /네일|젤|아트|패디큐어|매니큐어|큐빅|오프|글리터|프렌치|누드네일|글로우네일|스톤네일|케어풀|젤네일|손톱|발톱/;
const BEAUTY_ONLY_PATTERN = /스킨|피부|메이크업|파운데이션|쿠션|립|아이섀도|마스카라|선크림|선블록|보습|세럼|에센스|앰플|클렌징|왁싱|속눈썹|눈썹|바디|향수|팩|마스크팩|토너|미스트|로션|크림|비비|씨씨|쿠션팩트/;

function splitBeautyCategory(keywords, requestedCat) {
  if (requestedCat === 'hair') {
    return keywords.filter(k => HAIR_PATTERN.test(k.keyword || ''));
  }
  if (requestedCat === 'nail') {
    return keywords.filter(k => NAIL_PATTERN.test(k.keyword || ''));
  }
  if (requestedCat === 'beauty') {
    // 헤어·네일 명확히 해당되는 것만 제외, 나머지는 beauty로 포함
    return keywords.filter(k => {
      const kw = k.keyword || '';
      const isHair = HAIR_PATTERN.test(kw) && !BEAUTY_ONLY_PATTERN.test(kw);
      const isNail = NAIL_PATTERN.test(kw) && !BEAUTY_ONLY_PATTERN.test(kw);
      return !(isHair || isNail);
    });
  }
  return keywords;
}

// 월별 시즌 키워드 (fallback)
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

// Supabase 단건 조회 (없으면 null)
async function fetchTrendRow(supa, categoryKey) {
  try {
    const { data, error } = await supa
      .from('trends')
      .select('keywords, collected_at')
      .eq('category', categoryKey)
      .maybeSingle();
    if (error) return null;
    return data || null;
  } catch(e) {
    return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const params = new URLSearchParams(event.rawQuery || '');
  const rawCategory = (params.get('category') || 'cafe').trim();
  const scope = params.get('scope') || '';  // 'domestic' or ''
  const fromDate = params.get('from') || '';
  const toDate = params.get('to') || '';
  // hair/nail/health/kids/shop 포함 — 프론트 TREND_CATS와 1:1 대응
  const knownCategories = ['cafe', 'food', 'beauty', 'hair', 'nail', 'flower', 'fashion', 'fitness', 'health', 'pet', 'interior', 'education', 'studio', 'kids', 'shop', 'all'];

  const CATEGORY_ALIAS = {
    '카페': 'cafe', '카페·음료': 'cafe', '카페·베이커리': 'cafe', '커피': 'cafe', '베이커리': 'cafe',
    '음식점': 'food', '식당': 'food', '식당·음식점': 'food', '맛집': 'food', '레스토랑': 'food',
    '뷰티': 'beauty', '뷰티·케어': 'beauty', '뷰티·스킨케어': 'beauty', '화장품': 'beauty', '스킨케어': 'beauty',
    '뷰티·헤어·네일': 'beauty',
    '헤어': 'hair', '미용실': 'hair', '헤어샵': 'hair', '헤어살롱': 'hair',
    '네일': 'nail', '네일샵': 'nail', '네일아트': 'nail',
    '꽃집': 'flower', '꽃집·플라워': 'flower', '플라워': 'flower',
    '패션': 'fashion', '패션·의류': 'fashion', '쇼핑·의류': 'fashion', '의류': 'fashion',
    '헬스': 'fitness', '필라테스': 'fitness', '헬스·필라테스': 'fitness', '요가': 'fitness', '운동': 'fitness',
    '건강': 'health', '건강·헬스': 'health',
    '반려동물': 'pet', '반려동물·펫': 'pet', '펫': 'pet',
    '인테리어': 'interior', '인테리어·가구': 'interior', '인테리어·소품': 'interior', '가구': 'interior',
    '학원': 'education', '학원·교육': 'education', '교육': 'education',
    '사진': 'studio', '사진·스튜디오': 'studio', '스튜디오': 'studio',
    '키즈': 'kids', '아동': 'kids', '어린이': 'kids',
    '공방': 'shop', '소품': 'shop', '공방·소품': 'shop',
    'restaurant': 'food', 'bakery': 'cafe',
    'gym': 'fitness', 'pilates': 'fitness', 'yoga': 'fitness',
    'florist': 'flower', 'clothing': 'fashion',
    'health_fitness': 'fitness', 'bar': 'food',
  };

  const category = CATEGORY_ALIAS[rawCategory] || rawCategory;
  // hair/nail/health/kids/shop은 beauty/fitness/cafe DB row를 활용 — DB key 매핑
  const DB_KEY_MAP = {
    hair: 'beauty',
    nail: 'beauty',
    health: 'fitness',
    kids: 'cafe',  // fallback: 향후 별도 수집 시 변경
    shop: 'cafe',  // fallback: 향후 별도 수집 시 변경
  };
  const storeKey = knownCategories.includes(category) ? (DB_KEY_MAP[category] || category) : 'cafe';
  // 서빙 시 분리 필터 적용 여부 (beauty DB row를 hair/nail로 분리)
  const beautySubcat = (category === 'hair' || category === 'nail' || category === 'beauty') ? category : null;
  const season = getSeasonInfo();
  // label은 요청 카테고리 기준 (hair/nail은 storeKey=beauty이지만 라벨은 각자)
  const label = CATEGORY_LABELS[category] || CATEGORY_LABELS[storeKey] || '일반';

  let supa;
  try {
    supa = getAdminClient();
  } catch(e) {
    console.error('[get-trends] Supabase 초기화 실패:', e.message);
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        category: storeKey,
        categoryLabel: label,
        tags: season.now.map(s => '#' + s),
        keywords: season.now.map(s => ({ keyword: s, trend: 'up', source: 'season' })),
        season,
        updatedAt: new Date().toISOString(),
        source: 'season',
      }),
    };
  }

  try {
    // --- 날짜 범위 히스토리 ---
    if (fromDate && toDate) {
      const fromTs = new Date(fromDate).getTime();
      const toTs = new Date(toDate).getTime();
      if (isNaN(fromTs) || isNaN(toTs)) {
        return {
          statusCode: 400, headers: CORS,
          body: JSON.stringify({ error: 'from/to 날짜 형식이 올바르지 않습니다. YYYY-MM-DD 형식을 사용하세요.' }),
        };
      }

      const prefix = `l30d-domestic:${storeKey}:`;

      // category LIKE 로 prefix 검색 (Supabase text PK)
      const { data: rows, error } = await supa
        .from('trends')
        .select('category, keywords, collected_at')
        .like('category', `${prefix}%`);

      if (error) {
        console.error('[get-trends] history 조회 실패:', error.message);
      }

      const history = [];
      for (const row of (rows || [])) {
        const m = row.category.match(/:(\d{4}-\d{2}-\d{2})$/);
        if (!m) continue;
        const ts = new Date(m[1]).getTime();
        if (ts < fromTs || ts > toTs) continue;
        history.push({ date: m[1], data: row.keywords });
      }
      history.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

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

    // --- scope=domestic ---
    if (scope === 'domestic') {
      const scopeKey = `l30d-domestic:${storeKey}`;
      const prevKey = `l30d-domestic-prev:${storeKey}`;

      const [scopeRow, prevRow, risingRow] = await Promise.all([
        fetchTrendRow(supa, scopeKey),
        fetchTrendRow(supa, prevKey),
        fetchTrendRow(supa, `l30d-rising:${storeKey}`),
      ]);

      const rising = (risingRow && Array.isArray(risingRow.keywords?.items)) ? risingRow.keywords.items : [];

      if (scopeRow && scopeRow.keywords) {
        const scopeData = scopeRow.keywords;
        const prevData = prevRow ? prevRow.keywords : null;
        const prevKeywords = (prevData && Array.isArray(prevData.keywords))
          ? prevData.keywords.map(k => (k.keyword || '').replace(/^#/, ''))
          : [];

        // beauty DB row를 hair/nail/beauty로 분리 서빙
        let rawKeywords = (scopeData.keywords || []).map((k, i) => ({
          keyword: (k.keyword || '').replace(/^#/, ''),
          source: k.source || 'gpt-classified',
          score: typeof k.score === 'number' ? k.score : (100 - i * 5),
          mentions: typeof k.mentions === 'number' ? k.mentions : 0,
          trend: 'up',
          rank: i + 1,
          rankChange: (() => {
            const kw = (k.keyword || '').replace(/^#/, '');
            const prevIdx = prevKeywords.indexOf(kw);
            if (prevIdx === -1) return 'new';
            if (prevIdx !== i) return prevIdx - i;
            return 0;
          })(),
          ...(k.bizCategory ? { bizCategory: k.bizCategory } : {}),
        }));

        if (beautySubcat) {
          rawKeywords = splitBeautyCategory(rawKeywords, beautySubcat);
        }

        const filteredKeywords = filterBlacklist(rawKeywords);
        const scopeTags = filteredKeywords.map(k => '#' + k.keyword).filter(Boolean);

        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({
            category,
            categoryLabel: label,
            scope,
            tags: scopeTags,
            keywords: filteredKeywords,
            rising,
            insight: scopeData.insight || '',
            insights: scopeData.insight || '',
            season,
            updatedAt: scopeData.updatedAt || scopeRow.collected_at || new Date().toISOString(),
            source: 'gpt-classified',
          }),
        };
      }

      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          category: storeKey,
          categoryLabel: label,
          scope,
          tags: [],
          keywords: [],
          rising,
          insight: '',
          insights: '',
          season,
          updatedAt: new Date().toISOString(),
          source: 'none',
        }),
      };
    }

    // --- 기존 합산 데이터 (scope 미지정): trends:{cat} 레거시 키 먼저 조회 ---
    const trendsRow = await fetchTrendRow(supa, 'trends:' + storeKey);
    if (trendsRow && trendsRow.keywords) {
      const cached = trendsRow.keywords;
      if (Array.isArray(cached.tags) && cached.tags.length > 0) {
        let kwList = cached.tags.map(tag => ({
          keyword: (tag || '').replace(/^#/, ''),
          trend: 'up',
          source: cached.source || 'last30days',
        }));
        if (beautySubcat) kwList = splitBeautyCategory(kwList, beautySubcat);
        const filteredKw = filterBlacklist(kwList);
        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({
            category,
            categoryLabel: label,
            tags: filteredKw.map(k => '#' + k.keyword),
            keywords: filteredKw,
            season,
            updatedAt: cached.updatedAt || trendsRow.collected_at || new Date().toISOString(),
            source: cached.source || 'last30days',
          }),
        };
      }
    }

    // --- l30d:{cat} fallback (존재 시) ---
    const l30dRow = await fetchTrendRow(supa, 'l30d:' + storeKey);
    if (l30dRow && l30dRow.keywords) {
      const l30d = l30dRow.keywords;
      if (Array.isArray(l30d.keywords) && l30d.keywords.length > 0) {
        let kwList = l30d.keywords.map(k => ({
          keyword: (k.keyword || '').replace(/^#/, ''),
          score: k.score || 0,
          mentions: k.mentions || 0,
          trend: 'up',
          source: 'last30days',
        }));
        if (beautySubcat) kwList = splitBeautyCategory(kwList, beautySubcat);
        const filteredKw = filterBlacklist(kwList);
        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({
            category,
            categoryLabel: label,
            tags: filteredKw.map(k => '#' + k.keyword).filter(Boolean),
            keywords: filteredKw,
            season,
            updatedAt: l30d.updatedAt || l30dRow.collected_at || new Date().toISOString(),
            source: 'last30days',
            findingsCount: l30d.findingsCount || null,
            dataSources: l30d.sources || null,
            insights: l30d.insights || '',
          }),
        };
      }
    }
  } catch(e) {
    console.error('get-trends error:', e.message);
  }

  // 최종 fallback: 시즌 키워드
  return {
    statusCode: 200, headers: CORS,
    body: JSON.stringify({
      category: storeKey,
      categoryLabel: label,
      tags: season.now.map(s => '#' + s),
      keywords: season.now.map(s => ({ keyword: s, trend: 'up', source: 'season' })),
      season,
      updatedAt: new Date().toISOString(),
      source: 'season',
    }),
  };
};
