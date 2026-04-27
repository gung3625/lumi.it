// Retry Engine — Sprint 2 (메모리 project_data_pipeline_architecture.md A항)
// 마켓 API 장애 시 자동 재시도 큐 관리
//
// Exponential Backoff: 1m → 5m → 30m → 2h → 24h (최대 5회)
// 큐 처리 = Netlify Cron (1분마다 due 큐 픽업) — 본 모듈은 큐 적재/조회/처리 헬퍼만
//
// DB 테이블: retry_queue (migrations/2026-04-28-sprint-2-products.sql)

const BACKOFF_INTERVALS_MS = [
  60 * 1000,           // 1m
  5 * 60 * 1000,       // 5m
  30 * 60 * 1000,      // 30m
  2 * 60 * 60 * 1000,  // 2h
  24 * 60 * 60 * 1000, // 24h
];
const MAX_RETRY_COUNT = BACKOFF_INTERVALS_MS.length;

/**
 * retry_count → 다음 재시도 시각 계산
 * @param {number} retryCount - 0~5
 * @param {Date} [now]
 * @returns {Date}
 */
function nextRetryAt(retryCount, now = new Date()) {
  const idx = Math.min(retryCount, BACKOFF_INTERVALS_MS.length - 1);
  return new Date(now.getTime() + BACKOFF_INTERVALS_MS[idx]);
}

/**
 * retry_queue 큐 적재
 * @param {Object} admin - Supabase admin client
 * @param {Object} task
 * @param {string} task.seller_id
 * @param {string} task.task_type - 'register_product' / 'update_stock' / 'send_invoice'
 * @param {string} task.market - 'coupang' / 'naver'
 * @param {Object} task.payload
 * @param {Object} [task.last_error]
 * @returns {Promise<{ ok: boolean, id?: string, error?: string }>}
 */
async function enqueue(admin, { seller_id, task_type, market, payload, last_error }) {
  const next = nextRetryAt(0).toISOString();
  try {
    const { data, error } = await admin
      .from('retry_queue')
      .insert({
        seller_id,
        task_type,
        market,
        payload,
        retry_count: 0,
        next_retry_at: next,
        last_error: last_error || null,
        status: 'pending',
      })
      .select('id')
      .single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: data.id, nextRetryAt: next };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 처리 due 큐 조회 (status=pending AND next_retry_at <= now)
 * @param {Object} admin
 * @param {number} [limit]
 */
async function fetchDue(admin, limit = 50) {
  try {
    const { data, error } = await admin
      .from('retry_queue')
      .select('*')
      .eq('status', 'pending')
      .lte('next_retry_at', new Date().toISOString())
      .order('next_retry_at', { ascending: true })
      .limit(limit);
    if (error) return { ok: false, error: error.message, items: [] };
    return { ok: true, items: data || [] };
  } catch (e) {
    return { ok: false, error: e.message, items: [] };
  }
}

/**
 * 작업 결과 반영 — 성공 시 status='done', 실패 시 retry_count++ 또는 abandoned
 * @param {Object} admin
 * @param {string} id - retry_queue.id
 * @param {Object} result - { success, error, retryable, market_product_id, direct_link, ... }
 * @returns {Promise<{ ok: boolean, status: string, error?: string }>}
 */
async function recordResult(admin, id, result) {
  try {
    if (result.success) {
      const { error } = await admin
        .from('retry_queue')
        .update({
          status: 'done',
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id);
      if (error) return { ok: false, error: error.message, status: 'done' };
      return { ok: true, status: 'done' };
    }

    // 실패 — retryable 여부 + 횟수 한도 확인
    const { data: row, error: fetchErr } = await admin
      .from('retry_queue')
      .select('retry_count')
      .eq('id', id)
      .single();
    if (fetchErr || !row) return { ok: false, error: fetchErr?.message || 'row not found', status: 'unknown' };

    const newCount = (row.retry_count || 0) + 1;
    const shouldAbandon = newCount >= MAX_RETRY_COUNT || result.retryable === false;
    const newStatus = shouldAbandon ? 'abandoned' : 'pending';
    const next = shouldAbandon ? null : nextRetryAt(newCount).toISOString();

    const { error: updErr } = await admin
      .from('retry_queue')
      .update({
        status: newStatus,
        retry_count: newCount,
        next_retry_at: next,
        last_error: { message: result.error, status: result.status, raw: result.raw },
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
    if (updErr) return { ok: false, error: updErr.message, status: newStatus };

    return { ok: true, status: newStatus, retryCount: newCount, nextRetryAt: next };
  } catch (e) {
    return { ok: false, error: e.message, status: 'unknown' };
  }
}

/**
 * 처리 시작 lock (status='processing'으로 변경, 1분 timeout 후 자동 풀림)
 */
async function markProcessing(admin, id) {
  try {
    const { error } = await admin
      .from('retry_queue')
      .update({ status: 'processing', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'pending');
    return { ok: !error, error: error?.message };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  enqueue,
  fetchDue,
  recordResult,
  markProcessing,
  nextRetryAt,
  BACKOFF_INTERVALS_MS,
  MAX_RETRY_COUNT,
};
