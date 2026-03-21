const { getStore } = require('@netlify/blobs');
const https = require('https');

const DEFAULT_TRENDS = {
  cafe: ['#오늘의커피', '#카페스타그램', '#커피그램', '#카페투어', '#핸드드립', '#라떼아트', '#카페인생', '#커피한잔'],
  food: ['#오늘뭐먹지', '#맛스타그램', '#먹스타그램', '#맛집탐방', '#오늘저녁', '#혼밥', '#집밥', '#맛집추천'],
  beauty: ['#뷰티스타그램', '#데일리메이크업', '#네일아트', '#헤어스타일', '#오오티디', '#셀스타그램', '#뷰티팁', '#스킨케어'],
  other: ['#소상공인', '#로컬맛집', '#동네가게', '#골목상권', '#오늘의추천', '#일상스타그램', '#데일리', '#인스타그램']
};

const NAVER_KEYWORDS = {
  cafe: [
    { groupName: '카페', keywords: [{ name: '카페' }, { name: '커피' }, { name: '카페스타그램' }] },
    { groupName: '베이커리', keywords: [{ name: '베이커리' }, { name: '빵집' }, { name: '디저트' }] }
  ],
  food: [
    { groupName: '맛집', keywords: [{ name: '맛집' }, { name: '식당' }, { name: '맛스타그램' }] },
    { groupName: '배달음식', keywords: [{ name: '배달음식' }, { name: '오늘뭐먹지' }, { name: '혼밥' }] }
  ],
  beauty: [
    { groupName: '뷰티', keywords: [{ name: '뷰티' }, { name: '메이크업' }, { name: '화장품' }] },
    { groupName: '헤어네일', keywords: [{ name: '헤어샵' }, { name: '네일아트' }, { name: '에스테틱' }] }
  ],
  other: [
    { groupName: '소상공인', keywords: [{ name: '소상공인' }, { name: '동네가게' }, { name: '로컬' }] }
  ]
};

// https 모듈로 네이버 API 직접 호출 (fetch 대신)
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname,
      path,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: responseData });
      });
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
  if (!clientId || !clientSecret) {
    console.log('Naver credentials missing');
    return null;
  }

  const today = new Date();
  const endDate = today.toISOString().slice(0, 10);
  const startDate = new Date(today - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const keywordGroups = NAVER_KEYWORDS[category] || NAVER_KEYWORDS.other;

  const requestBody = {
    startDate,
    endDate,
    timeUnit: 'week',
    keywordGroups,
    device: 'mo',
    ages: ['2', '3', '4', '5'],
    gender: 'f'
  };

  try {
    const result = await httpsPost(
      'openapi.naver.com',
      '/v1/datalab/search',
      {
        'Content-Type': 'application/json',
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret
      },
      requestBody
    );

    if (result.status !== 200) {
      console.error('Naver API error:', result.status, result.body);
      return null;
    }

    const data = JSON.parse(result.body);
    if (data.results && data.results.length > 0) {
      const sorted = data.results.sort((a, b) => {
        const aAvg = a.data.reduce((s, d) => s + d.ratio, 0) / a.data.length;
        const bAvg = b.data.reduce((s, d) => s + d.ratio, 0) / b.data.length;
        return bAvg - aAvg;
      });

      const baseTags = DEFAULT_TRENDS[category] || DEFAULT_TRENDS.other;
      const trendTags = sorted.flatMap(g => g.title ? ['#' + g.title.replace(/\s/g, '')] : []);
      const merged = [...new Set([...trendTags, ...baseTags])].slice(0, 8);
      return merged;
    }
    return null;
  } catch(e) {
    console.error('Naver fetch error:', e.message);
    return null;
  }
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let category = 'cafe';
  if (event.httpMethod === 'GET') {
    const params = new URLSearchParams(event.rawQuery || '');
    category = params.get('category') || 'cafe';
  } else {
    try {
      const body = JSON.parse(event.body || '{}');
      category = body.category || 'cafe';
    } catch { category = 'cafe'; }
  }

  const knownCategories = ['cafe', 'food', 'beauty'];
  const storeKey = knownCategories.includes(category) ? category : 'other';

  // 1. Blobs 캐시 확인
  try {
    const store = getStore({ name: 'trends', siteID: process.env.SITE_ID, token: process.env.NETLIFY_BLOBS_CONTEXT });
    let raw = null;
    try { raw = await store.get('trends:' + storeKey); } catch(e) { console.log('Blobs get error:', e.message); }

    if (raw) {
      const cached = JSON.parse(raw);
      const hoursDiff = (Date.now() - new Date(cached.updatedAt)) / (1000 * 60 * 60);
      if (hoursDiff < 12) {
        return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ category: storeKey, tags: cached.tags, updatedAt: cached.updatedAt, source: 'realtime' }) };
      }
    }

    // 2. 네이버 API 호출
    const naverTags = await fetchNaverTrends(storeKey);
    if (naverTags) {
      const updatedAt = new Date().toISOString();
      try { await store.set('trends:' + storeKey, JSON.stringify({ tags: naverTags, updatedAt })); } catch(e) { console.log('Blobs set error:', e.message); }
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ category: storeKey, tags: naverTags, updatedAt, source: 'realtime' }) };
    }
  } catch(e) {
    console.error('Blobs init error:', e.message);
  }

  // 3. 네이버 API만 (Blobs 없이)
  const naverTags = await fetchNaverTrends(storeKey);
  if (naverTags) {
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ category: storeKey, tags: naverTags, updatedAt: new Date().toISOString(), source: 'realtime' }) };
  }

  // 4. 최종 기본값
  return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ category: storeKey, tags: DEFAULT_TRENDS[storeKey] || DEFAULT_TRENDS.other, updatedAt: null, source: 'default' }) };
};
