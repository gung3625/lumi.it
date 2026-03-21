const { getStore } = require('@netlify/blobs');

const DEFAULT_TRENDS = {
  cafe: ['#오늘의커피', '#카페스타그램', '#커피그램', '#카페투어', '#핸드드립', '#라떼아트', '#카페인생', '#커피한잔'],
  food: ['#오늘뭐먹지', '#맛스타그램', '#먹스타그램', '#맛집탐방', '#오늘저녁', '#혼밥', '#집밥', '#맛집추천'],
  beauty: ['#뷰티스타그램', '#데일리메이크업', '#네일아트', '#헤어스타일', '#오오티디', '#셀스타그램', '#뷰티팁', '#스킨케어'],
  other: ['#소상공인', '#로컬맛집', '#동네가게', '#골목상권', '#오늘의추천', '#일상스타그램', '#데일리', '#인스타그램']
};

// 업종별 네이버 데이터랩 검색 키워드 그룹
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

// 네이버 데이터랩 트렌드 검색어 API 호출
async function fetchNaverTrends(category) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const today = new Date();
  const endDate = today.toISOString().slice(0, 10);
  const startDate = new Date(today - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const keywordGroups = NAVER_KEYWORDS[category] || NAVER_KEYWORDS.other;

  const body = {
    startDate,
    endDate,
    timeUnit: 'week',
    keywordGroups,
    device: 'mo',
    ages: ['2', '3', '4', '5'],
    gender: 'f'
  };

  try {
    const fetch = require('node-fetch');
    const res = await fetch('https://openapi.naver.com/v1/datalab/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) return null;
    const data = await res.json();

    // 트렌드 결과를 해시태그로 변환
    if (data.results && data.results.length > 0) {
      const trendingGroups = data.results
        .sort((a, b) => {
          const aAvg = a.data.reduce((s, d) => s + d.ratio, 0) / a.data.length;
          const bAvg = b.data.reduce((s, d) => s + d.ratio, 0) / b.data.length;
          return bAvg - aAvg;
        });

      // 트렌딩 키워드를 해시태그로 변환 + 기본 태그 믹스
      const baseTags = DEFAULT_TRENDS[category] || DEFAULT_TRENDS.other;
      const trendTags = trendingGroups.flatMap(g =>
        g.title ? ['#' + g.title.replace(/\s/g, '')] : []
      );

      // 트렌드 태그 앞에, 기본 태그 뒤에 배치
      const merged = [...new Set([...trendTags, ...baseTags])].slice(0, 8);
      return merged;
    }
    return null;
  } catch(e) {
    console.error('Naver API error:', e);
    return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
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

  try {
    const store = getStore('trends');

    // 1. Blobs에 오늘 캐시된 데이터 있으면 바로 반환
    let raw;
    try { raw = await store.get('trends:' + storeKey); } catch { raw = null; }

    if (raw) {
      const cached = JSON.parse(raw);
      const updatedAt = new Date(cached.updatedAt);
      const now = new Date();
      const hoursDiff = (now - updatedAt) / (1000 * 60 * 60);

      // 12시간 이내 캐시면 그대로 사용
      if (hoursDiff < 12) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ category: storeKey, tags: cached.tags, updatedAt: cached.updatedAt, source: 'realtime' })
        };
      }
    }

    // 2. 캐시 없거나 오래됐으면 네이버 API 호출
    const naverTags = await fetchNaverTrends(storeKey);
    if (naverTags) {
      const updatedAt = new Date().toISOString();
      await store.set('trends:' + storeKey, JSON.stringify({ tags: naverTags, updatedAt }));
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ category: storeKey, tags: naverTags, updatedAt, source: 'realtime' })
      };
    }

    // 3. 네이버 API 실패하면 기본값
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ category: storeKey, tags: DEFAULT_TRENDS[storeKey] || DEFAULT_TRENDS.other, updatedAt: null, source: 'default' })
    };

  } catch (err) {
    console.error('get-trends error:', err);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ category: storeKey, tags: DEFAULT_TRENDS[storeKey] || DEFAULT_TRENDS.other, updatedAt: null, source: 'fallback' })
    };
  }
};
