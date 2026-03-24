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

// 두 좌표 간 거리 계산 (km, Haversine)
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// 시군구 코드 → 대표 좌표 매핑
const SIGUNGU_COORDS = {
  // 서울
  '11_110': [37.5729, 126.9793], '11_140': [37.5638, 126.9975], '11_170': [37.5384, 126.9654],
  '11_200': [37.5633, 127.0369], '11_215': [37.5385, 127.0823], '11_230': [37.5744, 127.0399],
  '11_260': [37.5969, 127.0951], '11_290': [37.6066, 127.0176], '11_305': [37.6396, 127.0257],
  '11_320': [37.6688, 127.0470], '11_350': [37.6543, 127.0568], '11_380': [37.6027, 126.9283],
  '11_410': [37.5792, 126.9368], '11_440': [37.5663, 126.9014], '11_470': [37.5270, 126.8557],
  '11_500': [37.5509, 126.8495], '11_530': [37.4953, 126.8874], '11_545': [37.4564, 126.8954],
  '11_560': [37.5264, 126.8962], '11_590': [37.5124, 126.9395], '11_620': [37.4784, 126.9516],
  '11_650': [37.4835, 127.0323], '11_680': [37.5172, 127.0473], '11_710': [37.5145, 127.1059],
  '11_740': [37.5492, 127.1463],
  // 경기
  '31_110': [37.2636, 127.0286], '31_130': [37.4196, 127.1266], '31_280': [37.6561, 126.8350],
  '31_450': [37.3415, 127.1269], '31_460': [37.7601, 126.7801], '31_520': [37.6154, 126.7161],
  '31_540': [37.4296, 127.2559],
  // 부산
  '21_110': [35.1028, 129.0323], '21_350': [35.1631, 129.1638],
  // 대구
  '22_110': [35.8703, 128.5911],
  // 인천
  '23_110': [37.4563, 126.7052],
  // 광주
  '24_110': [35.1595, 126.8526],
  // 대전
  '25_110': [36.3504, 127.3845],
  // 울산
  '26_110': [35.5384, 129.3114],
};

// 시도 대표 좌표 (시군구 없을 때 fallback)
const SIDO_COORDS = {
  '11': [37.5665, 126.9780], '21': [35.1796, 129.0756], '22': [35.8722, 128.6025],
  '23': [37.4563, 126.7052], '24': [35.1595, 126.8526], '25': [36.3504, 127.3845],
  '26': [35.5384, 129.3114], '36': [36.4800, 127.2890], '31': [37.4138, 127.5183],
  '32': [37.8228, 128.1555], '33': [36.6357, 127.4913], '34': [36.6588, 126.6728],
  '37': [35.8202, 127.1089], '35': [34.8161, 126.4630], '38': [36.4919, 128.8889],
  '39': [35.4606, 128.2132], '50': [33.4996, 126.5312],
};

// 네이버 데이터랩으로 행사 인기도 순 정렬
async function rankByNaverTrend(festivals) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret || festivals.length <= 1) return festivals;

  const today = new Date();
  const endDate = today.toISOString().slice(0, 10);
  const startDate = new Date(today - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

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

    const scoreMap = {};
    data.results.forEach(r => {
      const avg = r.data.length > 0
        ? r.data.reduce((s, d) => s + d.ratio, 0) / r.data.length : 0;
      scoreMap[r.title] = avg;
    });

    return [...festivals].sort((a, b) => {
      const scoreA = scoreMap[a.title.slice(0, 20)] || 0;
      const scoreB = scoreMap[b.title.slice(0, 20)] || 0;
      return scoreB - scoreA;
    });
  } catch(e) {
    return festivals;
  }
}

exports.handler = async (event) => {
  const corsHeaders = { 'Content-Type': 'application/json' };
  const params = event.queryStringParameters || {};
  const sidoCode = params.sido || '';
  const sigunguCode = params.sigungu || '';
  const serviceKey = process.env.PUBLIC_DATA_API_KEY;

  if (!sidoCode || !serviceKey) {
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ festivals: [], count: 0 }) };
  }

  // 기준 좌표 결정 (시군구 → 시도 순)
  const coordKey = `${sidoCode}_${sigunguCode}`;
  const baseCoord = SIGUNGU_COORDS[coordKey] || SIDO_COORDS[sidoCode] || [37.5665, 126.9780];
  const [baseLat, baseLon] = baseCoord;

  const today = getDateStr(0);
  const twoWeeksLater = getDateStr(14);

  try {
    // 더 많이 가져와서 거리 필터링
    let url = `https://apis.data.go.kr/B551011/KorService2/searchFestival2?` +
      `numOfRows=20&pageNo=1&MobileOS=WEB&MobileApp=lumi&_type=json&arrange=R` +
      `&eventStartDate=${today}&eventEndDate=${twoWeeksLater}` +
      `&serviceKey=${encodeURIComponent(serviceKey)}` +
      `&lDongRegnCd=${sidoCode}`;

    if (sigunguCode) url += `&lDongSignguCd=${sigunguCode}`;

    const result = await httpsGet(url);
    if (result.status !== 200) {
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ festivals: [], count: 0 }) };
    }

    const data = JSON.parse(result.body);
    let items = data?.response?.body?.items?.item;

    // 구 단위 결과 없으면 시도 단위 fallback
    if (!items && sigunguCode) {
      const fallbackUrl = `https://apis.data.go.kr/B551011/KorService2/searchFestival2?` +
        `numOfRows=20&pageNo=1&MobileOS=WEB&MobileApp=lumi&_type=json&arrange=R` +
        `&eventStartDate=${today}&eventEndDate=${twoWeeksLater}` +
        `&serviceKey=${encodeURIComponent(serviceKey)}` +
        `&lDongRegnCd=${sidoCode}`;
      const fallbackResult = await httpsGet(fallbackUrl);
      const fallbackData = JSON.parse(fallbackResult.body);
      items = fallbackData?.response?.body?.items?.item;
    }

    if (!items) {
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ festivals: [], count: 0 }) };
    }

    const list = Array.isArray(items) ? items : [items];

    // 좌표 있는 행사만 거리 계산, 10km 이내 필터링
    let festivals = list
      .map(item => {
        const lat = parseFloat(item.mapy);
        const lon = parseFloat(item.mapx);
        const dist = (lat && lon) ? getDistance(baseLat, baseLon, lat, lon) : 999;
        return {
          title: item.title || '',
          startDate: item.eventstartdate || '',
          endDate: item.eventenddate || '',
          addr: item.addr1 || '',
          dist: Math.round(dist * 10) / 10
        };
      })
      .filter(f => f.dist <= 10);

    // 네이버 인기도 정렬 후 상위 3개
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
