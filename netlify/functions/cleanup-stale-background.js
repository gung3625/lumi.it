const { corsHeaders, getOrigin } = require('./_shared/auth');
// Scheduled Background Function — 스테일/실패/완료 예약 자동 정리.
// Netlify 스케줄러가 내부 트리거로 실행 (LUMI_SECRET 불필요).
// 매시간 실행 (netlify.toml: "0 * * * *").
//
// 정리 규칙:
//  1) pending + created_at < now-30m → 스토리지 + row 모두 삭제 (orphan)
//  2) failed  + created_at < now-7d  → 스토리지 + row 모두 삭제 (디버깅 보존 후 정리)
//  3) is_sent=true + posted_at < now-30d → 스토리지만 삭제, row 보존 (히스토리)
// 각 쿼리 LIMIT 100.

const { getAdminClient } = require('./_shared/supabase-admin');
const { deleteReservationStorage, deleteReservationRow } = require('./_shared/storage-cleanup');


const LIMIT = 100;
const THIRTY_MIN_MS = 30 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

async function cleanupPendingOrphans(supabase) {
  const cutoff = new Date(Date.now() - THIRTY_MIN_MS).toISOString();
  const { data, error } = await supabase
    .from('reservations')
    .select('reserve_key, image_keys, video_key')
    .eq('caption_status', 'pending')
    .lt('created_at', cutoff)
    .limit(LIMIT);
  if (error) {
    console.error('[cleanup-stale] pending 조회 실패:', error.message);
    return 0;
  }
  let count = 0;
  for (const row of data || []) {
    const storage = await deleteReservationStorage(supabase, row);
    if (storage.errors.length) {
      console.warn(`[cleanup-stale] pending 스토리지 경고 ${row.reserve_key}:`, storage.errors.join(' | '));
    }
    const del = await deleteReservationRow(supabase, row.reserve_key);
    if (del.error) {
      console.error(`[cleanup-stale] pending row 삭제 실패 ${row.reserve_key}:`, del.error);
      continue;
    }
    count += 1;
  }
  return count;
}

async function cleanupFailedOld(supabase) {
  const cutoff = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();
  const { data, error } = await supabase
    .from('reservations')
    .select('reserve_key, image_keys, video_key')
    .eq('caption_status', 'failed')
    .lt('created_at', cutoff)
    .limit(LIMIT);
  if (error) {
    console.error('[cleanup-stale] failed 조회 실패:', error.message);
    return 0;
  }
  let count = 0;
  for (const row of data || []) {
    const storage = await deleteReservationStorage(supabase, row);
    if (storage.errors.length) {
      console.warn(`[cleanup-stale] failed 스토리지 경고 ${row.reserve_key}:`, storage.errors.join(' | '));
    }
    const del = await deleteReservationRow(supabase, row.reserve_key);
    if (del.error) {
      console.error(`[cleanup-stale] failed row 삭제 실패 ${row.reserve_key}:`, del.error);
      continue;
    }
    count += 1;
  }
  return count;
}

async function cleanupPostedStorage(supabase) {
  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
  const { data, error } = await supabase
    .from('reservations')
    .select('reserve_key, image_keys, video_key')
    .eq('is_sent', true)
    .lt('posted_at', cutoff)
    .limit(LIMIT);
  if (error) {
    console.error('[cleanup-stale] posted 조회 실패:', error.message);
    return 0;
  }
  let count = 0;
  for (const row of data || []) {
    const hasKeys = (Array.isArray(row.image_keys) && row.image_keys.length) || !!row.video_key;
    if (!hasKeys) continue; // 이미 정리된 row 스킵
    const storage = await deleteReservationStorage(supabase, row);
    if (storage.errors.length) {
      console.warn(`[cleanup-stale] posted 스토리지 경고 ${row.reserve_key}:`, storage.errors.join(' | '));
    }
    // row는 보존 — keys 컬럼만 null/[]로 비워 중복 호출 방지
    try {
      const { error: updErr } = await supabase
        .from('reservations')
        .update({ image_keys: [], video_key: null })
        .eq('reserve_key', row.reserve_key);
      if (updErr) {
        console.error(`[cleanup-stale] posted keys 비우기 실패 ${row.reserve_key}:`, updErr.message);
        continue;
      }
    } catch (e) {
      console.error(`[cleanup-stale] posted keys 비우기 예외 ${row.reserve_key}:`, e.message);
      continue;
    }
    count += 1;
  }
  return count;
}

// trends 테이블 진단·메타 row 자동 cleanup.
//
// 배경 (2026-05-13): trends 테이블에 진짜 카테고리 row (cafe/food/...) 외
// 진단/메타 row 가 누적됨 (l30d-rising:*, l30d-domestic-prev:*, cron-heartbeat:*,
// cron-stage:*, ig-hashtag-cache:*, today-mission:*). 분포 점검 결과 진단 row 가
// 진짜 데이터의 20+ 배. schema 분리는 광범위 코드 수정 필요 (reader/writer 8 파일+)
// 라 단순 자동 cleanup 으로 누적 차단.
//
// 보존 기간 (각 reader 가 요구하는 최대 lookback 고려):
//   - l30d-*           : 60일 (28일 전 evaluatePredictionAccuracy 용 + buffer 30일)
//   - cron-heartbeat/stage : 30일 (cron-health.js 가 직전 실행만 보면 충분)
//   - ig-hashtag-cache : 14일 (해시태그 캐시 신선도 한계)
//   - today-mission    : 14일 (당일 미션이라 옛 row 불필요)
//   - 기타 잡 row (interior/education/studio/other/trends:other) : 즉시
async function cleanupTrendsMeta(supabase) {
  const D60 = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const D30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const D14 = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const targets = [
    { label: 'l30d-old',          filter: (q) => q.like('category', 'l30d-%').lt('collected_at', D60) },
    // cron-keys.js HEARTBEAT_PREFIX / STAGE_PREFIX 와 동기 (require X — LIKE wildcard 패턴이라 string literal 유지가 맞음, 단 keys 변경 시 함께 검토)
    { label: 'cron-heartbeat-old', filter: (q) => q.like('category', 'cron-heartbeat:%').lt('collected_at', D30) },
    { label: 'cron-stage-old',     filter: (q) => q.like('category', 'cron-stage:%').lt('collected_at', D30) },
    { label: 'ig-hashtag-cache-old', filter: (q) => q.like('category', 'ig-hashtag-cache:%').lt('collected_at', D14) },
    { label: 'today-mission-old',   filter: (q) => q.like('category', 'today-mission:%').lt('collected_at', D14) },
    { label: 'orphan-categories',   filter: (q) => q.in('category', ['interior','education','studio','trends:interior','trends:other','other']) },
  ];

  let total = 0;
  for (const t of targets) {
    try {
      let q = supabase.from('trends').delete({ count: 'exact' });
      q = t.filter(q);
      const { error, count } = await q.select('category');
      if (error) {
        console.warn(`[cleanup-stale] trends ${t.label} 삭제 경고:`, error.message);
        continue;
      }
      if (count) {
        console.log(`[cleanup-stale] trends ${t.label} → ${count}건 삭제`);
        total += count;
      }
    } catch (e) {
      console.warn(`[cleanup-stale] trends ${t.label} 예외:`, e && e.message);
    }
  }
  return total;
}

exports.handler = async () => {
  const headers = corsHeaders(getOrigin(event));
  try {
    const supabase = getAdminClient();
    const [pending, failed, posted, trendsMeta] = await Promise.all([
      cleanupPendingOrphans(supabase),
      cleanupFailedOld(supabase),
      cleanupPostedStorage(supabase),
      cleanupTrendsMeta(supabase),
    ]);
    console.log(`[cleanup-stale] pending=${pending} failed=${failed} posted=${posted} trendsMeta=${trendsMeta}`);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, pending, failed, posted, trendsMeta }),
    };
  } catch (err) {
    console.error('[cleanup-stale] 실행 실패:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: '스케줄 정리 중 오류가 발생했습니다.' }),
    };
  }
};

