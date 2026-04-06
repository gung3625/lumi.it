const { getStore } = require('@netlify/blobs');
const https = require('https');

const DEFAULT_TRENDS = {
  cafe: ['#신메뉴출시', '#오늘의커피', '#카페스타그램', '#라떼아트', '#디저트맛집', '#카페투어', '#핸드드립', '#베이커리'],
  food: ['#신메뉴', '#오늘점심', '#오늘저녁', '#맛집추천', '#맛스타그램', '#주말특선', '#혼밥', '#맛집탐방'],
  beauty: ['#신규디자인', '#네일스타그램', '#헤어스타일', '#오늘의메이크업', '#젤네일', '#네일아트', '#헤어컬러', '#뷰티스타그램'],
  other: ['#신메뉴', '#오늘의추천', '#이벤트진행중', '#단골환영', '#오픈이벤트', '#일상스타그램', '#데일리', '#추천']
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

function httpsPost(hostname, path, headers, body) {
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
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
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

// 2. Google Trends (비공식 RSS)
async function fetchGoogleTrends(category) {
  try {
    const catMap = { cafe: '카페 커피', food: '맛집 식당', beauty: '뷰티 헤어 네일', other: '소상공인' };
    const query = encodeURIComponent(catMap[category] || '소상공인');
    const url = `https://trends.google.com/trends/trendingsearches/daily/rss?geo=KR`;
    const result = await httpsGet(url);
    if (result.status !== 200) return null;

    // RSS에서 title 추출
    const titles = [];
    const matches = result.body.matchAll(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/g);
    for (const match of matches) {
      const title = match[1].trim();
      if (title && title !== 'Google Trends' && titles.length < 10) {
        titles.push(title);
      }
    }
    return titles.length > 0 ? titles : null;
  } catch(e) {
    console.error('[google] error:', e.message);
    return null;
  }
}

// 3. GPT 웹 검색으로 인스타 트렌드 조사 + 3가지 소스 종합
async function synthesizeWithGPT(category, naverData, googleData) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const categoryKo = CATEGORY_KO[category];
  const naverStr = naverData ? naverData.join(', ') : '데이터 없음';
  const googleStr = googleData ? googleData.slice(0, 5).join(', ') : '데이터 없음';

  const prompt = `당신은 한국 소상공인 SNS 마케팅 전문가입니다.

아래 데이터를 참고해서 오늘 날짜 기준 한국 인스타그램에서 "${categoryKo}" 업종 소상공인이 사용하면 노출이 잘 되는 해시태그를 선정해주세요.

[네이버 데이터랩 트렌드]
${naverStr}

[구글 트렌드 (한국)]
${googleStr}

위 데이터를 종합하고, 실제 인스타그램에서 "${categoryKo}" 관련 게시물에 많이 사용되는 해시태그 트렌드도 고려해서:
- 노출이 잘 되는 해시태그 8개를 선정하세요
- 너무 광범위하거나 너무 좁지 않은 적절한 태그
- 소상공인 매장 사진에 어울리는 태그
- # 포함해서 응답 (예: #카페스타그램)
- JSON 배열만 응답 (다른 설명 없이)

예시 형식: ["#카페스타그램","#오늘의커피","#신메뉴출시","#카페투어","#디저트맛집","#베이커리","#핸드드립","#라떼아트"]`;

  try {
    const result = await httpsPost(
      'api.openai.com',
      '/v1/chat/completions',
      {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      {
        model: 'gpt-4o-mini',
        max_tokens: 300,
        messages: [
          { role: 'system', content: '한국 인스타그램 해시태그 전문가. JSON 배열만 응답.' },
          { role: 'user', content: prompt }
        ]
      }
    );

    if (result.status !== 200) {
      console.error('[gpt] status:', result.status, result.body);
      return null;
    }

    const data = JSON.parse(result.body);
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    // JSON 파싱
    const clean = content.replace(/```json|```/g, '').trim();
    const tags = JSON.parse(clean);
    if (Array.isArray(tags) && tags.length > 0) {
      return tags.slice(0, 8);
    }
    return null;
  } catch(e) {
    console.error('[gpt] error:', e.message);
    return null;
  }
}

// 메인 핸들러
exports.handler = async (event) => {
  console.log('[scheduled-trends] 트렌드 자동 업데이트 시작 (네이버+구글+GPT)');

  const categories = ['cafe', 'food', 'beauty', 'other'];
  const store = getStore({ name: 'trends', consistency: 'strong', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_TOKEN });
  const updatedAt = new Date().toISOString();
  const results = [];

  for (const category of categories) {
    try {
      // 3가지 소스 병렬 조회
      const [naverData, googleData] = await Promise.all([
        fetchNaverTrends(category),
        fetchGoogleTrends(category)
      ]);

      console.log(`[${category}] 네이버: ${naverData?.length || 0}개, 구글: ${googleData?.length || 0}개`);

      // GPT로 종합
      let finalTags = null;
      if (process.env.OPENAI_API_KEY) {
        finalTags = await synthesizeWithGPT(category, naverData, googleData);
        console.log(`[${category}] GPT 종합: ${finalTags?.length || 0}개`);
      }

      // GPT 실패 시 네이버 → 기본값 순으로 fallback
      if (!finalTags) {
        if (naverData && naverData.length > 0) {
          finalTags = naverData.map(k => '#' + k.replace(/\s/g, '')).slice(0, 8);
          finalTags = [...new Set([...finalTags, ...DEFAULT_TRENDS[category]])].slice(0, 8);
        } else {
          finalTags = DEFAULT_TRENDS[category];
        }
      }

      await store.set('trends:' + category, JSON.stringify({ tags: finalTags, updatedAt }));
      results.push({ category, count: finalTags.length, sources: { naver: !!naverData, google: !!googleData, gpt: !!process.env.OPENAI_API_KEY } });
      console.log(`[${category}] 완료:`, finalTags.join(', '));

      // API 과부하 방지
      await new Promise(r => setTimeout(r, 500));

    } catch(e) {
      console.error(`[scheduled-trends] ${category} 실패:`, e.message);
      const fallback = DEFAULT_TRENDS[category];
      await store.set('trends:' + category, JSON.stringify({ tags: fallback, updatedAt }));
      results.push({ category, source: 'error', error: e.message });
    }
  }

  console.log('[scheduled-trends] 완료:', JSON.stringify(results));
  return { statusCode: 200, body: JSON.stringify({ success: true, results }) };
};

module.exports.config = {
  schedule: '0 0 * * *'
};
