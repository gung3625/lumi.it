// scheduled-trends.js — 네이버 데이터랩 + 구글 트렌드 + GPT 파이프라인
// 매일 자정 l30d-domestic:{cat} / l30d-global:{cat} blob 생성
// (외부 릴레이 푸시는 폐지, CLAUDE.md 참조)

const { getStore } = require('@netlify/blobs');
const https = require('https');

// ---------------- 필터 ----------------
const BLACKLIST = [
  // 뻔한 카테고리 단어
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
  // 뉴스매체·신문사·패션지
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
  // 뉴스 문장 단편
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

const CATEGORY_KO = {
  cafe: '카페/베이커리',
  food: '음식점/맛집',
  beauty: '뷰티/헤어/네일',
  other: '소상공인 일반'
};

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

function httpsGet(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
  });
}

// 1. 네이버 데이터랩 트렌드
async function fetchNaverTrends(category) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

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
    if (result.status !== 200) return null;
    const data = JSON.parse(result.body);
    if (data.results && data.results.length > 0) {
      const sorted = data.results.sort((a, b) => {
        const aAvg = a.data.reduce((s, d) => s + d.ratio, 0) / a.data.length;
        const bAvg = b.data.reduce((s, d) => s + d.ratio, 0) / b.data.length;
        return bAvg - aAvg;
      });
      return sorted.map(g => g.title).filter(Boolean);
    }
    return null;
  } catch(e) {
    console.error('[naver] error:', e.message);
    return null;
  }
}

// 2. Google Trends RSS (국내·해외 동일 파서, geo만 다름)
async function fetchGoogleRSS(geo) {
  try {
    const url = `https://trends.google.com/trends/trendingsearches/daily/rss?geo=${geo}`;
    const result = await httpsGet(url);
    if (result.status !== 200) return null;

    const titles = [];
    const matches = result.body.matchAll(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/g);
    for (const match of matches) {
      const title = match[1].trim();
      if (title && title !== 'Google Trends' && titles.length < 20) {
        titles.push(title);
      }
    }
    return titles.length > 0 ? titles : null;
  } catch(e) {
    console.error(`[google-${geo}] 실패:`, e.message);
    return null;
  }
}

// 3. GPT 분류 — 국내/해외 각각 8개 고품질 키워드 산출
async function classifyWithGPT({ scope, category, naverData, googleData }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const categoryKo = CATEGORY_KO[category] || '일반';
  const naverStr = naverData ? naverData.slice(0, 10).join(', ') : '없음';
  const googleStr = googleData ? googleData.slice(0, 10).join(', ') : '없음';
  const localeLabel = scope === 'domestic' ? '국내(한국)' : '해외(영미권)';
  const languageRule = scope === 'domestic'
    ? '- 한국어 단어만 (예: 말차라떼 O, matcha latte X)'
    : '- 영어 단어만 (예: matcha latte O, 말차라떼 X)';
  const sampleArr = scope === 'domestic'
    ? '["큐빅네일","말차라떼","크로플","젤리네일","오마카세","봄신메뉴","딸기시즌","핸드드립"]'
    : '["matcha latte","glazed nails","smash burger","cold brew","clean girl","pop up shop","omakase","specialty coffee"]';

  const prompt = `당신은 "${localeLabel}" 인스타그램 트렌드 전문가입니다.

"${categoryKo}" 업종에서 ${new Date().toISOString().slice(0, 10)} 기준 실제 유행하는 구체적 트렌드 키워드 8개를 선정하세요.

[참고 - 네이버 데이터랩]
${naverStr}

[참고 - 구글 트렌드]
${googleStr}

반드시 지킬 것:
- 구체적 스타일/메뉴/기법/아이템만 (예: 큐빅네일, 말차라떼, 글레이즈드네일)
- 한 단어 또는 공백 없는 합성어 우선, 최대 두 단어
- 길이 2~20자
${languageRule}

절대 금지:
- 카테고리 단어: 카페, 커피, 네일, 뷰티, 맛집, 디저트, 푸드
- 콘텐츠 주제형: ~아이디어, ~추천, ~방법, ~정보, ~모음, ~팁, ~리스트
- 뉴스 문장 단편: 유행하는, 트렌드는, 뜨는, 라고, 밝혀, 화제의
- 상시 해시태그: 인스타그램, 스타그램, 좋아요, 팔로우, 일상, 데일리
- 경쟁 브랜드: 스타벅스, 이디야, 투썸, 메가커피, Starbucks
- 언론사·패션지: 중앙일보, 연합뉴스, 코스모폴리탄, 보그
- 지역명 단독: 서울, 강남, 홍대

응답: JSON 배열만, # 포함 금지, 설명·마크다운 없음.
예시: ${sampleArr}`;

  try {
    const systemPrompt = `인스타그램 해시태그 전문가. ${scope === 'global' ? '영어로만' : '한국어로만'} JSON 배열만 응답. 설명 금지.`;
    const result = await httpsPost(
      'api.openai.com',
      '/v1/responses',
      {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      {
        model: 'gpt-5.4',
        input: `${systemPrompt}\n\n${prompt}`,
        store: false,
      },
      25000
    );

    if (result.status !== 200) {
      console.error('[gpt]', scope, category, 'status:', result.status);
      return null;
    }

    const data = JSON.parse(result.body);
    const content = (data.output?.[0]?.content?.[0]?.text || data.output_text || '').trim();
    if (!content) return null;

    const clean = content.replace(/```json|```/g, '').trim();
    let tags;
    try {
      tags = JSON.parse(clean);
    } catch {
      const extracted = clean.match(/"([^"]+)"/g);
      if (!extracted) return null;
      tags = extracted.map(s => s.replace(/"/g, ''));
    }
    if (!Array.isArray(tags)) return null;

    // 정규화 + 필터 + 중복 제거
    const seen = new Set();
    const cleaned = [];
    for (const t of tags) {
      const norm = normalize(t);
      const key = norm.toLowerCase();
      if (!norm || seen.has(key)) continue;
      if (isBadKeyword(norm)) continue;
      seen.add(key);
      cleaned.push(norm);
      if (cleaned.length >= 8) break;
    }
    return cleaned.length >= 3 ? cleaned : null;
  } catch(e) {
    console.error('[gpt]', scope, category, '실패:', e.message);
    return null;
  }
}

// 키워드 배열 → 저장용 객체 배열 (update-trends와 호환)
function toKeywordObjects(tags, source) {
  return tags.map((kw, i) => ({
    keyword: kw,
    score: 100 - i * 5,
    mentions: 0,
    source,
  }));
}

async function saveScope({ store, scope, category, tags, updatedAt, source }) {
  const dateStr = updatedAt.slice(0, 10);
  const storeKey = `l30d-${scope}:${category}`;
  const prevKey = `l30d-${scope}-prev:${category}`;
  const dateKey = `l30d-${scope}:${category}:${dateStr}`;

  try {
    const cur = await store.get(storeKey);
    if (cur) await store.set(prevKey, cur);
  } catch(e) {}

  const payload = JSON.stringify({
    keywords: toKeywordObjects(tags, source),
    insight: '',
    updatedAt,
    source,
  });
  await store.set(storeKey, payload);
  await store.set(dateKey, payload);

  // 레거시 호환: trends:{cat} (해시태그 배열) — domestic만 업데이트
  if (scope === 'domestic') {
    const tagsWithHash = tags.map(t => '#' + t);
    await store.set('trends:' + category, JSON.stringify({ tags: tagsWithHash, updatedAt, source: 'scheduled-trends' }));
  }
}

// 메인 핸들러
exports.handler = async (event) => {
  // 인증: 스케줄 실행(이벤트에 httpMethod 없음) 또는 LUMI_SECRET 수동 실행
  const isScheduled = !event || !event.httpMethod;
  if (!isScheduled) {
    const secret = (event.headers && (event.headers['x-lumi-secret'] || event.headers['X-Lumi-Secret'])) || '';
    if (!process.env.LUMI_SECRET || secret !== process.env.LUMI_SECRET) {
      return { statusCode: 401, body: JSON.stringify({ error: '인증 실패' }) };
    }
  }
  console.log('[scheduled-trends] 국내·해외 파이프라인 시작 (naver + google + gpt)');

  const categories = ['cafe', 'food', 'beauty', 'other'];
  const store = getStore({
    name: 'trends',
    consistency: 'strong',
    siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
    token: process.env.NETLIFY_TOKEN,
  });
  const updatedAt = new Date().toISOString();

  // 구글 RSS는 업종 무관 → 1회만 조회
  const [googleKR, googleUS] = await Promise.all([
    fetchGoogleRSS('KR'),
    fetchGoogleRSS('US'),
  ]);
  console.log(`[sources] google-kr: ${googleKR?.length || 0}, google-us: ${googleUS?.length || 0}`);

  const results = [];
  const allDomestic = [];
  const allGlobal = [];

  for (const category of categories) {
    try {
      const naverData = await fetchNaverTrends(category);
      console.log(`[${category}] 네이버: ${naverData?.length || 0}`);

      // 국내 분류
      let domesticTags = null;
      if (process.env.OPENAI_API_KEY) {
        domesticTags = await classifyWithGPT({ scope: 'domestic', category, naverData, googleData: googleKR });
      }
      if (!domesticTags || domesticTags.length < 3) {
        const fromNaver = (naverData || []).map(normalize).filter(kw => !isBadKeyword(kw));
        domesticTags = [...new Set([...fromNaver, ...DEFAULT_TRENDS[category]])].slice(0, 8);
      }
      await saveScope({ store, scope: 'domestic', category, tags: domesticTags, updatedAt, source: 'scheduled-gpt' });
      domesticTags.forEach((kw, i) => allDomestic.push({ keyword: kw, score: 100 - i * 5, mentions: 0, source: 'scheduled-gpt', bizCategory: category }));

      // 해외 분류
      let globalTags = null;
      if (process.env.OPENAI_API_KEY) {
        globalTags = await classifyWithGPT({ scope: 'global', category, naverData: null, googleData: googleUS });
      }
      if (!globalTags || globalTags.length < 3) {
        globalTags = [...DEFAULT_GLOBAL_TRENDS[category]].slice(0, 8);
      }
      await saveScope({ store, scope: 'global', category, tags: globalTags, updatedAt, source: 'scheduled-gpt' });
      globalTags.forEach((kw, i) => allGlobal.push({ keyword: kw, score: 100 - i * 5, mentions: 0, source: 'scheduled-gpt', bizCategory: category }));

      results.push({ category, domestic: domesticTags.length, global: globalTags.length });
      console.log(`[${category}] 국내:`, domesticTags.join(', '));
      console.log(`[${category}] 해외:`, globalTags.join(', '));

      await new Promise(r => setTimeout(r, 500));
    } catch(e) {
      console.error(`[scheduled-trends] ${category} 실패:`, e.message);
      try {
        await saveScope({ store, scope: 'domestic', category, tags: DEFAULT_TRENDS[category], updatedAt, source: 'fallback' });
        await saveScope({ store, scope: 'global', category, tags: DEFAULT_GLOBAL_TRENDS[category], updatedAt, source: 'fallback' });
      } catch(e2) {}
      results.push({ category, error: e.message });
    }
  }

  // 종합(all) 저장
  try {
    allDomestic.sort((a, b) => (b.score || 0) - (a.score || 0));
    allGlobal.sort((a, b) => (b.score || 0) - (a.score || 0));
    try { const cur = await store.get('l30d-domestic:all'); if (cur) await store.set('l30d-domestic-prev:all', cur); } catch(e) {}
    try { const cur = await store.get('l30d-global:all'); if (cur) await store.set('l30d-global-prev:all', cur); } catch(e) {}
    await store.set('l30d-domestic:all', JSON.stringify({ keywords: allDomestic.slice(0, 20), updatedAt, source: 'scheduled-gpt-all' }));
    await store.set('l30d-global:all', JSON.stringify({ keywords: allGlobal.slice(0, 20), updatedAt, source: 'scheduled-gpt-all' }));
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
