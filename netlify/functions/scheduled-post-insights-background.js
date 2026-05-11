// netlify/functions/scheduled-post-insights-background.js
// seller_post_history 의 reach/saved/engagement 를 일별 1회 채우는 cron.
//
// 의도:
//   베스트 시간 추천이 단순 "본인이 평소 올린 시간" 빈도가 아닌, "그 시간에
//   올린 게시물이 실제로 잘 됐는지" 가중치를 곱한 결과가 되도록.
//   Tier 1 (performance-weighted) 의 데이터 소스.
//
// 처리 정책:
//   - 후보: insights_fetched_at IS NULL AND posted_at > now()-90d AND posted_at < now()-1h
//     (게시 후 1시간 이내는 IG 측 메트릭이 안정되지 않음)
//   - 배치 50건/실행. 한 사장님 안에서 토큰 1회 fetch.
//   - 1회 시도 후 무조건 insights_fetched_at = now() 채움 — 영구 실패 row 의
//     무한 재시도 방지. 데이터 누락 OK (Tier 1 충족조건이 ≥5건이라 노이즈 흡수).
//
// 권한: instagram_manage_insights (ig-oauth 가 이미 요청)
// 스케줄: 매일 03:30 KST = UTC 18:30 (netlify.toml)

const { getAdminClient } = require('./_shared/supabase-admin');
const { getIgTokenForSeller, igGraphRequest, IgGraphError } = require('./_shared/ig-graph');

const BATCH_SIZE = 50;
const WINDOW_DAYS = 90;
const STABILIZE_HOURS = 1;     // 게시 후 N시간 지나야 메트릭 수집
// IG 가 미디어 타입 무관하게 제공하는 공통 metric.
// REELS/VIDEO 는 'views' 가 따로 있지만 reach 로도 충분히 가중치 산출 가능.
const METRICS = 'reach,saved,total_interactions';

exports.handler = async () => {
  const supabase = getAdminClient();
  const now = Date.now();
  const since = new Date(now - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  const beforeStable = new Date(now - STABILIZE_HOURS * 3600 * 1000).toISOString();

  const { data: rows, error: fetchErr } = await supabase
    .from('seller_post_history')
    .select('user_id, ig_media_id, media_type')
    .is('insights_fetched_at', null)
    .gte('posted_at', since)
    .lte('posted_at', beforeStable)
    .order('posted_at', { ascending: false })
    .limit(BATCH_SIZE);

  if (fetchErr) {
    console.error('[post-insights] 후보 조회 실패:', fetchErr.message);
    return { statusCode: 500, body: JSON.stringify({ error: fetchErr.message }) };
  }
  if (!rows || rows.length === 0) {
    console.log('[post-insights] 처리할 row 없음');
    return { statusCode: 200, body: JSON.stringify({ ok: true, processed: 0 }) };
  }

  // user_id 별 그룹화 — 토큰 1회 fetch
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  }

  let ok = 0;
  let fail = 0;
  let skippedNoToken = 0;

  for (const [userId, medias] of byUser) {
    const ig = await getIgTokenForSeller(userId, supabase);
    if (!ig) {
      // 토큰 없음 = IG 연동 해제. 후보 row 는 무한 재시도 차단 위해 fetched_at 채워둠.
      skippedNoToken += medias.length;
      const ids = medias.map((m) => m.ig_media_id);
      await supabase
        .from('seller_post_history')
        .update({ insights_fetched_at: new Date().toISOString() })
        .eq('user_id', userId)
        .in('ig_media_id', ids);
      continue;
    }

    for (const m of medias) {
      let valMap = {};
      try {
        const res = await igGraphRequest(
          ig.accessToken,
          `/${m.ig_media_id}/insights`,
          { metric: METRICS },
          { timeoutMs: 10000 }
        );
        for (const item of (res.data || [])) {
          const v = item.values && item.values[0] && item.values[0].value;
          if (typeof v === 'number') valMap[item.name] = v;
        }
        ok++;
      } catch (e) {
        // 영구 실패(미디어 삭제·권한 부족) 든 일시 실패든 fetched_at 채워서 재시도 차단.
        // 일별 cron 이라 일시 실패 데이터는 잃지만 ≥5건 임계 안에서 노이즈로 흡수.
        if (e instanceof IgGraphError) {
          console.warn('[post-insights] Graph 실패:', { media: m.ig_media_id, status: e.status, code: e.code });
        } else {
          console.warn('[post-insights] 예외:', m.ig_media_id, e && e.message);
        }
        fail++;
      }

      const update = {
        reach: typeof valMap.reach === 'number' ? valMap.reach : null,
        saved: typeof valMap.saved === 'number' ? valMap.saved : null,
        engagement: typeof valMap.total_interactions === 'number' ? valMap.total_interactions : null,
        insights_fetched_at: new Date().toISOString(),
      };
      const { error: updErr } = await supabase
        .from('seller_post_history')
        .update(update)
        .eq('user_id', userId)
        .eq('ig_media_id', m.ig_media_id);
      if (updErr) console.warn('[post-insights] update 실패:', m.ig_media_id, updErr.message);
    }
  }

  console.log(`[post-insights] processed=${rows.length} ok=${ok} fail=${fail} no_token=${skippedNoToken}`);
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, processed: rows.length, success: ok, failed: fail, no_token: skippedNoToken }),
  };
};
