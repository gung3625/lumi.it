// sync-status.js — Sprint 4 마켓 동기화 헬스 추적 (대시보드 Sync Status Card)
// 메모리 project_data_pipeline_architecture.md (역방향 + 어댑터 헬스)

/**
 * 마켓 동기화 결과 기록
 * @param {Object} admin
 * @param {string} sellerId
 * @param {string} market — 'coupang' | 'naver' | 'toss'
 * @param {Object} result — { ok, ordersCount, csCount, error }
 */
async function recordSyncResult(admin, sellerId, market, result) {
  if (!admin || !sellerId || !market) return { ok: false, error: 'required params' };

  const now = new Date().toISOString();
  const ok = result?.ok !== false;

  try {
    const { data: existing } = await admin
      .from('market_sync_status')
      .select('*')
      .eq('seller_id', sellerId)
      .eq('market', market)
      .maybeSingle();

    const consecutiveFailures = ok
      ? 0
      : ((existing?.consecutive_failures || 0) + 1);

    const healthStatus = !ok && consecutiveFailures >= 3
      ? 'failing'
      : !ok && consecutiveFailures >= 1
      ? 'degraded'
      : 'healthy';

    const row = {
      seller_id: sellerId,
      market,
      last_synced_at: now,
      last_success_at: ok ? now : (existing?.last_success_at || null),
      last_failure_at: ok ? (existing?.last_failure_at || null) : now,
      last_error_message: ok ? null : (result?.error || 'unknown error'),
      health_status: healthStatus,
      consecutive_failures: consecutiveFailures,
      orders_synced_24h: (existing?.orders_synced_24h || 0) + Number(result?.ordersCount || 0),
      cs_synced_24h: (existing?.cs_synced_24h || 0) + Number(result?.csCount || 0),
    };

    if (existing) {
      await admin
        .from('market_sync_status')
        .update(row)
        .eq('id', existing.id);
    } else {
      await admin.from('market_sync_status').insert(row);
    }

    return { ok: true, healthStatus, consecutiveFailures };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 셀러의 모든 마켓 sync 상태 조회 (대시보드 카드용)
 */
async function fetchSyncStatus(admin, sellerId) {
  if (!admin || !sellerId) return { ok: false, statuses: [] };

  try {
    const { data, error } = await admin
      .from('market_sync_status')
      .select('*')
      .eq('seller_id', sellerId)
      .order('market');
    if (error) return { ok: false, statuses: [], error: error.message };
    return { ok: true, statuses: data || [] };
  } catch (e) {
    return { ok: false, statuses: [], error: e.message };
  }
}

/**
 * 친절한 헬스 메시지
 */
function buildHealthMessage(status) {
  const minutes = status.last_synced_at
    ? Math.round((Date.now() - new Date(status.last_synced_at).getTime()) / 60000)
    : null;

  const ago = minutes === null
    ? '아직 동기화한 적 없어요'
    : minutes < 1 ? '방금 전'
    : minutes < 60 ? `${minutes}분 전`
    : minutes < 24 * 60 ? `${Math.round(minutes / 60)}시간 전`
    : `${Math.round(minutes / (24 * 60))}일 전`;

  if (status.health_status === 'healthy') {
    return { tone: 'ok', text: `정상 · 마지막 동기화 ${ago}` };
  }
  if (status.health_status === 'degraded') {
    return { tone: 'warn', text: `일시 불안정 · 자동 재시도 중 (${ago})` };
  }
  if (status.health_status === 'failing') {
    return { tone: 'error', text: '연결 점검 필요 · 키 설정을 확인해 주세요' };
  }
  return { tone: 'info', text: '연결 대기 중' };
}

/**
 * 24h 카운터 리셋 (cron — 매일 자정)
 */
async function resetDaily24hCounters(admin) {
  if (!admin) return { ok: false };
  try {
    const { error } = await admin
      .from('market_sync_status')
      .update({ orders_synced_24h: 0, cs_synced_24h: 0 })
      .gt('updated_at', '1970-01-01');
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  recordSyncResult,
  fetchSyncStatus,
  buildHealthMessage,
  resetDaily24hCounters,
};
