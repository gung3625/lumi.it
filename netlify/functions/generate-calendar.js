const { getStore } = require('@netlify/blobs');
const https = require('https');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
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
    req.setTimeout(30000, () => { req.destroy(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// 업종 → 트렌드 카테고리 매핑
const BIZ_TO_TREND = {
  '카페': 'cafe', '음식점': 'food', '베이커리': 'cafe',
  '미용실': 'beauty', '네일샵': 'beauty', '피부관리': 'beauty',
  '꽃집': 'other', '옷가게': 'other', '헬스장': 'other', '기타': 'other'
};

// 지역명 → 시도코드 매핑 (축제 API용)
const REGION_TO_SIDO = {
  '서울': '11', '부산': '21', '대구': '22', '인천': '23',
  '광주': '24', '대전': '25', '울산': '26', '세종': '36',
  '경기': '31', '강원': '32', '충북': '33', '충남': '34',
  '전북': '37', '전남': '35', '경북': '38', '경남': '39', '제주': '50'
};

// 지역명 → 시도 날씨 코드 매핑
const REGION_TO_WEATHER = {
  '서울': '서울', '부산': '부산', '대구': '대구', '인천': '인천',
  '광주': '광주', '대전': '대전', '울산': '울산', '세종': '세종',
  '경기': '경기', '강원': '강원', '충북': '충북', '충남': '충남',
  '전북': '전북', '전남': '전남', '경북': '경북', '경남': '경남', '제주': '제주'
};

function extractSido(region) {
  for (const key of Object.keys(REGION_TO_SIDO)) {
    if (region.includes(key)) return key;
  }
  return '서울';
}

function getClientIp(event) {
  return event.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || event.headers['client-ip']
    || 'unknown';
}

async function checkRateLimit(ip, increment = true) {
  try {
    const store = getStore({
      name: 'calendar-rate',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN
    });

    const today = new Date().toISOString().slice(0, 10);
    const key = `rate:${ip}:${today}`;
    const raw = await store.get(key);
    const count = raw ? parseInt(raw, 10) : 0;

    if (count >= 3) return { allowed: false, remaining: 0, store, key, count };

    if (increment) await store.set(key, String(count + 1));
    return { allowed: true, remaining: 2 - count, store, key, count };
  } catch (e) {
    console.error('Rate limit check error:', e.message);
    return { allowed: true, remaining: 0, store: null, key: null, count: 0 };
  }
}

async function fetchTrends(category) {
  try {
    const siteUrl = process.env.URL || 'https://lumi.it.kr';
    const result = await httpsGet(`${siteUrl}/.netlify/functions/get-trends?category=${category}`);
    if (result.status === 200) {
      const data = JSON.parse(result.body);
      return data.tags || [];
    }
  } catch (e) {
    console.error('fetchTrends error:', e.message);
  }
  return [];
}

async function fetchFestivals(sidoCode) {
  try {
    const siteUrl = process.env.URL || 'https://lumi.it.kr';
    const result = await httpsGet(`${siteUrl}/.netlify/functions/get-festival?sido=${sidoCode}`);
    if (result.status === 200) {
      const data = JSON.parse(result.body);
      return data.festivals || [];
    }
  } catch (e) {
    console.error('fetchFestivals error:', e.message);
  }
  return [];
}

async function fetchWeather(sido, lat, lon) {
  try {
    const siteUrl = process.env.URL || 'https://lumi.it.kr';
    let url = `${siteUrl}/.netlify/functions/get-weather-kma?sido=${encodeURIComponent(sido)}`;
    if (lat && lon) {
      url = `${siteUrl}/.netlify/functions/get-weather-kma?lat=${lat}&lon=${lon}`;
    }
    const result = await httpsGet(url);
    if (result.status === 200) {
      return JSON.parse(result.body);
    }
  } catch (e) {
    console.error('fetchWeather error:', e.message);
  }
  return null;
}

function buildWeatherDesc(weather) {
  if (!weather || weather.error) return '날씨 정보 없음';
  const stateMap = { clear: '맑음', rain: '비', snow: '눈' };
  const state = stateMap[weather.state] || '맑음';
  const temp = weather.temperature !== null ? `${weather.temperature}°C` : '';
  const humidity = weather.humidity ? `습도 ${weather.humidity}%` : '';
  return [state, temp, humidity].filter(Boolean).join(', ');
}

async function generateWithGPT(bizCategory, region, weatherDesc, trends, festivals) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) throw new Error('OpenAI API 키가 설정되지 않았습니다.');

  const today = new Date();
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }

  const festivalText = festivals.length > 0
    ? festivals.map(f => `- ${f.title} (${f.startDate}~${f.endDate}, ${f.addr})`).join('\n')
    : '예정된 행사 없음';

  const trendText = trends.length > 0 ? trends.join(', ') : '트렌드 데이터 없음';

  const systemPrompt = `당신은 소상공인 인스타그램 마케팅 전문가입니다. 다음 정보를 바탕으로 향후 7일간의 콘텐츠 캘린더를 JSON으로 작성하세요.

- 업종: ${bizCategory}
- 지역: ${region}
- 현재 날씨: ${weatherDesc}
- 트렌드 키워드: ${trendText}
- 지역 축제/행사: ${festivalText}
- 날짜 범위: ${dates[0]} ~ ${dates[6]}

각 날짜에 대해 다음을 제안하세요:
1. 촬영 주제 (topic) - 구체적이고 실행 가능한 주제
2. 촬영 팁 (shootingTip) - 앵글, 소품, 조명 등 실질적 팁
3. 추천 캡션 톤 (captionTone) - 예: "따뜻하고 친근한 톤", "재치 있는 말장난"
4. 추천 해시태그 5개 (hashtags) - 배열 형태
5. 관련 행사 (relatedEvent) - 있으면 행사명, 없으면 빈 문자열

반드시 아래 JSON 형식으로만 응답하세요. 설명 없이 JSON만 출력하세요:
[
  {
    "date": "YYYY-MM-DD",
    "topic": "...",
    "shootingTip": "...",
    "captionTone": "...",
    "hashtags": ["#...", "#...", "#...", "#...", "#..."],
    "relatedEvent": ""
  }
]`;

  const result = await httpsPost(
    'api.openai.com',
    '/v1/chat/completions',
    {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openaiKey}`
    },
    {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${bizCategory} 업종, ${region} 지역의 7일 인스타그램 콘텐츠 캘린더를 만들어주세요.` }
      ],
      temperature: 0.8,
      max_tokens: 2000
    }
  );

  if (result.status !== 200) {
    console.error('OpenAI API error:', result.status, result.body.substring(0, 300));
    throw new Error('AI 캘린더 생성에 실패했습니다.');
  }

  const data = JSON.parse(result.body);
  const content = data.choices?.[0]?.message?.content || '';

  // JSON 파싱 (코드블록 제거)
  const jsonStr = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const calendar = JSON.parse(jsonStr);

  if (!Array.isArray(calendar) || calendar.length === 0) {
    throw new Error('AI 응답 형식이 올바르지 않습니다.');
  }

  return calendar;
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    // 요청 파싱
    const body = JSON.parse(event.body || '{}');
    const { bizCategory, region, lat, lon } = body;

    if (!bizCategory || !region) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: '업종과 지역을 입력해주세요.' })
      };
    }

    // Rate limit 체크 (GPT 성공 후 카운트 증가)
    const ip = getClientIp(event);
    const rateCheck = await checkRateLimit(ip, false);
    if (!rateCheck.allowed) {
      return {
        statusCode: 429,
        headers: corsHeaders,
        body: JSON.stringify({ error: '오늘 생성 횟수(3회)를 모두 사용했어요. 내일 다시 시도해주세요.' })
      };
    }

    // 데이터 수집 (병렬)
    const sido = extractSido(region);
    const sidoCode = REGION_TO_SIDO[sido] || '11';
    const trendCategory = BIZ_TO_TREND[bizCategory] || 'other';
    const weatherSido = REGION_TO_WEATHER[sido] || '서울';

    const [trends, festivals, weather] = await Promise.all([
      fetchTrends(trendCategory),
      fetchFestivals(sidoCode),
      fetchWeather(weatherSido, lat || null, lon || null)
    ]);

    const weatherDesc = buildWeatherDesc(weather);

    // GPT로 캘린더 생성
    const calendar = await generateWithGPT(bizCategory, region, weatherDesc, trends, festivals);

    // 성공 후에만 rate limit 카운트 증가
    if (rateCheck.store && rateCheck.key) {
      try { await rateCheck.store.set(rateCheck.key, String(rateCheck.count + 1)); } catch {}
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        calendar,
        meta: {
          bizCategory,
          region,
          weather: weatherDesc,
          trendsCount: trends.length,
          festivalsCount: festivals.length,
          remaining: rateCheck.remaining
        }
      })
    };

  } catch (e) {
    console.error('generate-calendar error:', e.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: '캘린더 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' })
    };
  }
};
