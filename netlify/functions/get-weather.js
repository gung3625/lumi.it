// 사장님 매장 지역 날씨 — Open-Meteo (key 불필요, 무료)
// GET /api/get-weather
// 헤더: Authorization: Bearer <jwt>
//
// 응답:
//   region 미설정:   { ok: true, noRegion: true }
//   정상:            { ok: true, sido, shortName, temperature, status, emoji, mood }
//   외부 API 실패:   { ok: true, error: "fetch_failed" | "api_error" }
//   인증 실패:       { ok: false, error: "..." } (401)
//
// 동작:
//  1) sellers.region 조회 (예: "서울특별시 용산구")
//  2) 시·도 추출 → SIDO_COORDS 매핑 (17개 광역시도 중심 좌표 인라인)
//  3) Open-Meteo current weather 호출
//  4) WMO weather code → 한국어 상태 + emoji + 짧은 mood 메시지

'use strict';

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { getAdminClient } = require('./_shared/supabase-admin');

// 17개 광역시도 중심 좌표 — 날씨는 시·도 단위면 충분 (사장님 region 의 구·군까지 따로 호출 X)
const SIDO_COORDS = {
  '서울특별시': { lat: 37.5665, lng: 126.9780, short: '서울' },
  '부산광역시': { lat: 35.1796, lng: 129.0756, short: '부산' },
  '인천광역시': { lat: 37.4563, lng: 126.7052, short: '인천' },
  '대구광역시': { lat: 35.8714, lng: 128.6014, short: '대구' },
  '광주광역시': { lat: 35.1595, lng: 126.8526, short: '광주' },
  '대전광역시': { lat: 36.3504, lng: 127.3845, short: '대전' },
  '울산광역시': { lat: 35.5384, lng: 129.3114, short: '울산' },
  '세종특별자치시': { lat: 36.4801, lng: 127.2890, short: '세종' },
  '경기도':         { lat: 37.4138, lng: 127.5183, short: '경기' },
  '강원특별자치도': { lat: 37.8228, lng: 128.1555, short: '강원' },
  '충청북도':       { lat: 36.6357, lng: 127.4910, short: '충북' },
  '충청남도':       { lat: 36.5184, lng: 126.8000, short: '충남' },
  '전북특별자치도': { lat: 35.7175, lng: 127.1530, short: '전북' },
  '전라남도':       { lat: 34.8679, lng: 126.9910, short: '전남' },
  '경상북도':       { lat: 36.4919, lng: 128.8889, short: '경북' },
  '경상남도':       { lat: 35.4606, lng: 128.2132, short: '경남' },
  '제주특별자치도': { lat: 33.4996, lng: 126.5312, short: '제주' },
};

// WMO weather code → { status, emoji, mood }
// (Open-Meteo 공식 WMO 코드 표 기반)
function wmoMap(code, temp) {
  const t = Number.isFinite(temp) ? temp : 15;
  if (code === 0) return { status: '맑음', emoji: '☀️', mood: t >= 15 ? '야외 사진 찍기 좋은 날이에요' : '햇살 좋지만 쌀쌀해요' };
  if (code === 1 || code === 2) return { status: '대체로 맑음', emoji: '🌤️', mood: '구도 좋은 사진 노려볼 만한 날' };
  if (code === 3) return { status: '흐림', emoji: '☁️', mood: '차분한 톤 사진 어울려요' };
  if (code === 45 || code === 48) return { status: '안개', emoji: '🌫️', mood: '감성 사진에 좋은 날' };
  if (code >= 51 && code <= 57) return { status: '이슬비', emoji: '🌦️', mood: '실내 분위기 살리기 좋은 날' };
  if (code >= 61 && code <= 67) return { status: '비', emoji: '🌧️', mood: '실내 따뜻한 메뉴 사진 어때요?' };
  if (code >= 71 && code <= 77) return { status: '눈', emoji: '🌨️', mood: '겨울 감성 사진 어울리는 날' };
  if (code >= 80 && code <= 82) return { status: '소나기', emoji: '🌦️', mood: '갑자기 비 — 실내 사진 추천' };
  if (code === 85 || code === 86) return { status: '눈 소나기', emoji: '🌨️', mood: '실내 따뜻함이 그리워지는 날' };
  if (code >= 95 && code <= 99) return { status: '천둥번개', emoji: '⛈️', mood: '실내에서 안전하게' };
  return { status: '맑음', emoji: '🌤️', mood: '오늘도 좋은 하루' };
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user || !user.id) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: '인증이 필요합니다.' }) };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[get-weather] admin 초기화 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: '서버 오류' }) };
  }

  const { data: seller } = await admin
    .from('sellers')
    .select('region')
    .eq('id', user.id)
    .maybeSingle();

  const region = (seller && seller.region || '').trim();
  let coords = null;
  for (const sido of Object.keys(SIDO_COORDS)) {
    if (region.startsWith(sido)) {
      coords = { sido, ...SIDO_COORDS[sido] };
      break;
    }
  }
  if (!coords) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, noRegion: true }) };
  }

  // Open-Meteo current weather
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lng}&current=temperature_2m,weather_code&timezone=Asia%2FSeoul`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 8000);
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } catch (e) {
    clearTimeout(tid);
    console.warn('[get-weather] fetch 실패:', e && e.message);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, error: 'fetch_failed' }) };
  }
  clearTimeout(tid);
  if (!res.ok) {
    console.warn('[get-weather] API status:', res.status);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, error: 'api_error' }) };
  }
  const data = await res.json().catch(() => ({}));
  const current = (data && data.current) || {};
  const temp = Math.round(Number(current.temperature_2m));
  const w = wmoMap(Number(current.weather_code), temp);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      sido: coords.sido,
      shortName: coords.short,
      temperature: Number.isFinite(temp) ? temp : null,
      status: w.status,
      emoji: w.emoji,
      mood: w.mood,
    }),
  };
};
