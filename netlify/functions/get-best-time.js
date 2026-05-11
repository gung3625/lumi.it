const { corsHeaders, getOrigin } = require('./_shared/auth');
// 업종별 인스타그램 최적 게시 시간 (3-tier 하이브리드)
// - Tier 1a: Meta online_followers + 최근 게시물 reach (계정 성숙 시)
// - Tier 1b: 본인 게시 이력 posted_at 최빈 시간 (3건 이상)
// - Tier 3: 업종 × 요일 시드 매트릭스 (외부 리서치 수치 기반)
// Bearer 토큰 검증 + 이상치 필터(06~23시)
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');

// 업종 × 요일 시드 매트릭스 (평일=0, 주말=1)
// 근거: 국내 SNS 벤치마크 리서치 경향 종합. 고객 데이터 쌓이면 자동 대체됨.
const INDUSTRY_MATRIX = {
  cafe: {
    weekday: [{ time: '07:30', reason: '출근길 모닝커피 탐색' }, { time: '12:00', reason: '점심시간 카페 검색' }, { time: '19:30', reason: '퇴근 후 카페 탐방' }],
    weekend: [{ time: '10:00', reason: '주말 아침 브런치 탐색' }, { time: '14:00', reason: '주말 오후 카페 피크' }, { time: '16:30', reason: '주말 디저트 타임' }],
    tip: '주말 오전 10~12시 인게이지먼트가 평일 대비 1.3배 높아요.',
  },
  restaurant: {
    weekday: [{ time: '11:30', reason: '점심 메뉴 탐색' }, { time: '17:30', reason: '저녁 식당 검색 피크' }, { time: '20:00', reason: '식후 야식 검색' }],
    weekend: [{ time: '12:00', reason: '주말 점심 맛집 탐색' }, { time: '18:00', reason: '주말 저녁 외식' }, { time: '20:30', reason: '2차 장소 탐색' }],
    tip: '음식 사진은 게시 후 1시간 내 저장 수가 많아요 — 식사 직전 업로드가 유리해요.',
  },
  beauty: {
    weekday: [{ time: '11:00', reason: '오전 여유 뷰티 탐색' }, { time: '19:00', reason: '퇴근 후 예약 문의 집중' }, { time: '21:00', reason: '밤 뷰티 콘텐츠 소비 피크' }],
    weekend: [{ time: '13:00', reason: '주말 셀프케어 준비' }, { time: '20:00', reason: '주말 밤 뷰티 영감 탐색' }, { time: '21:30', reason: '내일 준비 콘텐츠 저장' }],
    tip: '화요일~목요일 21시 전후 문의 전환률이 가장 높아요.',
  },
  nail: {
    weekday: [{ time: '11:00', reason: '오전 네일 디자인 탐색' }, { time: '19:00', reason: '퇴근 후 예약 문의' }, { time: '21:00', reason: '밤 디자인 저장 피크' }],
    weekend: [{ time: '13:00', reason: '주말 셀프 탐색' }, { time: '19:30', reason: '다음주 예약 탐색' }, { time: '21:30', reason: '디자인 영감 저장' }],
    tip: '주중 21시 게시가 다음날 오전 DM 문의로 이어지는 경우가 많아요.',
  },
  flower: {
    weekday: [{ time: '10:00', reason: '기념일 선물 탐색' }, { time: '15:00', reason: '퇴근 전 픽업 결심 시각' }, { time: '19:00', reason: '저녁 감성 꽃 탐색' }],
    weekend: [{ time: '11:00', reason: '주말 오전 여유 탐색' }, { time: '14:30', reason: '주말 오후 방문 피크' }, { time: '17:00', reason: '주말 저녁 선물 결제' }],
    tip: '금요일 10~15시 게시가 주말 매출과 가장 상관관계가 높아요.',
  },
  clothing: {
    weekday: [{ time: '12:30', reason: '점심시간 쇼핑 탐색' }, { time: '20:00', reason: '퇴근 후 저녁 쇼핑 피크' }, { time: '22:00', reason: '밤 코디 영감 저장' }],
    weekend: [{ time: '13:00', reason: '주말 오후 쇼핑' }, { time: '19:00', reason: '주말 저녁 OOTD' }, { time: '21:30', reason: '다음주 준비 저장' }],
    tip: '리퀘스트 DM은 22시 전후 게시물에서 가장 많이 발생해요.',
  },
  gym: {
    weekday: [{ time: '07:00', reason: '모닝 운동 루틴 탐색' }, { time: '12:00', reason: '점심시간 운동 다짐' }, { time: '20:30', reason: '저녁 오운완 피크' }],
    weekend: [{ time: '10:00', reason: '주말 아침 운동 시작' }, { time: '14:00', reason: '주말 오후 클래스 탐색' }],
    tip: '#오운완 해시태그는 평일 저녁 8~9시가 노출량 최대예요.',
  },
  other: {
    weekday: [{ time: '09:00', reason: '오전 활동 시작' }, { time: '12:30', reason: '점심시간 SNS 탐색' }, { time: '19:00', reason: '저녁 여가 시간' }],
    weekend: [{ time: '11:00', reason: '주말 오전 여유' }, { time: '14:00', reason: '주말 오후 피크' }, { time: '20:00', reason: '주말 저녁 여가' }],
    tip: '일주일 3~5회 꾸준한 업로드 주기가 알고리즘에 가장 유리해요.',
  },
};

function normalizeCategory(cat) {
  if (!cat) return 'other';
  const key = String(cat).toLowerCase();
  if (INDUSTRY_MATRIX[key]) return key;
  // 한글/별칭 매핑
  if (/카페|coffee/.test(key)) return 'cafe';
  if (/음식|식당|food|restaurant|한식|양식|중식|일식/.test(key)) return 'restaurant';
  if (/뷰티|미용|beauty|salon/.test(key)) return 'beauty';
  if (/네일|nail/.test(key)) return 'nail';
  if (/플라워|꽃|flower/.test(key)) return 'flower';
  if (/의류|옷|패션|clothing|fashion/.test(key)) return 'clothing';
  if (/운동|헬스|필라테스|요가|gym|pilates|yoga|fitness|크로스핏|crossfit/.test(key)) return 'gym';
  return 'other';
}

// 요일별 슬롯 선택
function getSeedSlot(category) {
  const data = INDUSTRY_MATRIX[category] || INDUSTRY_MATRIX.other;
  const day = new Date().getDay();
  const isWeekend = day === 0 || day === 6;
  const slots = isWeekend ? data.weekend : data.weekday;

  // 현재 시각 이후 가장 가까운 슬롯 선택 (오늘 게시 가능)
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const withMinutes = slots.map((s) => {
    const [hh, mm] = s.time.split(':').map(Number);
    return { ...s, minutes: hh * 60 + mm };
  });
  const upcoming = withMinutes.find((s) => s.minutes > nowMinutes + 30);
  const picked = upcoming || withMinutes[0];

  return {
    time: picked.time,
    reason: picked.reason,
    tip: data.tip,
    allSlots: slots,
    // insights.html 의 요일 탭 (data-day="weekday"/"weekend") 이 직접 읽는 키.
    // Tier 1/2 에서도 시드 fallback 으로 함께 반환 — 개인화는 단일 bestTime 에만,
    // 요일별 상세는 업종 시드를 보여주는 게 현재 데이터로는 가장 정확.
    weekday: data.weekday,
    weekend: data.weekend,
  };
}

// Meta online_followers 메트릭 호출 → 시간대별 팔로워 수 맵 반환
// 반환값: { '07': 12, '19': 45, ... } 또는 null (데이터 없음)
async function fetchOnlineFollowers(igUserId, accessToken) {
  try {
    const url = `https://graph.facebook.com/v25.0/${igUserId}/insights?metric=online_followers&period=lifetime&access_token=${accessToken}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.data || !data.data[0]?.values) return null;

    // 최근 7일치 values 합산해 시간대별 평균
    const hourSums = {};
    const hourCounts = {};
    for (const v of data.data[0].values) {
      const value = v.value || {};
      for (const [hour, count] of Object.entries(value)) {
        const h = String(hour).padStart(2, '0');
        hourSums[h] = (hourSums[h] || 0) + Number(count);
        hourCounts[h] = (hourCounts[h] || 0) + 1;
      }
    }
    const avg = {};
    for (const h of Object.keys(hourSums)) {
      avg[h] = hourSums[h] / hourCounts[h];
    }
    return Object.keys(avg).length ? avg : null;
  } catch (e) {
    console.warn('[get-best-time] online_followers 조회 실패:', e.message);
    return null;
  }
}

// 이상치 필터: 06~23시만 허용 + 최대값 hour 반환
// followerMap: UTC 기준 시간 → KST로 변환 (UTC+9)
function pickPeakHour(followerMap) {
  if (!followerMap) return null;
  let bestHour = null;
  let bestValue = 0;
  for (const [hourStr, value] of Object.entries(followerMap)) {
    const utcHour = Number(hourStr);
    if (Number.isNaN(utcHour)) continue;
    const kstHour = (utcHour + 9) % 24;
    if (kstHour < 6 || kstHour > 23) continue;
    if (value > bestValue) {
      bestValue = value;
      bestHour = kstHour;
    }
  }
  if (bestHour === null) return null;
  return { hour: bestHour, value: bestValue };
}

// 본인 이력 기반 최빈 시간 계산
function calcBestFromHistory(history) {
  if (!Array.isArray(history) || history.length < 3) return null;
  const buckets = {};
  for (const row of history) {
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
    if (count > bestCount) { bestCount = count; bestKey = key; }
  }
  if (!bestKey) return null;
  return { time: bestKey, sampleSize: history.length, count: bestCount };
}


exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  if (!token) return { statusCode: 401, headers: headers, body: JSON.stringify({ error: '로그인이 필요합니다.' }) };
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    console.warn('[get-best-time] 토큰 검증 실패');
    return { statusCode: 401, headers: headers, body: JSON.stringify({ error: '인증에 실패했습니다.' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: '잘못된 요청' }) };
  }
  const cat = normalizeCategory(body.category);

  const seed = getSeedSlot(cat);

  try {
    const supabase = getAdminClient();

    // Tier 1a: Meta online_followers (IG 연동 시만)
    const { data: igRow } = await supabase
      .from('ig_accounts_decrypted')
      .select('ig_user_id, access_token, page_access_token')
      .eq('user_id', user.id)
      .maybeSingle();

    if (igRow && igRow.ig_user_id) {
      const followerMap = await fetchOnlineFollowers(igRow.ig_user_id, igRow.page_access_token || igRow.access_token);
      const peak = pickPeakHour(followerMap);
      if (peak) {
        const hh = String(peak.hour).padStart(2, '0');
        return {
          statusCode: 200,
          headers: headers,
          body: JSON.stringify({
            category: cat,
            bestTime: `${hh}:00`,
            reason: `내 팔로워가 가장 많이 접속하는 시간대`,
            tip: seed.tip,
            allSlots: seed.allSlots,
            weekday: seed.weekday,
            weekend: seed.weekend,
            source: 'meta-online-followers',
          }),
        };
      }
    }

    // Tier 1b: 본인 게시 이력 최빈 시간
    const { data: history } = await supabase
      .from('reservations')
      .select('posted_at')
      .eq('user_id', user.id)
      .eq('caption_status', 'posted')
      .order('posted_at', { ascending: false })
      .limit(200);

    const fromHistory = calcBestFromHistory(history);
    if (fromHistory) {
      return {
        statusCode: 200,
        headers: headers,
        body: JSON.stringify({
          category: cat,
          bestTime: fromHistory.time,
          reason: `내 계정 이력 기준 ${fromHistory.count}회 게시 시간대`,
          tip: seed.tip,
          allSlots: seed.allSlots,
          weekday: seed.weekday,
          weekend: seed.weekend,
          source: 'user-history',
          sampleSize: fromHistory.sampleSize,
        }),
      };
    }
  } catch (err) {
    console.error('[get-best-time] 조회 오류:', err.message);
  }

  // Tier 3: 업종 시드 매트릭스
  return {
    statusCode: 200,
    headers: headers,
    body: JSON.stringify({
      category: cat,
      bestTime: seed.time,
      reason: seed.reason,
      tip: seed.tip,
      allSlots: seed.allSlots,
      weekday: seed.weekday,
      weekend: seed.weekend,
      source: 'industry-seed',
    }),
  };
};

// 외부 호출용 export
module.exports.getSeedSlot = getSeedSlot;
module.exports.normalizeCategory = normalizeCategory;
module.exports.INDUSTRY_MATRIX = INDUSTRY_MATRIX;
