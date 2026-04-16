const { getStore } = require('@netlify/blobs');

// 뻔한 상시 검색어 블랙리스트 (저장 시점에 제거)
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

function filterTags(tags) {
  if (!Array.isArray(tags)) return tags;
  const filtered = tags.filter(t => {
    const kw = (typeof t === 'string' ? t : (t.keyword || '')).replace(/^#/, '').toLowerCase();
    return !BLACKLIST.includes(kw);
  });
  return filtered.length >= 3 ? filtered : tags;
}

function filterKeywords(keywords) {
  if (!Array.isArray(keywords)) return keywords;
  // 1. 중복 병합 (같은 keyword → score 합산, mentions 합산)
  const map = new Map();
  for (const k of keywords) {
    const key = (k.keyword || '').replace(/^#/, '').trim().toLowerCase();
    if (!key) continue;
    if (map.has(key)) {
      const existing = map.get(key);
      existing.score = (existing.score || 0) + (k.score || 0);
      existing.mentions = (existing.mentions || 0) + (k.mentions || 0);
    } else {
      map.set(key, { ...k, keyword: k.keyword.replace(/^#/, '').trim() });
    }
  }
  const merged = Array.from(map.values()).sort((a, b) => (b.score || 0) - (a.score || 0));
  // 2. 블랙리스트 필터
  const filtered = merged.filter(k => {
    const kw = (k.keyword || '').toLowerCase();
    return !BLACKLIST.includes(kw);
  });
  return filtered.length >= 3 ? filtered : merged;
}

// 오늘 날짜를 YYYY-MM-DD 형식으로 반환
function getDateStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

// 180일 이전 날짜별 키를 삭제 (best-effort)
async function cleanupOldKeys(store, prefix) {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 180);
    const result = await store.list({ prefix });
    const blobs = (result && result.blobs) ? result.blobs : [];
    for (const blob of blobs) {
      // 키 끝부분에서 날짜(YYYY-MM-DD) 추출
      const match = blob.key.match(/:(\d{4}-\d{2}-\d{2})$/);
      if (!match) continue;
      const keyDate = new Date(match[1]);
      if (keyDate < cutoff) {
        try {
          await store.delete(blob.key);
          console.log('[cleanup] 삭제:', blob.key);
        } catch(e) {
          console.warn('[cleanup] 삭제 실패:', blob.key);
        }
      }
    }
  } catch(e) {
    console.warn('[cleanup] list 실패, prefix:', prefix);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Make에서 호출 시 간단한 인증 (환경변수로 시크릿 키 확인)
  const authHeader = event.headers['x-lumi-secret'];
  if (!process.env.LUMI_SECRET || authHeader !== process.env.LUMI_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: '인증 실패' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  // body.trends = { cafe: [...], food: [...], beauty: [...], other: [...] }
  const { trends } = body;
  if (!trends || typeof trends !== 'object') {
    return { statusCode: 400, body: JSON.stringify({ error: 'trends 데이터가 없습니다.' }) };
  }

  try {
    const store = getStore({ name: 'trends', consistency: 'strong', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });
    const updatedAt = new Date().toISOString();
    const dateStr = getDateStr();
    const updated = [];

    for (const [category, tags] of Object.entries(trends)) {
      if (!Array.isArray(tags) || tags.length === 0) continue;
      const payload = JSON.stringify({ tags: filterTags(tags), updatedAt, source: 'last30days' });
      await store.set('trends:' + category, payload);
      await store.set('trends:' + category + ':' + dateStr, payload);
      updated.push(category);
    }
    // trends 날짜별 키 cleanup (best-effort)
    for (const category of updated) {
      cleanupOldKeys(store, 'trends:' + category + ':').catch(() => {});
    }

    // last30days 상세 데이터 저장 (keywords with scores, sources, findingsCount)
    if (body.last30days && typeof body.last30days === 'object') {
      for (const [category, data] of Object.entries(body.last30days)) {
        const filteredData = data.keywords ? { ...data, keywords: filterKeywords(data.keywords) } : data;
        const payload = JSON.stringify(filteredData);
        await store.set('l30d:' + category, payload);
        await store.set('l30d:' + category + ':' + dateStr, payload);
      }
      // l30d 날짜별 키 cleanup (best-effort)
      for (const category of Object.keys(body.last30days)) {
        cleanupOldKeys(store, 'l30d:' + category + ':').catch(() => {});
      }
    }

    // GPT 분류 결과: 국내 트렌드 (현재→prev 백업 후 저장)
    const allDomesticKeywords = [];
    if (body.domestic && typeof body.domestic === 'object') {
      for (const [category, data] of Object.entries(body.domestic)) {
        try {
          const cur = await store.get('l30d-domestic:' + category);
          if (cur) await store.set('l30d-domestic-prev:' + category, cur);
        } catch(e) {}
        const filteredData = data.keywords ? { ...data, keywords: filterKeywords(data.keywords) } : data;
        const payload = JSON.stringify(filteredData);
        await store.set('l30d-domestic:' + category, payload);
        await store.set('l30d-domestic:' + category + ':' + dateStr, payload);
        // 종합 트렌드용 수집
        if (data.keywords && Array.isArray(data.keywords)) {
          data.keywords.forEach(k => allDomesticKeywords.push({ ...k, bizCategory: category }));
        }
      }
      // 종합 국내 트렌드 저장 (업종별 상위 키워드 합산, 점수순 정렬)
      if (allDomesticKeywords.length > 0) {
        allDomesticKeywords.sort((a, b) => (b.score || 0) - (a.score || 0));
        const allDomesticData = { keywords: allDomesticKeywords.slice(0, 20), updatedAt, source: 'gpt-classified-all' };
        const allPayload = JSON.stringify(allDomesticData);
        try {
          const cur = await store.get('l30d-domestic:all');
          if (cur) await store.set('l30d-domestic-prev:all', cur);
        } catch(e) {}
        await store.set('l30d-domestic:all', allPayload);
        await store.set('l30d-domestic:all:' + dateStr, allPayload);
      }
      // l30d-domestic 날짜별 키 cleanup (best-effort)
      for (const category of [...Object.keys(body.domestic), 'all']) {
        cleanupOldKeys(store, 'l30d-domestic:' + category + ':').catch(() => {});
      }
    }

    // GPT 분류 결과: 해외 트렌드 (현재→prev 백업 후 저장)
    const allGlobalKeywords = [];
    if (body.global && typeof body.global === 'object') {
      for (const [category, data] of Object.entries(body.global)) {
        try {
          const cur = await store.get('l30d-global:' + category);
          if (cur) await store.set('l30d-global-prev:' + category, cur);
        } catch(e) {}
        const filteredData = data.keywords ? { ...data, keywords: filterKeywords(data.keywords) } : data;
        const payload = JSON.stringify(filteredData);
        await store.set('l30d-global:' + category, payload);
        await store.set('l30d-global:' + category + ':' + dateStr, payload);
        // 종합 트렌드용 수집
        if (data.keywords && Array.isArray(data.keywords)) {
          data.keywords.forEach(k => allGlobalKeywords.push({ ...k, bizCategory: category }));
        }
      }
      // 종합 해외 트렌드 저장
      if (allGlobalKeywords.length > 0) {
        allGlobalKeywords.sort((a, b) => (b.score || 0) - (a.score || 0));
        const allGlobalData = { keywords: allGlobalKeywords.slice(0, 20), updatedAt, source: 'gpt-classified-all' };
        const allPayload = JSON.stringify(allGlobalData);
        try {
          const cur = await store.get('l30d-global:all');
          if (cur) await store.set('l30d-global-prev:all', cur);
        } catch(e) {}
        await store.set('l30d-global:all', allPayload);
        await store.set('l30d-global:all:' + dateStr, allPayload);
      }
      // l30d-global 날짜별 키 cleanup (best-effort)
      for (const category of [...Object.keys(body.global), 'all']) {
        cleanupOldKeys(store, 'l30d-global:' + category + ':').catch(() => {});
      }
    }

    // 캡션뱅크 (업종별 참고 캡션) — 날짜별 보관 불필요
    if (body.captionBank && typeof body.captionBank === 'object') {
      for (const [category, captions] of Object.entries(body.captionBank)) {
        await store.set('caption-bank:' + category, JSON.stringify(captions));
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        updated,
        updatedAt
      })
    };
  } catch (err) {
    console.error('update-trends error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: '트렌드 업데이트 중 오류가 발생했습니다.' })
    };
  }
};
