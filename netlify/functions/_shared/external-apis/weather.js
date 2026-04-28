// weather.js — 기상청 초단기실황 (PUBLIC_DATA_API_KEY 재사용)
// Tier 0, 캐싱 1시간
//
// 루미는 이미 PUBLIC_DATA_API_KEY로 기상청 단기실황 사용 중 (get-weather-kma.js).
// 본 모듈은 채팅 명령("날씨", "오늘 날씨") 진입점에서 동일 API 재사용.

const { makeCacheKey, getCached, setCached } = require('../llm-cache');

// 서울 격자 좌표 (기상청 단기예보 격자)
const SEOUL_GRID = { nx: 60, ny: 127 };

// 초단기실황 baseTime — 매시 30분 생성, 40분 이후 조회 가능
function calcBaseTime() {
  const now = new Date();
  const minute = now.getMinutes();
  const useThisHour = minute >= 40;
  const ref = useThisHour ? now : new Date(now.getTime() - 60 * 60 * 1000);
  const yyyy = ref.getFullYear();
  const mm = String(ref.getMonth() + 1).padStart(2, '0');
  const dd = String(ref.getDate()).padStart(2, '0');
  const hh = String(ref.getHours()).padStart(2, '0');
  return { baseDate: `${yyyy}${mm}${dd}`, baseTime: `${hh}00` };
}

function describeSky(sky, pty) {
  const ptyMap = { '0': null, '1': '비', '2': '비/눈', '3': '눈', '4': '소나기', '5': '빗방울', '6': '빗방울눈날림', '7': '눈날림' };
  const skyMap = { '1': '맑음', '3': '구름많음', '4': '흐림' };
  return ptyMap[String(pty)] || skyMap[String(sky)] || '';
}

async function getWeather({ city = '서울' } = {}) {
  const cacheKey = makeCacheKey({ kind: 'weather', input: city, tier: 0 });
  const cached = await getCached(cacheKey);
  if (cached) return { ...cached, cached: true };

  const serviceKey = process.env.PUBLIC_DATA_API_KEY;
  if (!serviceKey) {
    return {
      ok: false,
      city,
      summary: '날씨 정보를 잠시 불러오지 못했어요',
      reason: 'no_key',
    };
  }

  try {
    const { baseDate, baseTime } = calcBaseTime();
    const { nx, ny } = SEOUL_GRID;
    const url = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst'
      + `?serviceKey=${serviceKey}&numOfRows=10&pageNo=1&dataType=JSON`
      + `&base_date=${baseDate}&base_time=${baseTime}&nx=${nx}&ny=${ny}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`kma ${res.status}`);
    const data = await res.json();
    const items = data?.response?.body?.items?.item || [];
    const map = {};
    for (const it of items) map[it.category] = it.obsrValue;

    const temp = Number(map.T1H);
    const humidity = Number(map.REH);
    const rainMm = Number(map.RN1) || 0;
    const sky = map.SKY;
    const pty = map.PTY;
    const desc = describeSky(sky, pty) || (rainMm > 0 ? '비' : '');

    const result = {
      ok: true,
      city,
      temp: Math.round(temp),
      humidity,
      rain_mm: rainMm,
      desc,
      summary: `${city} 지금 ${Math.round(temp)}도 · ${desc || '관측'} · 습도 ${humidity}%${rainMm > 0 ? ` · 강수 ${rainMm}mm` : ''}`,
      base_time: `${baseDate} ${baseTime}`,
    };
    await setCached(cacheKey, result, { kind: 'weather', tier: 0 });
    return result;
  } catch (e) {
    return { ok: false, city, summary: '날씨를 잠시 불러오지 못했어요. 잠시 후 다시 시도해 주세요', reason: 'kma_error' };
  }
}

module.exports = { getWeather };
