// weather.js — 기상청 단기예보 (무료, OpenWeather fallback)
// Tier 0, 캐싱 1시간
//
// 베타 단계에서는 OpenWeatherMap free tier 사용 (월 1000 호출)
// process.env.OPENWEATHER_API_KEY 필요. 없으면 mock 응답.

const { makeCacheKey, getCached, setCached } = require('../llm-cache');

const SEOUL = { lat: 37.5665, lon: 126.9780 };

async function getWeather({ city = '서울' } = {}) {
  const cacheKey = makeCacheKey({ kind: 'weather', input: city, tier: 0 });
  const cached = await getCached(cacheKey);
  if (cached) return { ...cached, cached: true };

  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      city,
      summary: '날씨 API 키가 아직 설정되지 않아 정확한 정보는 곧 제공돼요',
      mock: true,
    };
  }

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${SEOUL.lat}&lon=${SEOUL.lon}&appid=${apiKey}&units=metric&lang=kr`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`weather api ${res.status}`);
    const data = await res.json();
    const result = {
      ok: true,
      city,
      temp: Math.round(data.main?.temp ?? 0),
      feels_like: Math.round(data.main?.feels_like ?? 0),
      humidity: data.main?.humidity ?? 0,
      desc: data.weather?.[0]?.description || '',
      summary: `${city} 지금 ${Math.round(data.main?.temp ?? 0)}도 · ${data.weather?.[0]?.description || ''} · 습도 ${data.main?.humidity ?? 0}%`,
    };
    await setCached(cacheKey, result, { kind: 'weather', tier: 0 });
    return result;
  } catch (e) {
    return { ok: false, city, summary: '날씨를 잠시 불러오지 못했어요. 잠시 후 다시 시도해 주세요' };
  }
}

module.exports = { getWeather };
