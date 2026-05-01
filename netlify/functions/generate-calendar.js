// 7일 인스타 캘린더 생성 — Supabase 기반 (Blobs 완전 제거)
// - 비로그인 사용자: IP 기반 rate_limits (kind='calendar', 1일 3회)
// - 로그인 사용자: Bearer 토큰 검증 → reservations 테이블에 post_mode='scheduled' 로 저장
//   (전용 calendar 테이블이 없으므로 reservations.reserve_key 에 'cal:{user_id}' 저장)
const https = require('https');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { checkAndIncrementQuota, QuotaExceededError } = require('./_shared/openai-quota');


function httpsGet(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
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

const REGION_TO_SIDO = {
  '서울': '11', '부산': '21', '대구': '22', '인천': '23',
  '광주': '24', '대전': '25', '울산': '26', '세종': '36',
  '경기': '31', '강원': '32', '충북': '33', '충남': '34',
  '전북': '37', '전남': '35', '경북': '38', '경남': '39', '제주': '50'
};

const SIDO_GRID = {
  '서울': { nx: 60, ny: 127 }, '부산': { nx: 98, ny: 76 },
  '대구': { nx: 89, ny: 90 },  '인천': { nx: 55, ny: 124 },
  '광주': { nx: 58, ny: 74 },  '대전': { nx: 67, ny: 100 },
  '울산': { nx: 102, ny: 84 }, '세종': { nx: 66, ny: 103 },
  '경기': { nx: 60, ny: 120 }, '강원': { nx: 73, ny: 134 },
  '충북': { nx: 69, ny: 107 }, '충남': { nx: 68, ny: 100 },
  '전북': { nx: 63, ny: 89 },  '전남': { nx: 51, ny: 67 },
  '경북': { nx: 91, ny: 106 }, '경남': { nx: 91, ny: 77 },
  '제주': { nx: 52, ny: 38 }
};

const SIDO_TO_MID_LAND = {
  '서울': '11B00000', '인천': '11B00000', '경기': '11B00000',
  '강원': '11D10000',
  '대전': '11C20000', '세종': '11C20000', '충남': '11C20000',
  '충북': '11C10000',
  '광주': '11F20000', '전남': '11F20000',
  '전북': '11F10000',
  '대구': '11H10000', '경북': '11H10000',
  '부산': '11H20000', '울산': '11H20000', '경남': '11H20000',
  '제주': '11G00000'
};

const SIDO_TO_MID_TA = {
  '서울': '11B10101', '인천': '11B20201', '경기': '11B20601',
  '강원': '11D10301',
  '대전': '11C20401', '세종': '11C20404', '충남': '11C20101',
  '충북': '11C10301',
  '광주': '11F20501', '전남': '11F20501',
  '전북': '11F10201',
  '대구': '11H10701', '경북': '11H10201',
  '부산': '11H20201', '울산': '11H20101', '경남': '11H20301',
  '제주': '11G00201'
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
    || event.headers['x-nf-client-connection-ip']
    || 'unknown';
}

// 비로그인 IP rate limit: 하루 3회 (rate_limits 테이블)
async function checkCalendarRateLimit(supabase, ip, increment = true) {
  const kind = 'calendar';
  const nowIso = new Date().toISOString();
  const windowMs = 24 * 60 * 60 * 1000;

  try {
    const { data: existing } = await supabase
      .from('rate_limits')
      .select('count, first_at')
      .eq('kind', kind)
      .eq('ip', ip)
      .maybeSingle();

    const age = existing ? (Date.now() - new Date(existing.first_at).getTime()) : null;

    // 창이 만료되었거나 행이 없음 → 신규 집계
    if (!existing || age > windowMs) {
      if (increment) {
        if (existing) {
          await supabase.from('rate_limits')
            .update({ count: 1, first_at: nowIso, last_at: nowIso })
            .eq('kind', kind).eq('ip', ip);
        } else {
          await supabase.from('rate_limits').insert({ kind, ip, count: 1, first_at: nowIso, last_at: nowIso });
        }
      }
      return { allowed: true, remaining: 2, currentCount: increment ? 1 : 0 };
    }

    if (existing.count >= 3) {
      return { allowed: false, remaining: 0, currentCount: existing.count };
    }

    if (increment) {
      await supabase.from('rate_limits')
        .update({ count: existing.count + 1, last_at: nowIso })
        .eq('kind', kind).eq('ip', ip);
    }
    return { allowed: true, remaining: Math.max(0, 2 - existing.count), currentCount: existing.count + (increment ? 1 : 0) };
  } catch (e) {
    console.error('[generate-calendar] rate limit 오류:', e.message);
    return { allowed: true, remaining: 0, currentCount: 0 };
  }
}

async function fetchTrends(category) {
  try {
    const siteUrl = process.env.URL || 'https://lumi.it.kr';
    const result = await httpsGet(`${siteUrl}/.netlify/functions/get-trends?category=${category}`, 5000);
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
    const result = await httpsGet(`${siteUrl}/.netlify/functions/get-festival?sido=${sidoCode}`, 5000);
    if (result.status === 200) {
      const data = JSON.parse(result.body);
      return data.festivals || [];
    }
  } catch (e) {
    console.error('fetchFestivals error:', e.message);
  }
  return [];
}

function getKstDateStr(offsetDays = 0) {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  kst.setUTCDate(kst.getUTCDate() + offsetDays);
  return kst.toISOString().slice(0, 10).replace(/-/g, '');
}

function getVilageFcstBaseTime() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const hh = kst.getUTCHours();
  const mm = kst.getUTCMinutes();
  const baseTimes = [23, 20, 17, 14, 11, 8, 5, 2];
  let baseHour = 2;
  for (const bt of baseTimes) {
    if (hh > bt || (hh === bt && mm >= 10)) { baseHour = bt; break; }
  }
  let baseDate = getKstDateStr(0);
  if (baseHour === 23 && hh < 23) baseDate = getKstDateStr(-1);
  return { baseDate, baseTime: String(baseHour).padStart(2, '0') + '00' };
}

function getMidTmFc() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const hh = kst.getUTCHours();
  const dateStr = getKstDateStr(hh < 6 ? -1 : 0);
  const timeStr = hh >= 18 ? '1800' : '0600';
  return dateStr + timeStr;
}

async function fetchShortForecast(sido) {
  const serviceKey = process.env.PUBLIC_DATA_API_KEY;
  if (!serviceKey) return {};

  const grid = SIDO_GRID[sido] || SIDO_GRID['서울'];
  const { baseDate, baseTime } = getVilageFcstBaseTime();

  try {
    const url = `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst`
      + `?serviceKey=${serviceKey}&numOfRows=290&pageNo=1&dataType=JSON`
      + `&base_date=${baseDate}&base_time=${baseTime}&nx=${grid.nx}&ny=${grid.ny}`;

    const result = await httpsGet(url, 5000);
    if (result.status !== 200) return {};

    const data = JSON.parse(result.body);
    const items = data?.response?.body?.items?.item || [];

    const byDate = {};
    for (const item of items) {
      const d = item.fcstDate;
      if (!byDate[d]) byDate[d] = {};
      if (item.category === 'TMN') byDate[d].min = Math.round(parseFloat(item.fcstValue));
      if (item.category === 'TMX') byDate[d].max = Math.round(parseFloat(item.fcstValue));
      if (item.category === 'SKY' && item.fcstTime === '1200') byDate[d].sky = item.fcstValue;
      if (item.category === 'PTY' && item.fcstTime === '1200') byDate[d].pty = item.fcstValue;
    }

    const result7 = {};
    for (const [date, v] of Object.entries(byDate)) {
      const isoDate = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;
      const sky = v.sky === '1' ? '맑음' : v.sky === '3' ? '구름많음' : v.sky === '4' ? '흐림' : '';
      const pty = parseInt(v.pty || '0');
      const weather = pty === 1 || pty === 4 ? '비' : pty === 2 ? '비/눈' : pty === 3 ? '눈' : sky;
      const temp = (v.min != null && v.max != null) ? `${v.min}~${v.max}°C` : '';
      result7[isoDate] = [weather, temp].filter(Boolean).join(', ') || '정보없음';
    }
    return result7;
  } catch (e) {
    console.error('fetchShortForecast error:', e.message);
    return {};
  }
}

async function fetchMidForecast(sido) {
  const serviceKey = process.env.PUBLIC_DATA_API_KEY;
  if (!serviceKey) return {};

  const landRegId = SIDO_TO_MID_LAND[sido] || '11B00000';
  const taRegId = SIDO_TO_MID_TA[sido] || '11B10101';
  const tmFc = getMidTmFc();

  try {
    const [landResult, taResult] = await Promise.all([
      httpsGet(`https://apis.data.go.kr/1360000/MidFcstInfoService/getMidLandFcst`
        + `?serviceKey=${serviceKey}&numOfRows=10&pageNo=1&dataType=JSON&regId=${landRegId}&tmFc=${tmFc}`, 5000),
      httpsGet(`https://apis.data.go.kr/1360000/MidFcstInfoService/getMidTa`
        + `?serviceKey=${serviceKey}&numOfRows=10&pageNo=1&dataType=JSON&regId=${taRegId}&tmFc=${tmFc}`, 5000)
    ]);

    const landData = landResult.status === 200 ? JSON.parse(landResult.body) : null;
    const taData = taResult.status === 200 ? JSON.parse(taResult.body) : null;

    const landItem = landData?.response?.body?.items?.item?.[0] || {};
    const taItem = taData?.response?.body?.items?.item?.[0] || {};

    const result7 = {};
    for (let d = 3; d <= 7; d++) {
      const date = new Date();
      date.setDate(date.getDate() + d);
      const isoDate = date.toISOString().slice(0, 10);

      const weather = landItem[`wf${d}Am`] || landItem[`wf${d}`] || '';
      const min = taItem[`taMin${d}`];
      const max = taItem[`taMax${d}`];
      const temp = (min != null && max != null) ? `${min}~${max}°C` : '';
      result7[isoDate] = [weather, temp].filter(Boolean).join(', ') || '정보없음';
    }
    return result7;
  } catch (e) {
    console.error('fetchMidForecast error:', e.message);
    return {};
  }
}

async function fetch7DayWeather(sido) {
  const [shortFc, midFc] = await Promise.all([
    fetchShortForecast(sido),
    fetchMidForecast(sido)
  ]);
  return { ...shortFc, ...midFc };
}

async function generateWithGPT(bizCategory, region, weatherByDate, trends, festivals) {
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

  const weatherLines = dates.map(d => `  ${d}: ${weatherByDate[d] || '정보없음'}`).join('\n');

  const systemPrompt = `당신은 소상공인 인스타그램 마케팅 전문가입니다. 다음 정보를 바탕으로 향후 7일간의 콘텐츠 캘린더를 JSON으로 작성하세요.

- 업종: ${bizCategory}
- 지역: ${region}
- 7일간 날씨 예보:
${weatherLines}
- 트렌드 키워드: ${trendText}
- 지역 축제/행사: ${festivalText}
- 날짜 범위: ${dates[0]} ~ ${dates[6]}

날씨에 맞는 촬영 주제와 팁을 제안하세요. 비 오는 날은 실내 촬영, 맑은 날은 야외/자연광 활용 등.

각 날짜에 대해 다음을 제안하세요:
1. 촬영 주제 (topic) - 구체적이고 실행 가능한 주제
2. 촬영 팁 (shootingTip) - 앵글, 소품, 조명 등 실질적 팁
3. 추천 캡션 톤 (captionTone) - 예: "따뜻하고 친근한 톤", "재치 있는 말장난"
4. 관련 행사 (relatedEvent) - 있으면 행사명, 없으면 빈 문자열

반드시 아래 JSON 형식으로만 응답하세요. 설명 없이 JSON만 출력하세요:
[
  {
    "date": "YYYY-MM-DD",
    "topic": "...",
    "shootingTip": "...",
    "captionTone": "...",
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
    throw new Error('캘린더 생성에 실패했습니다.');
  }

  const data = JSON.parse(result.body);
  const content = data.choices?.[0]?.message?.content || '';

  let jsonStr = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const arrMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (!arrMatch) throw new Error('캘린더 데이터를 찾을 수 없습니다.');
  const calendar = JSON.parse(arrMatch[0]);

  if (!Array.isArray(calendar) || calendar.length === 0) {
    throw new Error('응답 형식이 올바르지 않습니다.');
  }

  return calendar;
}

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { bizCategory, region } = body;

    if (!bizCategory || !region) {
      return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify({ error: '업종과 지역을 입력해주세요.' })
      };
    }

    const supabase = getAdminClient();

    // 로그인 사용자 확인 (선택적)
    let userId = null;
    const token = extractBearerToken(event);
    if (token) {
      const { user } = await verifyBearerToken(token);
      if (user) userId = user.id;
    }

    // 비로그인: Rate limit 체크 (GPT 성공 후 카운트 증가)
    let rateCheck = { allowed: true, remaining: 0, currentCount: 0 };
    if (!userId) {
      const ip = getClientIp(event);
      rateCheck = await checkCalendarRateLimit(supabase, ip, false);
      if (!rateCheck.allowed) {
        return {
          statusCode: 429,
          headers: headers,
          body: JSON.stringify({ error: '오늘 생성 횟수(3회)를 모두 사용했어요. 내일 다시 시도해주세요.' })
        };
      }
    }

    // 데이터 수집 (병렬)
    const sido = extractSido(region);
    const sidoCode = REGION_TO_SIDO[sido] || '11';
    const trendCategory = BIZ_TO_TREND[bizCategory] || 'other';

    const [trends, festivals, weatherByDate] = await Promise.all([
      fetchTrends(trendCategory),
      fetchFestivals(sidoCode),
      fetch7DayWeather(sido)
    ]);

    // Quota 검증 (gpt-4o-mini ₩5/호출)
    try {
      await checkAndIncrementQuota(userId || null, 'gpt-4o-mini');
    } catch (e) {
      if (e instanceof QuotaExceededError) {
        return { statusCode: 429, headers: headers, body: JSON.stringify({ error: e.message }) };
      }
      throw e;
    }

    // GPT로 캘린더 생성
    const calendar = await generateWithGPT(bizCategory, region, weatherByDate, trends, festivals);

    // 로그인 사용자: reservations 에 post_mode='scheduled' 로 저장 (reserve_key='cal:{user_id}' 단건 유지)
    if (userId) {
      try {
        const reserveKey = 'cal:' + userId;
        const payload = {
          reserve_key: reserveKey,
          user_id: userId,
          biz_category: bizCategory,
          post_mode: 'scheduled',
          weather: weatherByDate,
          trends: { keywords: trends, festivals },
          store_profile: { region, calendar },
          caption_status: 'pending',
          is_sent: false,
          cancelled: false,
          submitted_at: new Date().toISOString(),
          scheduled_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        };
        const { error: upsertErr } = await supabase
          .from('reservations')
          .upsert(payload, { onConflict: 'reserve_key' });
        if (upsertErr) {
          console.error('[generate-calendar] 캘린더 저장 실패:', upsertErr.message);
        }
      } catch (e) {
        console.error('[generate-calendar] 저장 오류:', e.message);
      }
    }

    // 비로그인: 성공 후에만 rate limit 카운트 증가
    if (!userId) {
      const ip = getClientIp(event);
      await checkCalendarRateLimit(supabase, ip, true);
    }

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({
        calendar,
        meta: {
          bizCategory,
          region,
          weather: weatherByDate,
          trendsCount: trends.length,
          festivalsCount: festivals.length,
          remaining: userId ? null : Math.max(0, rateCheck.remaining - 1),
          saved: !!userId
        }
      })
    };

  } catch (e) {
    console.error('generate-calendar error:', e.message);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: '캘린더 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' })
    };
  }
};
