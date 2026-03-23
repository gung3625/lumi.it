const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
  });
}

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname, path, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => { responseData += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: responseData }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function getDateStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

// 가져온 행사 목록을 네이버 데이터랩 인기도 순으로 정렬
async function rankByNaverTrend(festivals) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret || festivals.length <= 1) return festivals;

  const today = new Date();
  const endDate = today.toISOString().slice(0, 10);
  const startDate = new Date(today - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // 데이터랩 최대 5개 그룹 제한
  const targets = festivals.slice(0, 5);
  const keywordGroups = targets.map(f => ({
    groupName: f.title.slice(0, 20),
    keywords: [f.title.replace(/[()[\]]/g, '').trim().slice(0, 20)]
  }));

  try {
    const result = await httpsPost(
      'openapi.naver.com',
      '/v1/datalab/search',
      {
        'Content-Type': 'application/json',
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret
      },
      { startDate, endDate, timeUnit: 'week', keywordGroups }
    );

    if (result.status !== 200) return festivals;

    const data = JSON.parse(result.body);
    if (!data.results || data.results.length === 0) return festivals;

    // 최근 검색량 평균으로 점수 계산
    const scoreMap = {};
    data.results.forEach(r => {
      const avg = r.data.length > 0
        ? r.data.reduce((s, d) => s + d.ratio, 0) / r.data.length
        : 0;
      scoreMap[r.title] = avg;
    });

    // 인기도 높은 순 정렬
    return [...festivals].sort((a, b) => {
      const scoreA = scoreMap[a.title.slice(0, 20)] || 0;
      const scoreB = scoreMap[b.title.slice(0, 20)] || 0;
      return scoreB - scoreA;
    });

  } catch(e) {
    console.error('naver datalab error:', e.message);
    return festivals;
  }
}

exports.handler = async (event) => {
  const corsHeaders = { 'Content-Type': 'application/json' };
  const params = event.queryStringParameters || {};
  const sidoCode = params.sido || '';    // lDongRegnCd (예: 11=서울)
  const sigunguCode = params.sigungu || ''; // lDongSignguCd (예: 170=용산구)
  const serviceKey = process.env.PUBLIC_DATA_API_KEY;

  if (!sidoCode || !serviceKey) {
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ festivals: [], count: 0 }) };
  }

  const today = getDateStr(0);
  const twoWeeksLater = getDateStr(14);

  try {
    // 시군구 코드가 있으면 구 단위로 좁혀서 조회, 없으면 시도 단위
    let url = `https://apis.data.go.kr/B551011/KorService2/searchFestival2?` +
      `numOfRows=10&pageNo=1&MobileOS=WEB&MobileApp=lumi&_type=json&arrange=R` +
      `&eventStartDate=${today}&eventEndDate=${twoWeeksLater}` +
      `&serviceKey=${encodeURIComponent(serviceKey)}` +
      `&lDongRegnCd=${sidoCode}`;

    if (sigunguCode) url += `&lDongSignguCd=${sigunguCode}`;

    const result = await httpsGet(url);
    if (result.status !== 200) {
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ festivals: [], count: 0 }) };
    }

    const data = JSON.parse(result.body);
    const items = data?.response?.body?.items?.item;

    // 구 단위로 결과 없으면 시도 단위로 fallback
    let list = [];
    if (!items && sigunguCode) {
      const fallbackUrl = `https://apis.data.go.kr/B551011/KorService2/searchFestival2?` +
        `numOfRows=10&pageNo=1&MobileOS=WEB&MobileApp=lumi&_type=json&arrange=R` +
        `&eventStartDate=${today}&eventEndDate=${twoWeeksLater}` +
        `&serviceKey=${encodeURIComponent(serviceKey)}` +
        `&lDongRegnCd=${sidoCode}`;
      const fallbackResult = await httpsGet(fallbackUrl);
      const fallbackData = JSON.parse(fallbackResult.body);
      const fallbackItems = fallbackData?.response?.body?.items?.item;
      if (fallbackItems) {
        list = Array.isArray(fallbackItems) ? fallbackItems : [fallbackItems];
      }
    } else if (items) {
      list = Array.isArray(items) ? items : [items];
    }

    if (list.length === 0) {
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ festivals: [], count: 0 }) };
    }

    let festivals = list.map(item => ({
      title: item.title || '',
      startDate: item.eventstartdate || '',
      endDate: item.eventenddate || '',
      addr: item.addr1 || '',
    }));

    // 네이버 데이터랩 인기도 순 정렬 후 상위 3개
    festivals = await rankByNaverTrend(festivals);
    festivals = festivals.slice(0, 3);

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ festivals, count: festivals.length })
    };

  } catch(e) {
    console.error('get-festival error:', e.message);
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ festivals: [], count: 0 }) };
  }
};
