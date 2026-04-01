const https = require('https');

// 시도명 → 에어코리아 sidoName 매핑
const SIDO_MAP = {
  '서울': '서울',
  '부산': '부산',
  '대구': '대구',
  '인천': '인천',
  '광주': '광주',
  '대전': '대전',
  '울산': '울산',
  '경기': '경기',
  '강원': '강원',
  '충북': '충북',
  '충남': '충남',
  '전북': '전북',
  '전남': '전남',
  '경북': '경북',
  '경남': '경남',
  '제주': '제주',
  '세종': '세종'
};

// PM10 등급
function getPm10Grade(value) {
  if (value === null || value === undefined || value === '-') return { grade: '알수없음', color: '#999', emoji: '❓' };
  const v = parseInt(value);
  if (v <= 30)  return { grade: '좋음',   color: '#4CAF50', emoji: '😊' };
  if (v <= 80)  return { grade: '보통',   color: '#2196F3', emoji: '🙂' };
  if (v <= 150) return { grade: '나쁨',   color: '#FF9800', emoji: '😷' };
  return             { grade: '매우나쁨', color: '#F44336', emoji: '🚨' };
}

// PM2.5 등급
function getPm25Grade(value) {
  if (value === null || value === undefined || value === '-') return { grade: '알수없음', color: '#999', emoji: '❓' };
  const v = parseInt(value);
  if (v <= 15)  return { grade: '좋음',   color: '#4CAF50', emoji: '😊' };
  if (v <= 35)  return { grade: '보통',   color: '#2196F3', emoji: '🙂' };
  if (v <= 75)  return { grade: '나쁨',   color: '#FF9800', emoji: '😷' };
  return             { grade: '매우나쁨', color: '#F44336', emoji: '🚨' };
}

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

exports.handler = async (event) => {
  const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  const sido = event.queryStringParameters?.sido || '서울';
  const sidoName = SIDO_MAP[sido] || '서울';
  const serviceKey = process.env.PUBLIC_DATA_API_KEY;

  if (!serviceKey) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'API 키 없음' }) };
  }

  try {
    const url = `https://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getCtprvnRltmMesureDnsty?serviceKey=${encodeURIComponent(serviceKey)}&returnType=json&numOfRows=1&pageNo=1&sidoName=${encodeURIComponent(sidoName)}&ver=1.0`;

    const result = await httpsGet(url);

    if (result.status !== 200) {
      throw new Error('API 호출 실패: ' + result.status);
    }

    const data = JSON.parse(result.body);
    const items = data?.response?.body?.items;

    if (!items || items.length === 0) {
      throw new Error('데이터 없음');
    }

    const item = items[0];
    const pm10Value = item.pm10Value;
    const pm25Value = item.pm25Value;
    const pm10Grade = getPm10Grade(pm10Value);
    const pm25Grade = getPm25Grade(pm25Value);

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        sido: sidoName,
        pm10: { value: pm10Value, ...pm10Grade },
        pm25: { value: pm25Value, ...pm25Grade },
        dataTime: item.dataTime || ''
      })
    };
  } catch(e) {
    console.error('get-air-quality error:', e.message);
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        sido: sidoName,
        pm10: { value: '-', grade: '알수없음', color: '#999', emoji: '❓' },
        pm25: { value: '-', grade: '알수없음', color: '#999', emoji: '❓' },
        error: e.message
      })
    };
  }
};
