// scheduled-trends.js — 5개 외부 소스 + gpt-4o-mini 분류 파이프라인 (Phase 1 재구축)
// 소스: 네이버 데이터랩, 네이버 검색(블로그), 구글 트렌드, YouTube Data API v3, Instagram Graph API(스켈레톤)
// 저장: Supabase public.trends (category 컬럼을 복합 키로 사용)
// 매일 자정(UTC 15:00 / KST 00:00) cron 실행

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
  beauty: ['젤네일', '큐빅네일', '볼륨펌', '뿌리염색', '레이어드컷', '속눈썹펌', '글로우메이크업', '립틴트'],
  other: ['시즌이벤트', '오픈특가', '단골쿠폰', '리뉴얼', '주말한정', '신상품', '감사이벤트', '포토존'],
};

const DEFAULT_GLOBAL_TRENDS = {
  cafe: ['matcha latte', 'dirty chai', 'cortado', 'oat milk', 'cold brew', 'specialty coffee', 'drip bar', 'espresso tonic'],
  food: ['smash burger', 'girl dinner', 'protein bowl', 'pasta night', 'omakase', 'ramen', 'sourdough', 'tapas'],
  beauty: ['glazed nails', 'chrome nails', 'glass skin', 'latte makeup', 'clean girl', 'ombre lips', 'lash lift', 'body oil'],
  other: ['pop up shop', 'local love', 'small biz', 'community event', 'limited drop', 'weekend special', 'seasonal launch', 'founder story'],
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
  other: [
    { groupName: '소상공인', keywords: ['소상공인', '동네가게', '로컬'] }
  ]
};

// 네이버 검색(블로그) 시드 — 업종별로 트렌드 도출용 검색어
const BLOG_SEARCH_SEEDS = {
  cafe: ['신메뉴 카페', '카페 신상', '요즘 카페 트렌드', '새로 생긴 디저트'],
  food: ['요즘 뜨는 맛집', '신상 맛집', '핫한 메뉴'],
  beauty: ['요즘 네일', '최신 헤어 트렌드', '신상 메이크업', '화장품 신상'],
  other: ['동네 이벤트', '소상공인 팝업', '로컬 신상'],
};

// YouTube 검색 시드 — 트렌드 영상 탐색용
const YOUTUBE_SEEDS_KR = {
  cafe: ['카페 신메뉴 리뷰', '디저트 브이로그'],
  food: ['맛집 브이로그', '신상 메뉴 리뷰'],
  beauty: ['뷰티 신상 리뷰', '네일 트렌드'],
  other: ['소상공인 브이로그', '팝업스토어 방문'],
};
const YOUTUBE_SEEDS_US = {
  cafe: ['coffee trends', 'cafe menu review'],
  food: ['food trend review', 'new restaurant menu'],
  beauty: ['beauty trend review', 'nail art trend'],
  other: ['small business vlog', 'pop up event'],
};

const CATEGORY_KO = {
  cafe: '카페/베이커리',
  food: '음식점/맛집',
  beauty: '뷰티/헤어/네일',
  other: '소상공인 일반'
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
  const keywordGroups = NAVER_KEYWORDS[category] || NAVER_KEYWORDS.other;

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
    return sorted.map(g => g.title).filter(Boolean);
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

  const seeds = BLOG_SEARCH_SEEDS[category] || BLOG_SEARCH_SEEDS.other;
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
async function fetchYouTube(category, regionCode) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return [];

  const seeds = regionCode === 'KR'
    ? (YOUTUBE_SEEDS_KR[category] || YOUTUBE_SEEDS_KR.other)
    : (YOUTUBE_SEEDS_US[category] || YOUTUBE_SEEDS_US.other);
  const titles = [];

  for (const query of seeds) {
    try {
      // search.list: 최근 7일 인기 영상 제목 수집
      const searchPath = `/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=10` +
        `&regionCode=${regionCode}` +
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
    other: 'smallbiz',
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
// 반환: { cafe: [...], food: [...], beauty: [...], other: [...] }
async function classifyBatchWithGPT({ scope, rawTextsByCategory }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const localeLabel = scope === 'domestic' ? '국내(한국)' : '해외(영미권)';
  const languageRule = scope === 'domestic'
    ? '- 한국어 단어만 (예: 말차라떼 O, matcha latte X)'
    : '- 영어 단어만 (예: matcha latte O, 말차라떼 X)';

  // 각 카테고리 컨텍스트를 제한된 길이로 포맷
  const sections = Object.entries(rawTextsByCategory).map(([cat, lines]) => {
    const clip = (lines || []).slice(0, 40).join(' | ').slice(0, 2000);
    return `## ${CATEGORY_KO[cat] || cat} (key=${cat})\n${clip || '없음'}`;
  }).join('\n\n');

  const prompt = `당신은 "${localeLabel}" 소상공인(카페/음식점/뷰티/기타) 인스타그램 트렌드 분석 전문가입니다.

아래 5개 외부 소스(네이버 데이터랩·네이버 블로그·구글 트렌드·YouTube·Instagram)에서 수집한 원시 텍스트를 읽고,
각 업종 카테고리에서 실제 유행하는 **트렌드 대상** 키워드 8~12개씩 선별해 JSON으로 반환하세요.

[원시 수집 텍스트]
${sections}

## 절대 준수 — "트렌드 자체" vs "트렌드를 찾기 위한 검색어" 엄격 구분
- 유효(선별 O): 구체적 대상·제품·메뉴·스타일·기법
  예) 말차라떼, 크로플, 글레이즈드네일, 오마카세, 팝업스토어, 뉴트로, matcha latte, smash burger, glazed nails
- 무효(제외): 카테고리·평가·행위·의도
  예) 맛집, 핫플레이스, 추천, 축제, 재밌는곳, 데이트코스, 가볼만한곳, 인기, 데일리, 맛있는, 예쁜

## 추가 금지
- 뉴스매체·패션지(중앙일보, 연합뉴스, 코스모폴리탄, 보그 등)
- 경쟁 브랜드(스타벅스, 이디야, 투썸, 메가커피, Starbucks 등)
- 필러 워드(아이디어, 방법, 추천, 정보, 모음, 팁, 가이드, 리스트)
- 뉴스 문장 단편(유행하는, 뜨는, 라고, 밝혀, 화제의)
- 상시 해시태그(인스타그램, 좋아요, 팔로우, 일상, 데일리)
- 지역명 단독(서울, 강남, 홍대, 성수)

## 언어 규칙
${languageRule}

## 출력 형식 (엄격)
JSON 객체만 반환. 설명·마크다운·코드블록 금지.
스키마:
{"cafe": ["키워드1", ...], "food": ["키워드1", ...], "beauty": ["키워드1", ...], "other": ["키워드1", ...]}

- 각 배열 8~12개 (데이터 부족 시 더 적어도 됨)
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
      console.error('[gpt-classify]', scope, 'status:', result.status);
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
      console.error('[gpt-classify]', scope, 'JSON parse 실패');
      return null;
    }

    // 카테고리별 정규화 + 필터
    const out = {};
    for (const cat of ['cafe', 'food', 'beauty', 'other']) {
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
    console.error('[gpt-classify]', scope, '실패:', e.message);
    return null;
  }
}

// ---------------- "뜰 가능성" 예측 (gpt-4o-mini) ----------------
async function predictRisingWithGPT({ category, domesticTags, globalTags, naverData, blogData, youtubeData, googleKR }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const categoryKo = CATEGORY_KO[category] || '일반';
  const recentStr = (naverData || []).slice(0, 8).join(', ') || '없음';
  const blogStr = (blogData || []).slice(0, 6).join(' | ').slice(0, 500) || '없음';
  const ytStr = (youtubeData || []).slice(0, 6).join(' | ').slice(0, 500) || '없음';
  const googleStr = (googleKR || []).slice(0, 8).join(', ') || '없음';
  const currentStr = [...(domesticTags || []).slice(0, 5), ...(globalTags || []).slice(0, 3)].join(', ') || '없음';

  const prompt = `당신은 인스타그램 트렌드 예측 전문가입니다.

"${categoryKo}" 업종에서 앞으로 2~4주 안에 유행할 가능성이 높은 키워드 5개를 예측하세요.

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
        max_output_tokens: 700,
        store: false,
      },
      25000
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
    ).slice(0, 5);

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
  console.log('[scheduled-trends] Phase 1 재구축 파이프라인 시작 (5소스 + gpt-4o-mini)');

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

  const categories = ['cafe', 'food', 'beauty', 'other'];
  const updatedAt = new Date().toISOString();

  // --- 1단계: 전 업종 병렬 수집 ---
  // 구글 트렌드는 업종 무관하므로 1회만
  const [googleKR, googleUS] = await Promise.all([
    fetchGoogleTrendsLib('KR'),
    fetchGoogleTrendsLib('US'),
  ]);
  console.log(`[sources] google-kr: ${googleKR.length}, google-us: ${googleUS.length}`);

  // 업종별 소스 수집 (소스별 실패는 빈 배열로 격리)
  const rawByCategory = {};
  for (const category of categories) {
    const [naverData, blogData, ytKR, ytUS, igTexts] = await Promise.all([
      fetchNaverDatalab(category),
      fetchNaverBlogs(category),
      fetchYouTube(category, 'KR'),
      fetchYouTube(category, 'US'),
      fetchInstagram(category),
    ]);
    rawByCategory[category] = { naverData, blogData, ytKR, ytUS, igTexts };
    console.log(`[${category}] naver=${naverData.length} blog=${blogData.length} yt-kr=${ytKR.length} yt-us=${ytUS.length} ig=${igTexts.length}`);
  }

  // --- 2단계: gpt-4o-mini 배치 분류 (국내/해외 각 1회) ---
  const domesticTexts = {};
  const globalTexts = {};
  for (const cat of categories) {
    const r = rawByCategory[cat];
    // 국내: 네이버 데이터랩 + 블로그 + YouTube KR + 구글 KR + IG (한국어 우세)
    domesticTexts[cat] = [
      ...r.naverData,
      ...r.blogData,
      ...r.ytKR,
      ...googleKR,
      ...r.igTexts,
    ];
    // 해외: YouTube US + 구글 US (영어 위주)
    globalTexts[cat] = [
      ...r.ytUS,
      ...googleUS,
    ];
  }

  let domesticClassified = null;
  let globalClassified = null;
  if (process.env.OPENAI_API_KEY) {
    [domesticClassified, globalClassified] = await Promise.all([
      classifyBatchWithGPT({ scope: 'domestic', rawTextsByCategory: domesticTexts }),
      classifyBatchWithGPT({ scope: 'global', rawTextsByCategory: globalTexts }),
    ]);
  }

  // --- 3단계: 저장 + rising 예측 ---
  const results = [];
  const allDomestic = [];
  const allGlobal = [];

  for (const category of categories) {
    try {
      const r = rawByCategory[category];

      // 국내 태그 선정
      let domesticTags = (domesticClassified && domesticClassified[category]) || [];
      if (!domesticTags || domesticTags.length < 3) {
        // fallback: 네이버 데이터랩 타이틀 + DEFAULT
        const fromNaver = (r.naverData || []).map(normalize).filter(kw => !isBadKeyword(kw));
        domesticTags = [...new Set([...fromNaver, ...DEFAULT_TRENDS[category]])].slice(0, 10);
      } else {
        domesticTags = domesticTags.slice(0, 10);
      }
      await saveScope({ supa, scope: 'domestic', category, tags: domesticTags, updatedAt, source: 'gpt-4o-mini' });
      domesticTags.forEach((kw, i) => allDomestic.push({
        keyword: kw, score: 100 - i * 5, mentions: 0, source: 'gpt-4o-mini', bizCategory: category
      }));

      // 해외 태그 선정
      let globalTags = (globalClassified && globalClassified[category]) || [];
      if (!globalTags || globalTags.length < 3) {
        globalTags = [...DEFAULT_GLOBAL_TRENDS[category]].slice(0, 10);
      } else {
        globalTags = globalTags.slice(0, 10);
      }
      await saveScope({ supa, scope: 'global', category, tags: globalTags, updatedAt, source: 'gpt-4o-mini' });
      globalTags.forEach((kw, i) => allGlobal.push({
        keyword: kw, score: 100 - i * 5, mentions: 0, source: 'gpt-4o-mini', bizCategory: category
      }));

      // 뜰 가능성 예측 (domestic 한정)
      let risingItems = null;
      if (process.env.OPENAI_API_KEY) {
        risingItems = await predictRisingWithGPT({
          category,
          domesticTags,
          globalTags,
          naverData: r.naverData,
          blogData: r.blogData,
          youtubeData: r.ytKR,
          googleKR,
        });
      }
      if (!risingItems || risingItems.length < 2) {
        risingItems = domesticTags.slice(4, 8).map((kw, i) => ({
          keyword: kw,
          confidence: 60 - i * 5,
          growthRate: '+' + (20 - i * 3) + '%',
          reason: '국내 트렌드 상승세',
        }));
      }
      try {
        await supa.from('trends').upsert(
          {
            category: `l30d-rising:${category}`,
            keywords: { items: risingItems, updatedAt, source: 'gpt-prediction' },
            collected_at: updatedAt,
          },
          { onConflict: 'category' }
        );
      } catch(e) {
        console.error(`[rising] ${category} 저장 실패:`, e.message);
      }

      results.push({
        category,
        domestic: domesticTags.length,
        global: globalTags.length,
        rising: risingItems.length,
      });
      console.log(`[${category}] 국내:`, domesticTags.join(', '));
      console.log(`[${category}] 해외:`, globalTags.join(', '));
      console.log(`[${category}] 뜰 가능성:`, risingItems.map(r => r.keyword).join(', '));

      await new Promise(r => setTimeout(r, 300));
    } catch(e) {
      console.error(`[scheduled-trends] ${category} 실패:`, e.message);
      try {
        await saveScope({ supa, scope: 'domestic', category, tags: DEFAULT_TRENDS[category], updatedAt, source: 'fallback' });
        await saveScope({ supa, scope: 'global', category, tags: DEFAULT_GLOBAL_TRENDS[category], updatedAt, source: 'fallback' });
      } catch(e2) {}
      results.push({ category, error: e.message });
    }
  }

  // --- 4단계: 종합(all) 저장 ---
  try {
    allDomestic.sort((a, b) => (b.score || 0) - (a.score || 0));
    allGlobal.sort((a, b) => (b.score || 0) - (a.score || 0));

    try {
      const { data: curD } = await supa.from('trends').select('keywords').eq('category', 'l30d-domestic:all').single();
      if (curD) await supa.from('trends').upsert(
        { category: 'l30d-domestic-prev:all', keywords: curD.keywords, collected_at: updatedAt },
        { onConflict: 'category' }
      );
    } catch(e) {}
    try {
      const { data: curG } = await supa.from('trends').select('keywords').eq('category', 'l30d-global:all').single();
      if (curG) await supa.from('trends').upsert(
        { category: 'l30d-global-prev:all', keywords: curG.keywords, collected_at: updatedAt },
        { onConflict: 'category' }
      );
    } catch(e) {}

    await supa.from('trends').upsert(
      { category: 'l30d-domestic:all', keywords: { keywords: allDomestic.slice(0, 20), updatedAt, source: 'scheduled-gpt-all' }, collected_at: updatedAt },
      { onConflict: 'category' }
    );
    await supa.from('trends').upsert(
      { category: 'l30d-global:all', keywords: { keywords: allGlobal.slice(0, 20), updatedAt, source: 'scheduled-gpt-all' }, collected_at: updatedAt },
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
