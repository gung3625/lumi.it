// 업종별 인스타그램 최적 게시 시간 — Supabase 기반
// - Bearer 토큰 검증
// - 유저 예약 이력(posted_at, biz_category)을 Supabase에서 조회해 카테고리별 최적 시간 계산
// - 이력이 부족하면 업종 기본 슬롯(BEST_TIMES)로 폴백
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');

// 업종별 기본 슬롯 (이력 부족 시 폴백)
const BEST_TIMES = {
  cafe: {
    slots: [
      { time: '07:30', reason: '출근 전 모닝커피 탐색 피크' },
      { time: '12:00', reason: '점심시간 카페 검색 집중' },
      { time: '19:30', reason: '퇴근 후 저녁 카페 탐방' }
    ],
    tip: '주말은 10시~12시가 가장 높아요.'
  },
  food: {
    slots: [
      { time: '11:00', reason: '점심 메뉴 탐색 시작' },
      { time: '17:30', reason: '저녁 식당 검색 피크' },
      { time: '20:00', reason: '야식 및 다음날 계획' }
    ],
    tip: '음식 사진은 밝은 낮 시간대 업로드가 반응이 좋아요.'
  },
  beauty: {
    slots: [
      { time: '11:00', reason: '오전 여유 시간 뷰티 탐색' },
      { time: '19:00', reason: '퇴근 후 예약 문의 집중' },
      { time: '21:00', reason: '밤 시간 뷰티 콘텐츠 소비 피크' }
    ],
    tip: '화요일~목요일 저녁 예약 문의가 가장 많아요.'
  },
  other: {
    slots: [
      { time: '09:00', reason: '오전 활동 시작 시간' },
      { time: '12:30', reason: '점심시간 SNS 탐색' },
      { time: '19:00', reason: '저녁 여가 시간' }
    ],
    tip: '꾸준한 업로드 주기가 알고리즘에 가장 유리해요.'
  }
};

// 오늘 요일 기반으로 가장 추천 시간 1개 반환
function getTodayBestSlot(category) {
  const data = BEST_TIMES[category] || BEST_TIMES.other;
  const day = new Date().getDay(); // 0=일, 1=월 ... 6=토

  let slotIndex = 0;
  // 주말은 두 번째 슬롯 (낮 시간대) 추천
  if (day === 0 || day === 6) slotIndex = 1;
  // 평일 저녁은 세 번째 슬롯
  else if (day >= 2 && day <= 4) slotIndex = 2;

  return {
    time: data.slots[slotIndex].time,
    reason: data.slots[slotIndex].reason,
    tip: data.tip,
    allSlots: data.slots,
  };
}

// 유저 이력 기반 최적 시간 계산
// history: [{ posted_at: ISO string, biz_category: 'cafe' }, ...]
// 카테고리 필터 후 시간대(HH:MM 30분 버킷) 빈도 → 최빈 시간 반환
function calcBestFromHistory(history, category) {
  const filtered = category
    ? history.filter(h => (h.biz_category || 'other') === category)
    : history;
  if (filtered.length < 3) return null; // 이력 부족

  const buckets = {}; // 'HH:MM' → count
  for (const row of filtered) {
    if (!row.posted_at) continue;
    const d = new Date(row.posted_at);
    if (isNaN(d.getTime())) continue;
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = d.getMinutes() < 30 ? '00' : '30';
    const key = `${hh}:${mm}`;
    buckets[key] = (buckets[key] || 0) + 1;
  }

  let bestKey = null;
  let bestCount = 0;
  for (const [key, count] of Object.entries(buckets)) {
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }
  if (!bestKey) return null;
  return {
    time: bestKey,
    reason: `내 계정 이력 기준 ${bestCount}회 게시 시간대`,
    sampleSize: filtered.length,
  };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Bearer 토큰 검증
  const token = extractBearerToken(event);
  if (!token) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '로그인이 필요합니다.' }) };
  }
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    console.warn('[get-best-time] 토큰 검증 실패');
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증에 실패했습니다.' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청' }) };
  }
  const cat = body.category || 'other';

  try {
    const supabase = getAdminClient();
    // 유저 예약 이력 조회 (posted 상태만)
    const { data: history, error: histErr } = await supabase
      .from('reservations')
      .select('posted_at, biz_category')
      .eq('user_id', user.id)
      .eq('caption_status', 'posted')
      .order('posted_at', { ascending: false })
      .limit(200);

    if (histErr) {
      console.error('[get-best-time] reservations 조회 오류:', histErr.message);
    }

    const fallback = getTodayBestSlot(cat);
    const fromHistory = Array.isArray(history) ? calcBestFromHistory(history, cat) : null;

    if (fromHistory) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          category: cat,
          bestTime: fromHistory.time,
          reason: fromHistory.reason,
          tip: fallback.tip,
          allSlots: fallback.allSlots,
          source: 'history',
          sampleSize: fromHistory.sampleSize,
        }),
      };
    }

    // 이력 부족 → 카테고리 기본 슬롯
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        category: cat,
        bestTime: fallback.time,
        reason: fallback.reason,
        tip: fallback.tip,
        allSlots: fallback.allSlots,
        source: 'category-default',
        sampleSize: Array.isArray(history) ? history.length : 0,
      }),
    };
  } catch (err) {
    console.error('[get-best-time] error:', err.message);
    // 에러 시 기본 슬롯 반환 (UX 유지)
    const fallback = getTodayBestSlot(cat);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        category: cat,
        bestTime: fallback.time,
        reason: fallback.reason,
        tip: fallback.tip,
        allSlots: fallback.allSlots,
        source: 'category-default',
      }),
    };
  }
};

// 다른 함수에서 직접 import해서 쓸 수 있도록 export
module.exports.getTodayBestSlot = getTodayBestSlot;
module.exports.BEST_TIMES = BEST_TIMES;
