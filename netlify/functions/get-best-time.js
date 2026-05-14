const { corsHeaders, getOrigin } = require('./_shared/auth');
// 업종별 인스타그램 최적 게시 시간 — 팔로워 활동 기반 추천 (PR #237 재구성).
//
// 본질: 베스트 시간 = 팔로워가 IG 접속해서 내 게시물을 보는 시간.
//       사장님이 *언제 올렸는지* 자체는 신호 아님.
//
// 데이터 소스 우선순위:
//   Tier 1a: Meta online_followers  (시간별 팔로워 접속 평균, IG 연동 즉시)
//            → 요일 분리 없음 — 평일/주말 동일 3 peak 슬롯
//            → 직접 신호. lumi 의 기본 데이터 소스.
//   Tier 2:  follower_activity_snapshots  (요일별 매트릭스, 28일 누적)
//            → 더 정확 — 요일별 분리. 누적되면 Tier 1a 덮어씀.
//   Tier 4:  업종 × 요일 시드             (둘 다 미달 시 fallback)
//
// 옛 Tier 1 (seller_post_history.reach 가중치) 는 폐기 — 간접 신호로 우회하던 단계.
// 사장님 통찰: \"내가 어느 시간에 자주 올리는지가 왜 필요한가\" → 직접 신호로 통합.
//
// 응답 필드:
//   bestTime, reason, tip, allSlots, weekday, weekend, source
//   modes          — { weekday: 'personal'|'seed', weekend: 'personal'|'seed' }
//   progress       — { weekday: {have, need, ready}, weekend, ready }
//                    have=1 일 때 1단계 (online_followers) 활성
//                    progress.ready = Tier 2 양쪽 ready (28일 누적 완료)
//   sources        — { weekday: 'online_followers'|'tier2'|'seed', weekend }
//   tier2_progress — { weekday: {snapshot_days, needed_days, ready}, weekend }
//
// source 값:
//   'personal-followers-activity'  Tier 2 양쪽 ready
//   'personal-mixed'               Tier 2 한쪽만 ready
//   'personal-online-followers'    Tier 1a 활성
//   'industry-seed'                전부 시드
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { kstHourDow, utcHourToKstHour } = require('./_shared/kst-utils');
const {
  ACTIVITY_WINDOW_DAYS,
  ACTIVITY_THRESHOLDS,
} = require('./_shared/best-time-constants');

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

// 현재 시각 이후(+30분 마진) 가장 가까운 슬롯 → 오늘 게시 가능한 추천 시간 1개
function pickUpcoming(slots) {
  if (!Array.isArray(slots) || !slots.length) return null;
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const withMinutes = slots
    .filter((s) => s && typeof s.time === 'string')
    .map((s) => {
      const [hh, mm] = s.time.split(':').map(Number);
      return { ...s, minutes: hh * 60 + mm };
    });
  return withMinutes.find((s) => s.minutes > nowMinutes + 30) || withMinutes[0] || null;
}

// 요일별 슬롯 + 오늘 추천 슬롯 1개 — send-daily-schedule 등 외부 호출용으로도 유지
function getSeedSlot(category) {
  const data = INDUSTRY_MATRIX[category] || INDUSTRY_MATRIX.other;
  const day = new Date().getDay();
  const isWeekend = day === 0 || day === 6;
  const slots = isWeekend ? data.weekend : data.weekday;
  const picked = pickUpcoming(slots) || slots[0];
  return {
    time: picked.time,
    reason: picked.reason,
    tip: data.tip,
    allSlots: slots,
    weekday: data.weekday,
    weekend: data.weekend,
  };
}

// Meta online_followers — 시간대별 팔로워 수 평균 맵
async function fetchOnlineFollowers(igUserId, accessToken) {
  try {
    const url = `https://graph.facebook.com/v25.0/${igUserId}/insights?metric=online_followers&period=lifetime&access_token=${accessToken}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.data || !data.data[0]?.values) return null;
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
    for (const h of Object.keys(hourSums)) avg[h] = hourSums[h] / hourCounts[h];
    return Object.keys(avg).length ? avg : null;
  } catch (e) {
    console.warn('[get-best-time] online_followers 조회 실패:', e.message);
    return null;
  }
}

// 이상치 필터: KST 06~23시 만 허용 + 최대값 hour 반환 (단일)
function pickPeakHour(followerMap) {
  if (!followerMap) return null;
  let bestHour = null;
  let bestValue = 0;
  for (const [hourStr, value] of Object.entries(followerMap)) {
    const utcHour = Number(hourStr);
    if (Number.isNaN(utcHour)) continue;
    const kstHour = utcHourToKstHour(utcHour);
    if (kstHour < 6 || kstHour > 23) continue;
    if (value > bestValue) {
      bestValue = value;
      bestHour = kstHour;
    }
  }
  if (bestHour === null) return null;
  return { hour: bestHour, value: bestValue };
}

// online_followers 에서 상위 N개 peak hour 추출 → { time, reason } 슬롯 배열.
// Tier 1a 슬롯 채움용 — 사장님 게시 reach 우회 없이 *직접 신호* (팔로워 접속 시각).
function pickTopHoursFromOnlineFollowers(followerMap, n = 3) {
  if (!followerMap) return [];
  const entries = [];
  for (const [hourStr, value] of Object.entries(followerMap)) {
    const utcHour = Number(hourStr);
    if (Number.isNaN(utcHour)) continue;
    const kstHour = utcHourToKstHour(utcHour);
    if (kstHour < 6 || kstHour > 23) continue;
    if (!(value > 0)) continue;
    entries.push({ kstHour, value });
  }
  entries.sort((a, b) => b.value - a.value);
  return entries.slice(0, n).map((e, i) => ({
    time: `${String(e.kstHour).padStart(2, '0')}:00`,
    reason: `내 팔로워가 가장 많이 접속하는 시간 ${i + 1}위`,
  }));
}

// follower_activity_snapshots → 요일군별 hour × 평균 follower_count 매트릭스.
// 임계값 충족 시 top3 hour 슬롯 반환 (00분 단위). 미달은 null.
function computeActivitySlots(snapshots) {
  const buckets = { weekday: {}, weekend: {} };       // hour → [count, ...]
  const dayKeys = { weekday: new Set(), weekend: new Set() };
  for (const r of (snapshots || [])) {
    if (typeof r.hour !== 'number' || r.hour < 6 || r.hour > 23) continue;
    const dow = r.day_of_week;
    if (typeof dow !== 'number') continue;
    const grp = (dow === 0 || dow === 6) ? 'weekend' : 'weekday';
    const bucket = buckets[grp];
    if (!bucket[r.hour]) bucket[r.hour] = [];
    bucket[r.hour].push(Number(r.follower_count) || 0);
    if (r.snapshot_date) dayKeys[grp].add(r.snapshot_date);
  }
  function pickTop(bucket) {
    const avgs = Object.entries(bucket)
      .map(([h, arr]) => {
        const sum = arr.reduce((a, b) => a + b, 0);
        return { hour: Number(h), avg: sum / arr.length, samples: arr.length };
      })
      .filter((x) => x.avg > 0)
      .sort((a, b) => b.avg - a.avg);
    return avgs.slice(0, 3).map((x, i) => ({
      time: `${String(x.hour).padStart(2, '0')}:00`,
      reason: `내 팔로워 활동 ${i + 1}위 시간대 (평균 ${Math.round(x.avg)}명 접속)`,
    }));
  }
  const weekdayReady = dayKeys.weekday.size >= ACTIVITY_THRESHOLDS.weekday;
  const weekendReady = dayKeys.weekend.size >= ACTIVITY_THRESHOLDS.weekend;
  return {
    weekday: weekdayReady ? pickTop(buckets.weekday) : null,
    weekend: weekendReady ? pickTop(buckets.weekend) : null,
    counts: { weekday: dayKeys.weekday.size, weekend: dayKeys.weekend.size },
  };
}

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: '로그인이 필요합니다.' }) };
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    console.warn('[get-best-time] 토큰 검증 실패');
    return { statusCode: 401, headers, body: JSON.stringify({ error: '인증에 실패했습니다.' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '잘못된 요청' }) };
  }
  const cat = normalizeCategory(body.category);
  const seed = getSeedSlot(cat);
  const isWeekendToday = (() => { const d = new Date().getDay(); return d === 0 || d === 6; })();

  // 응답 기본값 — 시드. progress 는 새 구조 (PR #237): 1단계 = online_followers 활성,
  // 2단계 = follower_activity_snapshots 누적. weekday/weekend.have/need 는 옛 frontend
  // 호환성 유지용 — have=1 일 때 1단계 ready 로 카드 색 변환.
  const result = {
    category: cat,
    bestTime: seed.time,
    reason: seed.reason,
    tip: seed.tip,
    allSlots: seed.allSlots,
    weekday: seed.weekday,
    weekend: seed.weekend,
    source: 'industry-seed',
    modes: { weekday: 'seed', weekend: 'seed' },
    progress: {
      weekday: { have: 0, need: 1, ready: false },
      weekend: { have: 0, need: 1, ready: false },
      ready: false,
    },
  };

  try {
    const supabase = getAdminClient();

    // ── Tier 1a: Meta online_followers → 3 peak hour 슬롯 ─────────────
    //   사장님 게시 시간대(옛 Tier 1)는 *간접 신호* 라 폐기. 베스트 시간 = 팔로워가
    //   실제 접속해서 보는 시간. online_followers 가 *직접 신호* 라 IG 연동 즉시 사용.
    //   요일 정보 없는 단일 시간 분포 → 평일·주말 동일 슬롯 (Tier 2 매트릭스 가 누적
    //   되면 요일별로 분기).
    const sources = { weekday: 'seed', weekend: 'seed' };
    let onlineFollowersReady = false;
    let igConnected = false;
    try {
      const { data: igRow } = await supabase
        .from('ig_accounts_decrypted')
        .select('ig_user_id, access_token, page_access_token')
        .eq('user_id', user.id)
        .maybeSingle();
      igConnected = !!(igRow && igRow.ig_user_id);
      if (igRow && igRow.ig_user_id) {
        const followerMap = await fetchOnlineFollowers(
          igRow.ig_user_id,
          igRow.page_access_token || igRow.access_token,
        );
        const topSlots = pickTopHoursFromOnlineFollowers(followerMap, 3);
        if (topSlots.length) {
          // 평일·주말 동일 (요일 분리는 Tier 2 가 채움)
          result.weekday = topSlots;
          result.weekend = topSlots;
          result.modes.weekday = 'personal';
          result.modes.weekend = 'personal';
          sources.weekday = 'online_followers';
          sources.weekend = 'online_followers';
          result.source = 'personal-online-followers';
          onlineFollowersReady = true;
        }
      }
    } catch (e) {
      console.warn('[get-best-time] online_followers 호출 경고:', e && e.message);
    }

    // Tier 1a 활성 시 오늘 슬롯 + bestTime 갱신.
    result.allSlots = isWeekendToday ? result.weekend : result.weekday;
    if (onlineFollowersReady) {
      const picked = pickUpcoming(result.allSlots);
      if (picked) {
        result.bestTime = picked.time;
        result.reason = picked.reason;
      }
    }

    // ── Tier 2: follower_activity_snapshots → 요일별 매트릭스 (28일 누적) ──
    //   Tier 1a 보다 더 정확 — 요일별 분리 + 28일 평균. 누적되면 덮어씀.
    const activitySince = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 3600 * 1000)
      .toISOString().slice(0, 10);
    const { data: snapshots } = await supabase
      .from('follower_activity_snapshots')
      .select('snapshot_date, hour, day_of_week, follower_count')
      .eq('user_id', user.id)
      .gte('snapshot_date', activitySince)
      .limit(2000);
    const activity = computeActivitySlots(snapshots || []);
    if (activity.weekday) {
      result.weekday = activity.weekday;
      result.modes.weekday = 'personal';
      sources.weekday = 'tier2';
    }
    if (activity.weekend) {
      result.weekend = activity.weekend;
      result.modes.weekend = 'personal';
      sources.weekend = 'tier2';
    }
    if (activity.weekday || activity.weekend) {
      result.source = (sources.weekday === 'tier2' && sources.weekend === 'tier2')
        ? 'personal-followers-activity'
        : 'personal-mixed';
    }

    // progress 응답 — 1단계 = online_followers 활성, 2단계 = 28일 누적 follower 활동.
    // 옛 weekday/weekend.have/need 구조 유지 (frontend 카드 진척 막대 호환).
    // online_followers 는 요일 분리 없음 → 활성 시 weekday/weekend 둘 다 1/1 채움.
    result.progress = {
      weekday: { have: onlineFollowersReady ? 1 : 0, need: 1, ready: onlineFollowersReady },
      weekend: { have: onlineFollowersReady ? 1 : 0, need: 1, ready: onlineFollowersReady },
      ready: !!(activity.weekday && activity.weekend),
    };
    result.tier2_progress = {
      weekday: { snapshot_days: activity.counts.weekday, needed_days: ACTIVITY_THRESHOLDS.weekday, ready: !!activity.weekday },
      weekend: { snapshot_days: activity.counts.weekend, needed_days: ACTIVITY_THRESHOLDS.weekend, ready: !!activity.weekend },
    };
    result.sources = sources;
    // dashboard 가 "IG 연동 필요" vs "데이터 수집 중" 분기 위해 노출.
    // ig_connected=true 인데 progress.weekday.ready=false 면 = IG 는 연동됐는데
    // online_followers 데이터 누적 대기 중 (재연동 직후 24~48시간).
    result.ig_connected = igConnected;

    // Tier 2 가 슬롯 갈아끼웠을 수 있으니 오늘 기준 재계산.
    result.allSlots = isWeekendToday ? result.weekend : result.weekday;
    if (result.modes[isWeekendToday ? 'weekend' : 'weekday'] === 'personal') {
      const picked = pickUpcoming(result.allSlots);
      if (picked) {
        result.bestTime = picked.time;
        result.reason = picked.reason;
      }
    }
  } catch (err) {
    console.error('[get-best-time] 조회 오류:', err.message);
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(result),
  };
};

// 외부 호출용 export
module.exports.getSeedSlot = getSeedSlot;
module.exports.normalizeCategory = normalizeCategory;
module.exports.INDUSTRY_MATRIX = INDUSTRY_MATRIX;
