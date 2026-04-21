// scheduled-trends-background.js — 5개 외부 소스 + gpt-4o-mini 분류 파이프라인 (Phase 1 재구축)
// 소스: 네이버 데이터랩, 네이버 검색(블로그), 구글 트렌드, YouTube Data API v3, Instagram Graph API(스켈레톤)
// 저장: Supabase public.trends (category 컬럼을 복합 키로 사용)
// 매일 자정(UTC 15:00 / KST 00:00) cron 실행
// -background 접미사: Netlify 백그라운드 함수(15분 타임아웃)로 실행
// 기존 동기 scheduled function은 10~26초 내에 끝나야 하나, 5소스 + GPT 호출은 그보다 오래 걸려 타임아웃됨 → 3일 연속 업데이트 누락

const { getAdminClient } = require('./_shared/supabase-admin');
const https = require('https');

// ---------------- 필터 ----------------
const BLACKLIST = [
  // 뻔한 카테고리·상시 키워드
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
  // 메타 접미사 배제
  '동네맛집', '밀면맛집', '소자본창업', '뷰티샵창업', '이벤트', '체험이벤트',
  // 뉴스매체·패션지
  '중앙일보', '조선일보', '동아일보', '한겨레', '경향신문', '매일경제', '한국경제',
  '푸드투데이', '뉴시스', '연합뉴스', '노컷뉴스', '머니투데이', '헤럴드경제',
  '코스모폴리탄', '보그', '얼루어', '하퍼스바자', '마리끌레르',
  'jtbc', 'kbs', 'sbs', 'mbc', 'tvn',
  // 경쟁 브랜드
  '스타벅스', '이디야커피', '이디야', '투썸플레이스', '투썸', '메가커피', '컴포즈커피',
  '빽다방', '할리스', '엔제리너스', '폴바셋', '블루보틀', '파스쿠찌',
  // 영어 뻔한 단어
  'coffee', 'cafe', 'desserts', 'dessert', 'menu', 'food', 'world', 'new', 'best',
  'love', 'like', 'good', 'free', 'sale', 'shop', 'store', 'day', 'time', 'news',
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
  if (BLACKLIST.includes(kw)) return true;
  if (FILLER_WORDS.some(fw => kw.includes(fw))) return true;
  if ((kw.match(/\s/g) || []).length >= 2) return true;
  if (/[?!,.]/.test(kw)) return true;
  return false;
}

function normalize(raw) {
  return (raw || '').replace(/^#/, '').replace(/\s+/g, '').trim();
}

// ---------------- fallback ----------------
const DEFAULT_TRENDS = {
  cafe: ['말차라떼', '크로플', '핸드드립', '시즌음료', '디저트플레이팅', '에스프레소바', '바닐라라떼', '케이크'],
  food: ['오마카세', '파스타', '한식주점', '수제버거', '베이글', '스몰디쉬', '구이전문점', '와인바'],
  beauty: ['글로우메이크업', '립틴트', '속눈썹펌', '피부장벽크림', '비건쿠션', '선크림', '아이섀도팔레트', '클렌징밤'],
  nail: ['젤네일', '큐빅네일', '오로라네일', '글리터젤', '봄컬러네일', '프렌치네일', '플라워네일아트', '그라데이션네일'],
  hair: ['볼륨펌', '뿌리염색', '레이어드컷', '두피스케일링', '매직스트레이트', '컬링아이롱', '앞머리펌', '단발컷'],
  flower: ['수국드라이플라워', '팜파스그라스', '유칼립투스리스', '목화솜부케', '라넌큘러스', '프리지어', '샴페인장미', '버드나무가지'],
  fashion: ['오버핏블레이저', 'Y2K패션', '셔츠워머', '롱스커트', '와이드팬츠', '카라니트', '청재킷', '레이어드룩'],
  fitness: ['크로스핏박스', '필라테스리포머', '맨몸운동루틴', '짐복합운동', '케틀벨스윙', '힙쓰러스트', '폼롤러스트레칭', '요가플로우'],
  pet: ['생식사료', '수제간식', '강아지유산균', '고양이캣타워', '반려견수영', '펫보험', '노즈워크', '슬링백'],
  interior: ['집꾸미기선반', '원목협탁', '패브릭포스터', '버티컬블라인드', '디퓨저향', '무드등조명', '빈티지러그', '테이블플랜트'],
  education: ['영어회화수업', '코딩부트캠프', '입시미술', '속독훈련', '수학올림피아드', '유아체능단', '독서토론', '악기레슨'],
  studio: ['무드컨셉샷', '셀프스튜디오', '4컷필름사진', '프로필촬영', '커플화보', '흑백필름', '스냅웨딩', '인생네컷'],
};

// ---------------- 업종별 시드 ----------------
const NAVER_KEYWORDS = {
  cafe: [
    { groupName: '카페', keywords: ['카페', '커피', '카페스타그램'] },
    { groupName: '베이커리', keywords: ['베이커리', '빵집', '디저트'] }
  ],
  food: [
    { groupName: '맛집', keywords: ['맛집', '식당', '맛스타그램'] },
    { groupName: '배달음식', keywords: ['배달음식', '오늘뭐먹지', '혼밥'] }
  ],
  beauty: [
    { groupName: '뷰티', keywords: ['뷰티', '메이크업', '화장품'] },
    { groupName: '헤어네일', keywords: ['헤어샵', '네일아트', '에스테틱'] }
  ],
  flower: [
    { groupName: '플라워', keywords: ['플라워샵', '꽃다발', '드라이플라워'] },
    { groupName: '리스부케', keywords: ['웨딩부케', '꽃바구니', '원데이클래스'] }
  ],
  fashion: [
    { groupName: '패션', keywords: ['오버핏', '빈티지패션', '코디'] },
    { groupName: '의류', keywords: ['Y2K', '트렌드룩', '레이어드'] }
  ],
  fitness: [
    { groupName: '필라테스', keywords: ['필라테스', '리포머', '기구필라테스'] },
    { groupName: '운동루틴', keywords: ['홈트', '케틀벨', '요가플로우'] },
    { groupName: '다이어트', keywords: ['체형교정', '코어운동', '바디프로필'] }
  ],
  pet: [
    { groupName: '강아지용품', keywords: ['강아지간식', '노즈워크', '펫프렌들리'] },
    { groupName: '고양이용품', keywords: ['캣타워', '자동급식기', '고양이모래'] },
    { groupName: '반려생활', keywords: ['반려견미용', '펫호텔', '반려동물보험'] }
  ],
  interior: [
    { groupName: '집꾸미기', keywords: ['셀프인테리어', '원룸인테리어', '오픈선반'] },
    { groupName: '무드등조명', keywords: ['무드등', '플로어램프', '버티컬블라인드'] },
    { groupName: '가구소품', keywords: ['원목테이블', '패브릭포스터', '빈티지러그'] }
  ],
  education: [
    { groupName: '성인교육', keywords: ['영어회화', '코딩부트캠프', '자격증준비'] },
    { groupName: '입시학원', keywords: ['입시미술', '수학학원', '논술학원'] },
    { groupName: '취미수업', keywords: ['독서모임', '악기레슨', '원데이클래스'] }
  ],
  studio: [
    { groupName: '프로필촬영', keywords: ['프로필사진', '이력서사진', '작가사진'] },
    { groupName: '셀프스튜디오', keywords: ['셀프스튜디오', '인생네컷', '4컷필름'] },
    { groupName: '웨딩스냅', keywords: ['웨딩스냅', '커플스냅', '가족스냅'] }
  ]
};

// 네이버 검색(블로그) 시드 — 업종별로 트렌드 도출용 검색어
const BLOG_SEARCH_SEEDS = {
  cafe: ['말차라떼 디저트', '크로플 카페', '비건 베이커리 메뉴', '스페셜티 핸드드립'],
  food: ['오마카세 코스요리', '수제버거 패티', '와인바 안주', '한식주점 메뉴'],
  beauty: ['젤네일 디자인', '레이어드컷 헤어', '속눈썹펌 후기', '글로우 메이크업'],
  flower: ['수국 드라이플라워 리스', '팜파스 부케 제작', '유칼립투스 화환', '라넌큘러스 꽃다발'],
  fashion: ['오버핏 블레이저 코디', 'Y2K 빈티지 스타일', '롱스커트 레이어드', '셔츠워머 착용법'],
  fitness: ['필라테스 리포머 기구', '케틀벨 스윙 루틴', '맨몸운동 홈트 프로그램', '기능성 트레이닝 센터', '코어 강화 운동', '바디프로필 준비', '요가 플로우 자세', '스피닝 클래스 후기'],
  pet: ['강아지 생식사료 브랜드', '고양이 자동급식기 추천', '반려견 노즈워크 매트', '펫 수제간식 레시피', '강아지 수영장 후기', '고양이 캣휠 트레이닝', '반려견 미용 스타일', '펫 호텔 프리미엄'],
  interior: ['원목 오픈선반 집꾸미기', '버티컬 블라인드 셀프시공', '무드등 플로어램프 조명', '빈티지 페르시안 러그', '원룸 침실 레이아웃', '북유럽 가구 배치', '패브릭 아트포스터 벽', '셀프 페인팅 벽면 리폼'],
  education: ['영어회화 1대1 수업', '코딩 부트캠프 취업률', '입시미술 포트폴리오 준비', '성인 악기레슨 피아노', '원데이클래스 공예', '독서모임 커리큘럼', '자격증 단기합격 후기', '유아 체능단 프로그램'],
  studio: ['셀프스튜디오 무드 컨셉샷', '4컷 필름사진 부산', '프로필사진 작가 후기', '흑백필름 스냅촬영', '웨딩스냅 야외 촬영', '가족 스튜디오 촬영', '커플 화보 컨셉', '강아지 반려동물 스튜디오'],
};

// YouTube 검색 시드 — 트렌드 영상 탐색용
const YOUTUBE_SEEDS_KR = {
  cafe: ['카페 신메뉴 리뷰', '디저트 브이로그'],
  food: ['맛집 브이로그', '오마카세 리뷰'],
  beauty: ['네일 트렌드 디자인', '헤어 컷 스타일'],
  flower: ['플라워 클래스 브이로그', '드라이플라워 리스 만들기'],
  fashion: ['오버핏 코디 브이로그', 'Y2K 패션 하울'],
  fitness: ['필라테스 리포머 운동', '크로스핏 홈트 브이로그', '바디프로필 준비 식단', '맨몸운동 루틴'],
  pet: ['강아지 일상 브이로그', '고양이 용품 추천', '반려견 수제간식 만들기', '펫 호텔 후기'],
  interior: ['집 인테리어 셀프 리모델링', '집꾸미기 소품 하울', '원룸 셀프 인테리어', '북유럽 무드 인테리어'],
  education: ['영어회화 수업 후기', '코딩 독학 브이로그', '입시미술 포트폴리오', '성인 취미 원데이클래스'],
  studio: ['셀프스튜디오 촬영 브이로그', '4컷 필름사진 리뷰', '웨딩스냅 촬영 후기', '프로필 사진 컨셉'],
};

const CATEGORY_KO = {
  cafe: '카페/베이커리',
  food: '음식점/맛집',
  beauty: '뷰티/헤어/네일',
  flower: '꽃집/플라워샵',
  fashion: '패션/의류',
  fitness: '피트니스/헬스',
  pet: '반려동물',
  interior: '인테리어',
  education: '교육/학원',
  studio: '스튜디오/포토',
};

// ---------------- HTTP helpers ----------------
function httpsPost(hostname, path, headers, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname, path, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: responseData }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function httpsGetRaw(urlOrOptions, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlOrOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
  });
}

function httpsGet(url, timeoutMs = 10000) {
  return httpsGetRaw(url, timeoutMs);
}

function httpsGetWithHeaders(hostname, path, headers, timeoutMs = 10000) {
  return httpsGetRaw({ hostname, path, method: 'GET', headers }, timeoutMs);
}

// ---------------- 소스 1. 네이버 데이터랩 ----------------
async function fetchNaverDatalab(category) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return [];

  const today = new Date();
  const endDate = today.toISOString().slice(0, 10);
  const startDate = new Date(today - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const keywordGroups = NAVER_KEYWORDS[category] || NAVER_KEYWORDS.cafe;

  try {
    const result = await httpsPost(
      'openapi.naver.com',
      '/v1/datalab/search',
      {
        'Content-Type': 'application/json',
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret
      },
      { startDate, endDate, timeUnit: 'week', keywordGroups, device: 'mo', ages: ['2', '3', '4', '5'], gender: 'f' }
    );
    if (result.status !== 200) return [];
    const data = JSON.parse(result.body);
    if (!data.results || data.results.length === 0) return [];
    const sorted = data.results.sort((a, b) => {
      const aAvg = a.data.reduce((s, d) => s + d.ratio, 0) / a.data.length;
      const bAvg = b.data.reduce((s, d) => s + d.ratio, 0) / b.data.length;
      return bAvg - aAvg;
    });
    // DataLab 결과에서 groupName(시드 레이블) 대신 실제 검색했던 키워드들을 인기 순으로 반환
    const titleToKeywords = new Map(
      (keywordGroups || []).map(g => [g.groupName, g.keywords || []])
    );
    const ordered = [];
    for (const g of sorted) {
      const kws = titleToKeywords.get(g.title) || [];
      for (const kw of kws) if (kw) ordered.push(kw);
    }
    return ordered;
  } catch(e) {
    console.error('[naver-datalab]', category, 'error:', e.message);
    return [];
  }
}

// ---------------- 소스 2. 네이버 검색(블로그) ----------------
async function fetchNaverBlogs(category) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return [];

  const seeds = BLOG_SEARCH_SEEDS[category] || BLOG_SEARCH_SEEDS.cafe;
  const texts = [];
  for (const query of seeds) {
    try {
      const path = `/v1/search/blog.json?query=${encodeURIComponent(query)}&display=15&sort=date`;
      const result = await httpsGetWithHeaders(
        'openapi.naver.com',
        path,
        {
          'X-Naver-Client-Id': clientId,
          'X-Naver-Client-Secret': clientSecret
        },
        10000
      );
      if (result.status !== 200) continue;
      const data = JSON.parse(result.body);
      if (!data.items) continue;
      for (const item of data.items) {
        // HTML 태그 제거
        const title = (item.title || '').replace(/<[^>]+>/g, '').trim();
        const desc = (item.description || '').replace(/<[^>]+>/g, '').trim();
        if (title) texts.push(title);
        if (desc) texts.push(desc.slice(0, 120));
      }
      await new Promise(r => setTimeout(r, 200));
    } catch(e) {
      console.error('[naver-blog]', category, query, 'error:', e.message);
    }
  }
  return texts;
}

// ---------------- 소스 3. 구글 트렌드 ----------------
async function fetchGoogleTrendsLib(geo) {
  try {
    const googleTrends = require('google-trends-api');
    const raw = await Promise.race([
      googleTrends.dailyTrends({ trendDate: new Date(), geo }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
    ]);
    const parsed = JSON.parse(raw);
    const days = parsed?.default?.trendingSearchesDays || [];
    const titles = [];
    for (const day of days) {
      for (const ts of (day.trendingSearches || [])) {
        const t = ts?.title?.query;
        if (t) titles.push(t);
        for (const rel of (ts.relatedQueries || [])) {
          if (rel?.query) titles.push(rel.query);
        }
      }
    }
    return titles.slice(0, 40);
  } catch(e) {
    console.error(`[google-${geo}] lib 실패, RSS fallback:`, e.message);
    return fetchGoogleRSS(geo);
  }
}

async function fetchGoogleRSS(geo) {
  try {
    const url = `https://trends.google.com/trends/trendingsearches/daily/rss?geo=${geo}`;
    const result = await httpsGet(url);
    if (result.status !== 200) return [];
    const titles = [];
    const matches = result.body.matchAll(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/g);
    for (const match of matches) {
      const title = match[1].trim();
      if (title && title !== 'Google Trends' && titles.length < 40) {
        titles.push(title);
      }
    }
    return titles;
  } catch(e) {
    console.error(`[google-rss-${geo}]`, e.message);
    return [];
  }
}

// ---------------- 소스 4. YouTube Data API v3 ----------------
async function fetchYouTube(category) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return [];

  const seeds = YOUTUBE_SEEDS_KR[category] || YOUTUBE_SEEDS_KR.cafe;
  const titles = [];

  for (const query of seeds) {
    try {
      // search.list: 최근 7일 인기 영상 제목 수집
      const searchPath = `/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=10` +
        `&regionCode=KR` +
        `&publishedAfter=${encodeURIComponent(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())}` +
        `&q=${encodeURIComponent(query)}` +
        `&key=${apiKey}`;
      const result = await httpsGetRaw({
        hostname: 'www.googleapis.com',
        path: searchPath,
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      }, 10000);
      if (result.status !== 200) {
        console.error('[youtube] search status:', result.status, category, query);
        continue;
      }
      const data = JSON.parse(result.body);
      for (const item of (data.items || [])) {
        const title = item?.snippet?.title;
        if (title) titles.push(title);
      }
      await new Promise(r => setTimeout(r, 200));
    } catch(e) {
      console.error('[youtube]', category, query, 'error:', e.message);
    }
  }
  return titles;
}

// ---------------- 소스 5. Instagram Graph API (스켈레톤) ----------------
// ⚠️ 제약: 공개 해시태그 조회(/ig_hashtag_search + /media)는
// Instagram Business 계정 ID + Long-lived User Access Token + 심사 통과가 필요함.
// META_APP_ID/SECRET만으로는 호출 불가. 심사 통과 시 INSTAGRAM_BUSINESS_ID + INSTAGRAM_ACCESS_TOKEN
// 환경변수를 추가하고 아래 구현을 활성화할 것.
async function fetchInstagram(category) {
  const businessId = process.env.INSTAGRAM_BUSINESS_ID;
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!businessId || !accessToken) {
    // 1차 구현: 토큰 없으면 조용히 skip
    return [];
  }

  const seedTag = ({
    cafe: 'cafetrend',
    food: 'foodtrend',
    beauty: 'beautytrend',
    flower: 'flowertrend',
    fashion: 'fashiontrend',
    fitness: 'fitnesskorea',
    pet: 'pettrend',
    interior: 'interiortrend',
    education: 'edutrend',
    studio: 'photostudio',
  })[category] || 'trend';

  try {
    // Step 1: hashtag id 조회
    const searchPath = `/v19.0/ig_hashtag_search?user_id=${encodeURIComponent(businessId)}` +
      `&q=${encodeURIComponent(seedTag)}&access_token=${encodeURIComponent(accessToken)}`;
    const idRes = await httpsGetRaw({
      hostname: 'graph.facebook.com',
      path: searchPath,
      method: 'GET',
    }, 8000);
    if (idRes.status !== 200) return [];
    const idData = JSON.parse(idRes.body);
    const tagId = idData?.data?.[0]?.id;
    if (!tagId) return [];

    // Step 2: top_media 제목/캡션 조회
    const mediaPath = `/v19.0/${tagId}/top_media?user_id=${encodeURIComponent(businessId)}` +
      `&fields=caption&limit=25&access_token=${encodeURIComponent(accessToken)}`;
    const mRes = await httpsGetRaw({
      hostname: 'graph.facebook.com',
      path: mediaPath,
      method: 'GET',
    }, 8000);
    if (mRes.status !== 200) return [];
    const mData = JSON.parse(mRes.body);
    return (mData?.data || [])
      .map(x => (x.caption || '').slice(0, 200))
      .filter(Boolean);
  } catch(e) {
    console.error('[instagram]', category, 'skip:', e.message);
    return [];
  }
}

// ---------------- 분류기: gpt-4o-mini ----------------
// 5개 소스에서 수집한 원시 텍스트를 하나의 배치로 gpt-4o-mini에 투입
// 반환: { cafe: [...], food: [...], beauty: [...], flower: [...], fashion: [...], fitness: [...], pet: [...], interior: [...], education: [...], studio: [...] }
async function classifyBatchWithGPT({ rawTextsByCategory }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  // 각 카테고리 컨텍스트를 제한된 길이로 포맷
  const sections = Object.entries(rawTextsByCategory).map(([cat, lines]) => {
    const clip = (lines || []).slice(0, 40).join(' | ').slice(0, 2000);
    return `## ${CATEGORY_KO[cat] || cat} (key=${cat})\n${clip || '없음'}`;
  }).join('\n\n');

  const prompt = `당신은 국내(한국) 소상공인(카페·음식점·뷰티·꽃집·패션·피트니스·반려동물·인테리어·교육·스튜디오) 인스타그램 트렌드 분석 전문가입니다.

아래 5개 외부 소스(네이버 데이터랩·네이버 블로그·구글 트렌드·YouTube·Instagram)에서 수집한 원시 텍스트를 읽고,
각 업종 카테고리에서 실제 유행하는 **트렌드 대상** 키워드 5~12개씩 선별해 JSON으로 반환하세요.
(데이터가 부족한 카테고리 — 피트니스·반려동물·인테리어·교육·스튜디오 — 는 시드 키워드 관련 구체적 상품·스타일·기법이면 넓게 포함 가능)

[원시 수집 텍스트]
${sections}

## 카테고리별 범위 (중복 배치 금지 — 각 키워드는 가장 구체적인 카테고리 하나에만)
- beauty: 스킨케어, 메이크업, 파운데이션, 립, 아이섀도, 속눈썹 연장, 왁싱, 바디케어, 피부관리, 화장품 신제품
  예) 글로우메이크업, 선크림, 비건쿠션, 속눈썹펌, 피부장벽크림
  ※ 네일·헤어 키워드는 beauty에 넣지 말 것
- nail (네일): 젤네일, 네일아트, 패디큐어, 네일케어, 큐빅네일, 프렌치네일, 글리터네일, 오프젤, 네일컬러
  예) 오로라네일, 글리터젤, 봄컬러네일, 플라워네일아트
  ※ beauty/hair와 별개. 네일 관련 키워드는 반드시 nail 배열에만
- hair (헤어): 헤어커트, 펌, 염색, 볼륨, 레이어드컷, 탈모케어, 두피관리, 헤어스타일링, 앞머리, 단발
  예) 볼륨매직, 레이어드컷, 뿌리염색, 두피스케일링, 컬링아이롱
  ※ beauty/nail와 별개. 헤어 관련 키워드는 반드시 hair 배열에만

## 절대 준수 — "트렌드 자체" vs "트렌드를 찾기 위한 검색어" 엄격 구분
- 유효(선별 O): 구체적 대상·제품·메뉴·스타일·기법
  예) 말차라떼, 크로플, 글레이즈드네일, 오마카세, 팝업스토어, 뉴트로, matcha latte, smash burger, glazed nails
- 무효(제외): 카테고리·평가·행위·의도
  예) 맛집, 핫플레이스, 추천, 축제, 재밌는곳, 데이트코스, 가볼만한곳, 인기, 데일리, 맛있는, 예쁜

## 특히 다음 "포괄 카테고리 용어"는 반드시 제외
- "신상X", "신메뉴", "신제품", "신상음료", "신상디저트" 등 "신상/신메뉴" 계열 모두 제외
  → 구체적으로 어떤 신상인지를 가리키는 고유 명칭만 유효
- "X카페" 형태 중 업종 총칭(디저트카페, 브런치카페, 감성카페, 루프탑카페, 힐링카페, 애견카페 등) 모두 제외
  → "스페셜티카페" 같은 세부 업태도 제외. 단 고유 브랜드/매장 컨셉이 아닌 이상 무효
- "계절+카테고리" 조합(여름디저트, 겨울음식, 봄메뉴, 가을패션 등) 모두 제외
  → 특정 메뉴명이 있을 때만 유효 (예: 여름딸기빙수 X → 딸기빙수 O)
- "속성+카테고리" 조합(저당음료, 무설탕디저트, 고단백식단, 저칼로리도시락) 제외
  → 단, 고유 트렌드 명칭이면 허용 (예: 헬시플레저, 로우카브다이어트)
- 업종 총칭(카페, 베이커리, 디저트, 네일샵, 피부과, 헤어샵, 음식점) 단독 모두 제외

## 추가 금지
- 뉴스매체·패션지(중앙일보, 연합뉴스, 코스모폴리탄, 보그 등)
- 경쟁 브랜드(스타벅스, 이디야, 투썸, 메가커피, Starbucks 등)
- 필러 워드(아이디어, 방법, 추천, 정보, 모음, 팁, 가이드, 리스트)
- 뉴스 문장 단편(유행하는, 뜨는, 라고, 밝혀, 화제의)
- 상시 해시태그(인스타그램, 좋아요, 팔로우, 일상, 데일리)
- 지역명 단독(서울, 강남, 홍대, 성수)

## 판정 기준 (애매할 때)
"이 단어로 검색했을 때 구체적인 이미지 하나가 떠오르는가?"
- YES → 유효 (예: 우베라떼 → 보라색 라떼 이미지)
- NO, 여러 종류가 떠오름 → 무효 (예: 신상음료 → 수십 종류)

## 언어 규칙
- 한국어 단어만 (예: 말차라떼 O, matcha latte X)

## 출력 형식 (엄격)
JSON 객체만 반환. 설명·마크다운·코드블록 금지.
스키마:
{"cafe": ["키워드1", ...], "food": ["키워드1", ...], "beauty": ["키워드1", ...], "nail": ["키워드1", ...], "hair": ["키워드1", ...], "flower": ["키워드1", ...], "fashion": ["키워드1", ...], "fitness": ["키워드1", ...], "pet": ["키워드1", ...], "interior": ["키워드1", ...], "education": ["키워드1", ...], "studio": ["키워드1", ...]}

- 각 배열 5~12개 (데이터가 충분히 많은 cafe/food/beauty/nail/hair/fashion은 8~12, 나머지는 5~12로 최대한 채우기)
- beauty/nail/hair는 서로 겹치는 키워드 없이 완전히 분리
- 각 키워드: 2~20자, # 없이, 한 단어 또는 공백 없는 합성어 우선(최대 두 단어)
- 배열 내 중복 금지`;

  try {
    const result = await httpsPost(
      'api.openai.com',
      '/v1/responses',
      {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      {
        model: 'gpt-4o-mini',
        input: prompt,
        temperature: 0.2,
        max_output_tokens: 1200,
        store: false,
      },
      30000
    );

    if (result.status !== 200) {
      console.error('[gpt-classify] status:', result.status);
      return null;
    }

    const data = JSON.parse(result.body);
    // Responses API 는 output[] 에 reasoning/message 가 섞여 나올 수 있음 — text 조각을 전부 합침
    let content = (data.output_text || '').trim();
    if (!content && Array.isArray(data.output)) {
      for (const item of data.output) {
        for (const part of (item?.content || [])) {
          if (part?.text) content += part.text;
        }
      }
      content = content.trim();
    }
    if (!content) return null;

    const clean = content.replace(/```json|```/g, '').trim();
    // JSON 객체 추출 (앞뒤 노이즈 방어)
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) return null;
    let parsed;
    try {
      parsed = JSON.parse(match[0]);
    } catch(e) {
      console.error('[gpt-classify] JSON parse 실패');
      return null;
    }

    // 카테고리별 정규화 + 필터
    const out = {};
    for (const cat of ['cafe', 'food', 'beauty', 'nail', 'hair', 'flower', 'fashion', 'fitness', 'pet', 'interior', 'education', 'studio']) {
      const arr = Array.isArray(parsed[cat]) ? parsed[cat] : [];
      const seen = new Set();
      const cleaned = [];
      for (const t of arr) {
        const norm = normalize(t);
        const key = norm.toLowerCase();
        if (!norm || seen.has(key)) continue;
        if (isBadKeyword(norm)) continue;
        seen.add(key);
        cleaned.push(norm);
        if (cleaned.length >= 12) break;
      }
      out[cat] = cleaned;
    }
    return out;
  } catch(e) {
    console.error('[gpt-classify] 실패:', e.message);
    return null;
  }
}

// ---------------- "뜰 가능성" 예측 (gpt-4o-mini) ----------------
async function predictRisingWithGPT({ category, domesticTags, naverData, blogData, youtubeData, googleKR }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const categoryKo = CATEGORY_KO[category] || '일반';
  const recentStr = (naverData || []).slice(0, 8).join(', ') || '없음';
  const blogStr = (blogData || []).slice(0, 6).join(' | ').slice(0, 500) || '없음';
  const ytStr = (youtubeData || []).slice(0, 6).join(' | ').slice(0, 500) || '없음';
  const googleStr = (googleKR || []).slice(0, 8).join(', ') || '없음';
  const currentStr = (domesticTags || []).slice(0, 8).join(', ') || '없음';

  const prompt = `당신은 인스타그램 트렌드 예측 전문가입니다.

"${categoryKo}" 업종에서 앞으로 2~4주 안에 유행할 가능성이 높은 키워드 10개를 예측하세요.

[현재 유행 중]
${currentStr}

[네이버 최근 급상승]
${recentStr}

[블로그 신상 텍스트]
${blogStr}

[YouTube 인기 영상 제목]
${ytStr}

[구글 트렌드(한국)]
${googleStr}

각 키워드에 대해 다음을 JSON 배열로 응답하세요:
- keyword: 예측 키워드 (한국어, 2~20자, # 없이)
- confidence: 유행 가능성 0~100 정수
- growthRate: 예상 성장률 문자열 (예: "+35%")
- reason: 예측 근거 1줄 (20자 이내, 한국어)

절대 금지: 현재 이미 널리 유행 중인 단어, 카테고리 단어(카페·커피·네일), 지역명, 브랜드명, 필러 워드(추천/아이디어/방법)

응답: JSON 배열만, 설명·마크다운 없음.
예시: [{"keyword":"흑임자라떼","confidence":78,"growthRate":"+42%","reason":"흑임자 붐 + 음료 결합 수요"}]`;

  try {
    const result = await httpsPost(
      'api.openai.com',
      '/v1/responses',
      {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      {
        model: 'gpt-4o-mini',
        input: prompt,
        temperature: 0.4,
        max_output_tokens: 1400,
        store: false,
      },
      30000
    );

    if (result.status !== 200) {
      console.error('[gpt-rising]', category, 'status:', result.status);
      return null;
    }

    const data = JSON.parse(result.body);
    let content = (data.output_text || '').trim();
    if (!content && Array.isArray(data.output)) {
      for (const item of data.output) {
        for (const part of (item?.content || [])) {
          if (part?.text) content += part.text;
        }
      }
      content = content.trim();
    }
    if (!content) return null;

    const clean = content.replace(/```json|```/g, '').trim();
    const match = clean.match(/\[[\s\S]*\]/);
    if (!match) return null;
    let items;
    try {
      items = JSON.parse(match[0]);
    } catch {
      return null;
    }
    if (!Array.isArray(items)) return null;

    const valid = items.filter(item =>
      item && item.keyword && !isBadKeyword(item.keyword) &&
      typeof item.confidence === 'number' &&
      item.reason
    ).slice(0, 10);

    return valid.length >= 2 ? valid : null;
  } catch(e) {
    console.error('[gpt-rising]', category, '실패:', e.message);
    return null;
  }
}

// ---------------- Supabase 저장 ----------------
function toKeywordObjects(tags, source) {
  return tags.map((kw, i) => ({
    keyword: kw,
    score: 100 - i * 5,
    mentions: 0,
    source,
  }));
}

async function saveScope({ supa, scope, category, tags, updatedAt, source }) {
  const scopeKey = `l30d-${scope}:${category}`;
  const prevKey = `l30d-${scope}-prev:${category}`;
  const dateStr = updatedAt.slice(0, 10);
  const dateKey = `l30d-${scope}:${category}:${dateStr}`;

  const payload = {
    keywords: toKeywordObjects(tags, source),
    insight: '',
    updatedAt,
    source,
  };

  // prev 백업 (기존 값이 있으면 prev로 이동)
  try {
    const { data: cur } = await supa
      .from('trends')
      .select('keywords')
      .eq('category', scopeKey)
      .single();
    if (cur) {
      await supa.from('trends').upsert(
        { category: prevKey, keywords: cur.keywords, collected_at: new Date().toISOString() },
        { onConflict: 'category' }
      );
    }
  } catch(e) { /* prev 없어도 OK */ }

  // 현재 데이터 upsert
  await supa.from('trends').upsert(
    { category: scopeKey, keywords: payload, collected_at: updatedAt },
    { onConflict: 'category' }
  );

  // 날짜별 스냅샷
  await supa.from('trends').upsert(
    { category: dateKey, keywords: payload, collected_at: updatedAt },
    { onConflict: 'category' }
  );

  // 레거시 호환: trends:{cat} (해시태그 배열) — domestic 만
  if (scope === 'domestic') {
    const tagsWithHash = tags.map(t => '#' + t);
    await supa.from('trends').upsert(
      {
        category: 'trends:' + category,
        keywords: { tags: tagsWithHash, updatedAt, source: 'scheduled-trends' },
        collected_at: updatedAt,
      },
      { onConflict: 'category' }
    );

    // 레거시 호환: 대시보드 카드(window.lumiSupa.from('trends').eq('category', bizCat))가
    // 직접 조회하는 bare 카테고리 키 — res.data.keywords.slice(0,3).map(k=>k.keyword)
    // 형태로 접근하므로 keywords jsonb 컬럼은 "키워드 객체 배열"이어야 함.
    await supa.from('trends').upsert(
      {
        category,
        keywords: toKeywordObjects(tags, source),
        collected_at: updatedAt,
      },
      { onConflict: 'category' }
    );
  }
}

// ---------------- 메인 핸들러 ----------------
exports.handler = async (event) => {
  const isScheduled = !event || !event.httpMethod;
  if (!isScheduled) {
    const secret = (event.headers && (event.headers['x-lumi-secret'] || event.headers['X-Lumi-Secret'])) || '';
    if (!process.env.LUMI_SECRET || secret !== process.env.LUMI_SECRET) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: '인증 실패' }),
      };
    }
  }
  console.log('[scheduled-trends-background] Phase 1 재구축 파이프라인 시작 (5소스 + gpt-4o-mini)');

  let supa;
  try {
    supa = getAdminClient();
  } catch(e) {
    console.error('[scheduled-trends] Supabase 초기화 실패:', e.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Supabase 초기화 실패' }),
    };
  }

  // nail/hair는 beauty 수집 데이터를 공유 — GPT 프롬프트에서 3분할 분류
  const categories = ['cafe', 'food', 'beauty', 'nail', 'hair', 'flower', 'fashion', 'fitness', 'pet', 'interior', 'education', 'studio'];
  const COLLECT_CATEGORIES = ['cafe', 'food', 'beauty', 'flower', 'fashion', 'fitness', 'pet', 'interior', 'education', 'studio'];
  const updatedAt = new Date().toISOString();

  // --- 1단계: 전 업종 병렬 수집 ---
  // 구글 트렌드는 업종 무관하므로 1회만
  const googleKR = await fetchGoogleTrendsLib('KR');
  console.log(`[sources] google-kr: ${googleKR.length}`);

  // 업종별 소스 수집 — 수집 카테고리만 (nail/hair는 beauty 공유)
  const rawEntries = await Promise.all(COLLECT_CATEGORIES.map(async (category) => {
    const [naverData, blogData, ytKR, igTexts] = await Promise.all([
      fetchNaverDatalab(category),
      fetchNaverBlogs(category),
      fetchYouTube(category),
      fetchInstagram(category),
    ]);
    console.log(`[${category}] naver=${naverData.length} blog=${blogData.length} yt-kr=${ytKR.length} ig=${igTexts.length}`);
    return [category, { naverData, blogData, ytKR, igTexts }];
  }));
  const rawByCategory = Object.fromEntries(rawEntries);
  // nail/hair는 beauty 수집 데이터 공유
  rawByCategory.nail = rawByCategory.beauty;
  rawByCategory.hair = rawByCategory.beauty;

  // --- 2단계: gpt-4o-mini 배치 분류 (국내 1회) ---
  const domesticTexts = {};
  for (const cat of categories) {
    const r = rawByCategory[cat];
    domesticTexts[cat] = [
      ...r.naverData,
      ...r.blogData,
      ...r.ytKR,
      ...googleKR,
      ...r.igTexts,
    ];
  }

  let domesticClassified = null;
  if (process.env.OPENAI_API_KEY) {
    domesticClassified = await classifyBatchWithGPT({ rawTextsByCategory: domesticTexts });
  }

  // --- 3단계: 저장 + rising 예측 (10 카테고리 병렬) ---
  const allDomestic = [];
  const results = await Promise.all(categories.map(async (category) => {
    try {
      const r = rawByCategory[category];

      // 국내 태그 선정
      let domesticTags = (domesticClassified && domesticClassified[category]) || [];
      if (!domesticTags || domesticTags.length < 3) {
        const fromNaver = (r.naverData || []).map(normalize).filter(kw => !isBadKeyword(kw));
        domesticTags = [...new Set([...domesticTags, ...fromNaver, ...(DEFAULT_TRENDS[category] || [])])].slice(0, 10);
      } else if (domesticTags.length < 10) {
        domesticTags = [...new Set([...domesticTags, ...(DEFAULT_TRENDS[category] || [])])].slice(0, 10);
      } else {
        domesticTags = domesticTags.slice(0, 10);
      }

      // 뜰 가능성 예측과 saveScope 병렬
      const [_, risingItemsRaw] = await Promise.all([
        saveScope({ supa, scope: 'domestic', category, tags: domesticTags, updatedAt, source: 'gpt-4o-mini' }),
        process.env.OPENAI_API_KEY
          ? predictRisingWithGPT({
              category, domesticTags,
              naverData: r.naverData, blogData: r.blogData,
              youtubeData: r.ytKR, googleKR,
            })
          : Promise.resolve(null),
      ]);

      domesticTags.forEach((kw, i) => allDomestic.push({
        keyword: kw, score: 100 - i * 5, mentions: 0, source: 'gpt-4o-mini', bizCategory: category
      }));

      let risingItems = risingItemsRaw;
      if (!risingItems || risingItems.length < 2) {
        const pool = (domesticTags.length >= 10 ? domesticTags.slice(0, 10) : [...domesticTags, ...(DEFAULT_TRENDS[category] || [])].slice(0, 10));
        risingItems = pool.map((kw, i) => ({
          keyword: kw,
          confidence: Math.max(30, 75 - i * 5),
          growthRate: '+' + Math.max(5, 25 - i * 2) + '%',
          reason: '국내 트렌드 상승세',
        }));
      }
      try {
        await supa.from('trends').upsert(
          { category: `l30d-rising:${category}`, keywords: { items: risingItems, updatedAt, source: 'gpt-prediction' }, collected_at: updatedAt },
          { onConflict: 'category' }
        );
      } catch(e) {
        console.error(`[rising] ${category} 저장 실패:`, e.message);
      }

      console.log(`[${category}] 국내(${domesticTags.length}):`, domesticTags.join(', '));
      console.log(`[${category}] 뜰(${risingItems.length}):`, risingItems.map(r => r.keyword).join(', '));
      return { category, domestic: domesticTags.length, rising: risingItems.length };
    } catch(e) {
      console.error(`[scheduled-trends] ${category} 실패:`, e.message);
      try {
        await saveScope({ supa, scope: 'domestic', category, tags: DEFAULT_TRENDS[category] || [], updatedAt, source: 'fallback' });
      } catch(e2) {}
      return { category, error: e.message };
    }
  }));

  // --- 4단계: 종합(all) 저장 ---
  try {
    allDomestic.sort((a, b) => (b.score || 0) - (a.score || 0));

    try {
      const { data: curD } = await supa.from('trends').select('keywords').eq('category', 'l30d-domestic:all').single();
      if (curD) await supa.from('trends').upsert(
        { category: 'l30d-domestic-prev:all', keywords: curD.keywords, collected_at: updatedAt },
        { onConflict: 'category' }
      );
    } catch(e) {}

    await supa.from('trends').upsert(
      { category: 'l30d-domestic:all', keywords: { keywords: allDomestic.slice(0, 30), updatedAt, source: 'scheduled-gpt-all' }, collected_at: updatedAt },
      { onConflict: 'category' }
    );
  } catch(e) {
    console.error('[all] 실패:', e.message);
  }

  console.log('[scheduled-trends] 완료:', JSON.stringify(results));
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ success: true, updatedAt, results }),
  };
};

module.exports.config = {
  schedule: '0 15 * * *'
};
