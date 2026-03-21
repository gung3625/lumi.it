const { getStore } = require('@netlify/blobs');

// 업종별 기본 트렌드 (Blobs에 데이터 없을 때 폴백)
const DEFAULT_TRENDS = {
  cafe: [
    '#오늘의커피', '#카페스타그램', '#커피그램', '#카페투어',
    '#핸드드립', '#라떼아트', '#카페인생', '#커피한잔'
  ],
  food: [
    '#오늘뭐먹지', '#맛스타그램', '#먹스타그램', '#맛집탐방',
    '#오늘저녁', '#혼밥', '#집밥', '#맛집추천'
  ],
  beauty: [
    '#뷰티스타그램', '#데일리메이크업', '#네일아트', '#헤어스타일',
    '#오오티디', '#셀스타그램', '#뷰티팁', '#스킨케어'
  ],
  other: [
    '#소상공인', '#로컬맛집', '#동네가게', '#골목상권',
    '#오늘의추천', '#일상스타그램', '#데일리', '#인스타그램'
  ]
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // 업종 파라미터 (GET: ?category=cafe, POST: body.category)
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

  // 알려진 카테고리면 그대로, 아니면 'other'로 처리
  const knownCategories = ['cafe', 'food', 'beauty'];
  const storeKey = knownCategories.includes(category) ? category : 'other';

  try {
    const store = getStore('trends');

    let raw;
    try {
      raw = await store.get('trends:' + storeKey);
    } catch(e) {
      raw = null;
    }

    if (raw) {
      const data = JSON.parse(raw);
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({
          category: storeKey,
          tags: data.tags,
          updatedAt: data.updatedAt,
          source: 'realtime'
        })
      };
    }

    // Blobs에 데이터 없으면 기본값 반환
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        category: storeKey,
        tags: DEFAULT_TRENDS[storeKey] || DEFAULT_TRENDS.other,
        updatedAt: null,
        source: 'default'
      })
    };
  } catch (err) {
    console.error('get-trends error:', err);
    return {
      statusCode: 200, // 에러여도 기본값 내려주기
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        category: storeKey,
        tags: DEFAULT_TRENDS[storeKey] || DEFAULT_TRENDS.other,
        updatedAt: null,
        source: 'fallback'
      })
    };
  }
};
