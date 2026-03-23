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

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname,
      path,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: responseData }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

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
      const baseTags = DEFAULT_TRENDS[category] || DEFAULT_TRENDS.other;
      const trendTags = sorted.flatMap(g => g.title ? ['#' + g.title.replace(/\s/g, '')] : []);
      return [...new Set([...trendTags, ...baseTags])].slice(0, 8);
    }
    return null;
  } catch(e) {
    console.error('Naver fetch error:', e.message);
    return null;
  }
}

// 매일 오전 9시(KST) = UTC 00:00
exports.handler = async (event) => {
  console.log('[scheduled-trends] 트렌드 자동 업데이트 시작');

  const categories = ['cafe', 'food', 'beauty', 'other'];
  const store = getStore('trends');
  const updatedAt = new Date().toISOString();
  const results = [];

  for (const category of categories) {
    try {
      const tags = await fetchNaverTrends(category);
      const finalTags = tags || DEFAULT_TRENDS[category];
      await store.set('trends:' + category, JSON.stringify({ tags: finalTags, updatedAt }));
      results.push({ category, source: tags ? 'naver' : 'default', count: finalTags.length });
      console.log(`[scheduled-trends] ${category} 업데이트 완료 (${tags ? 'naver' : 'default'})`);
    } catch(e) {
      console.error(`[scheduled-trends] ${category} 업데이트 실패:`, e.message);
      results.push({ category, source: 'error', error: e.message });
    }
  }

  console.log('[scheduled-trends] 완료:', JSON.stringify(results));
};

// 매일 오전 9시 KST (= UTC 00:00)
module.exports.config = {
  schedule: '0 0 * * *'
};
