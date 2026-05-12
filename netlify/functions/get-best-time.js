const { corsHeaders, getOrigin } = require('./_shared/auth');
// 업종별 인스타그램 최적 게시 시간 — 2-stage 개인화
//
// 추천의 본질은 "팔로워가 그 시간에 인스타에서 내 게시물을 본다" — 사장님 게시
// 빈도(한가했던 시간)는 신호가 아니므로 명시적으로 제외한다.
//
// 단계:
//   부족 단계: 업종 시드 — "사람들이 많이 볼만한 시간대 평균"
//   누적 완료: 본인 데이터 — "내 팔로워가 내 게시물을 가장 많이 본 시간"
//
// 데이터 소스 우선순위 (누적 완료 단계 안에서):
//   Tier 2:  follower_activity_snapshots  (팔로워 활동 매트릭스, 28일 누적)
//            → 가장 직접적 — 팔로워가 IG 에 있는 시간 자체
//   Tier 1:  seller_post_history.reach    (게시별 도달 가중치)
//            → 결과로 본 "사람들이 본 시간". rowScore = 0.7·log(1+reach) + 0.3·log(1+engagement)
//            → 임계: 도달 데이터(reach 채워진) row 평일 ≥ 5건 / 주말 ≥ 3건
//            → insights cron 이 채워지길 기다림
//   Tier 4:  업종 × 요일 시드 매트릭스    (위 둘 다 미달 시 fallback)
//
// 응답 필드 (기존 호환):
//   bestTime, reason, tip, allSlots, weekday, weekend, source
// 신규 필드 (UI 모드 배지·진행 카드용):
//   modes       — { weekday: 'personal'|'seed', weekend: 'personal'|'seed' }
//   progress    — { weekday: {have, need, ready}, weekend: {...}, ready }
//                  have = 도달 데이터 채워진 게시물 수 (요일군별)
//   sources     — { weekday: 'tier1'|'tier2'|'tier4', weekend: ... }
//   tier2_progress — { weekday: {snapshot_days, needed_days, ready}, weekend: {...} }
//   thresholds  — { weekday: 5, weekend: 3 }   (Tier 1 reach 데이터 기준)
//
// source 값:
//   'meta-online-followers'  Tier 1a 활성 (bestTime 점만 보강, 슬롯은 시드)
//   'personal-followers'     Tier 2 양쪽 ready
//   'personal-mixed'         Tier 2 한쪽만 ready
//   'personal-history-weighted' Tier 1 ready (가중치)
//   'personal-history-partial-weighted' Tier 1 한쪽만 ready
//   'industry-seed'          전부 시드
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { kstHourDow, utcHourToKstHour } = require('./_shared/kst-utils');
const {
  HISTORY_THRESHOLDS,
  HISTORY_WINDOW_DAYS,
  HISTORY_LIMIT,
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

// 임계값/윈도우 상수는 _shared/best-time-constants.js 단일 source of truth.
// (HISTORY_THRESHOLDS = THRESHOLDS 별칭 — 코드 내부 사용처 유지)
const THRESHOLDS = HISTORY_THRESHOLDS;

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

// 이상치 필터: KST 06~23시 만 허용 + 최대값 hour 반환
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

// performance score — reach 1차 + engagement 보조. log(1+x) 로 outlier 완화.
function rowScore(row) {
  const reach = typeof row.reach === 'number' ? row.reach : 0;
  const engagement = typeof row.engagement === 'number' ? row.engagement : 0;
  const r = Math.log(1 + reach);
  const e = Math.log(1 + engagement);
  return 0.7 * r + 0.3 * e + 0.5; // 도달 0건 row 도 최소치 0.5 확보 (시각 분포는 유지)
}

// seller_post_history → 평일/주말 분리 30분 버킷 가중합. KST 변환 + 06~23시 필터.
// 핵심: **reach 채워진 row 만 카운트** — 단순 게시 빈도는 추천 신호가 아니므로 제외.
// 임계값 충족(평일 ≥5건 / 주말 ≥3건) 시 top3 슬롯, 미달 시 시드 fallback.
// insights cron 이 reach 를 채워나가는 동안엔 자연스럽게 시드 유지 → 채워지면 자동 전환.
function computePersonalizedSlots(history, seed) {
  const counts = { weekday: 0, weekend: 0 };          // reach 채워진 row 만 카운트
  const buckets = { weekday: {}, weekend: {} };       // weighted sum — top3 선정용
  const rawCounts = { weekday: {}, weekend: {} };     // raw count — reason 노출용

  for (const row of (history || [])) {
    if (!row || !row.posted_at) continue;
    // reach 미수집 row 는 추천 신호 아님 — 카운트·집계 모두 제외.
    if (typeof row.reach !== 'number') continue;
    const k = kstHourDow(row.posted_at);
    if (!k) continue;
    const { hour: hh, dow, minute } = k;
    if (hh < 6 || hh > 23) continue;
    const mm = minute < 30 ? '00' : '30';
    const key = `${String(hh).padStart(2, '0')}:${mm}`;
    const grp = (dow === 0 || dow === 6) ? 'weekend' : 'weekday';
    buckets[grp][key] = (buckets[grp][key] || 0) + rowScore(row);
    rawCounts[grp][key] = (rawCounts[grp][key] || 0) + 1;
    counts[grp]++;
  }

  function topSlots(bucket, rawBucket) {
    return Object.entries(bucket)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([time], i) => ({
        time,
        reason: `내 팔로워가 가장 많이 본 시각 ${i + 1}위 · ${rawBucket[time] || 0}건 기준`,
      }));
  }

  function fillFromSeed(personal, seedSlots, target = 3) {
    if (personal.length >= target) return personal.slice(0, target);
    const used = new Set(personal.map((s) => s.time));
    const padded = [...personal];
    for (const s of seedSlots || []) {
      if (padded.length >= target) break;
      if (!used.has(s.time)) padded.push({ ...s, reason: `${s.reason} · 업종 평균 보충` });
    }
    return padded;
  }

  const weekdayReady = counts.weekday >= THRESHOLDS.weekday;
  const weekendReady = counts.weekend >= THRESHOLDS.weekend;

  const modes = { weekday: 'seed', weekend: 'seed' };
  let weekday = seed.weekday;
  let weekend = seed.weekend;

  if (weekdayReady) {
    weekday = fillFromSeed(topSlots(buckets.weekday, rawCounts.weekday), seed.weekday);
    modes.weekday = 'personal';
  }
  if (weekendReady) {
    weekend = fillFromSeed(topSlots(buckets.weekend, rawCounts.weekend), seed.weekend);
    modes.weekend = 'personal';
  }

  return {
    weekday,
    weekend,
    modes,
    counts,
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

  // 응답 기본값 — 시드.
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
      weekday: { have: 0, need: THRESHOLDS.weekday, ready: false },
      weekend: { have: 0, need: THRESHOLDS.weekend, ready: false },
      ready: false,
    },
    thresholds: THRESHOLDS,
  };

  try {
    const supabase = getAdminClient();

    // ── Tier 3: seller_post_history 기반 weekday/weekend 슬롯 ─────────────
    const since = new Date(Date.now() - HISTORY_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
    const { data: history, error: histErr } = await supabase
      .from('seller_post_history')
      .select('posted_at, reach, engagement')
      .eq('user_id', user.id)
      .gte('posted_at', since)
      .order('posted_at', { ascending: false })
      .limit(HISTORY_LIMIT);

    if (histErr) {
      console.warn('[get-best-time] seller_post_history 조회 경고:', histErr.message);
    }

    const personalized = computePersonalizedSlots(history || [], seed);
    result.weekday = personalized.weekday;
    result.weekend = personalized.weekend;
    result.modes = personalized.modes;
    result.progress = {
      weekday: {
        have: personalized.counts.weekday,
        need: THRESHOLDS.weekday,
        ready: personalized.modes.weekday === 'personal',
      },
      weekend: {
        have: personalized.counts.weekend,
        need: THRESHOLDS.weekend,
        ready: personalized.modes.weekend === 'personal',
      },
      ready: personalized.modes.weekday === 'personal' && personalized.modes.weekend === 'personal',
    };

    // 오늘 요일 기준 allSlots 갱신 — 대시보드 "오늘 베스트 시간" 위젯이 읽음.
    result.allSlots = isWeekendToday ? result.weekend : result.weekday;

    // 개인화된 슬롯이 있으면 bestTime 도 그 안에서 픽 (시드 bestTime 덮어쓰기).
    if (personalized.modes[isWeekendToday ? 'weekend' : 'weekday'] === 'personal') {
      const picked = pickUpcoming(result.allSlots);
      if (picked) {
        result.bestTime = picked.time;
        result.reason = picked.reason;
      }
    }

    // 슬롯 별 출처 추적 — UI sheet 카피 분기용.
    // personal 이면 항상 tier1 (reach 가중치 — 빈도 tier3 는 더 이상 사용 안 함).
    const sources = {
      weekday: result.modes.weekday === 'personal' ? 'tier1' : 'tier4',
      weekend: result.modes.weekend === 'personal' ? 'tier1' : 'tier4',
    };

    // source 갱신 — 시드 / Tier 1 / Tier 1 부분.
    if (result.progress.ready) {
      result.source = 'personal-history-weighted';
    } else if (result.modes.weekday === 'personal' || result.modes.weekend === 'personal') {
      result.source = 'personal-history-partial-weighted';
    }

    // ── Tier 2: follower_activity_snapshots 기반 매트릭스 ────────────────
    // history 가중치(Tier 1) 보다 우선 — 팔로워 활동 시간 = 외부 도달 신호.
    // 단 요일군별 누적 충족돼야 함 (평일 15일 이상 / 주말 6일 이상).
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
    // progress.ready 도 Tier 2 활성 반영
    result.progress.weekday.ready = result.progress.weekday.ready || !!activity.weekday;
    result.progress.weekend.ready = result.progress.weekend.ready || !!activity.weekend;
    result.progress.ready = result.progress.weekday.ready && result.progress.weekend.ready;
    if (activity.weekday || activity.weekend) {
      result.source = (sources.weekday === 'tier2' && sources.weekend === 'tier2')
        ? 'personal-followers'
        : 'personal-mixed';
    }
    // Tier 2 진척률 응답 — UI(#110)에서 "팔로워 활동 매트릭스 N/21일 누적" 표시용.
    result.tier2_progress = {
      weekday: { snapshot_days: activity.counts.weekday, needed_days: ACTIVITY_THRESHOLDS.weekday, ready: !!activity.weekday },
      weekend: { snapshot_days: activity.counts.weekend, needed_days: ACTIVITY_THRESHOLDS.weekend, ready: !!activity.weekend },
    };
    result.sources = sources;

    // Tier 2 가 슬롯 갈아끼웠을 수 있으니 오늘 기준 allSlots/bestTime 재계산.
    result.allSlots = isWeekendToday ? result.weekend : result.weekday;
    if (result.modes[isWeekendToday ? 'weekend' : 'weekday'] === 'personal') {
      const picked = pickUpcoming(result.allSlots);
      if (picked) {
        result.bestTime = picked.time;
        result.reason = picked.reason;
      }
    }

    // ── Tier 1a: Meta online_followers → bestTime 단일 점 덮어쓰기 ───────
    // (요일별 슬롯은 Tier 3 결과 유지 — Tier 1a 는 시간 차원만 신뢰.)
    // Tier 2 가 활성이면 같은 메트릭을 누적 매트릭스로 이미 사용 중이라 호출 스킵.
    const tier2BothReady = !!(activity.weekday && activity.weekend);
    if (!tier2BothReady) {
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
          // Tier 2 가 한쪽이라도 활성이면 그 결과를 우선 — bestTime 만 보강.
          if (!result.progress[isWeekendToday ? 'weekend' : 'weekday'].ready) {
            result.bestTime = `${hh}:00`;
            result.reason = '내 팔로워가 가장 많이 접속하는 시간대';
            if (result.source === 'industry-seed') result.source = 'meta-online-followers';
          }
        }
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
