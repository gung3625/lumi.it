// netlify/functions/scheduled-post-insights-background.js
// seller_post_history 의 reach/saved/engagement 를 채우는 cron.
//
// 의도:
//   베스트 시간 추천이 단순 "본인이 평소 올린 시간" 빈도가 아닌, "그 시간에
//   올린 게시물이 실제로 잘 됐는지" 가중치를 곱한 결과가 되도록.
//   Tier 1 (performance-weighted) 의 데이터 소스.
//
// 2-stage 측정:
//   stage 1 — 게시 후 1h 통과 시 1차 측정. reach 누적 ~10~50% 수준.
//             → insights_fetched_at 채움. 사장님 카드 "측정 완료" 카운트 +1.
//   stage 2 — 게시 후 24h 통과 시 final 측정. reach 누적 ~80~90% 안정값.
//             → insights_finalized_at 도 채움. 그 후엔 후보 query 에서 자연 제외.
//   (IG Insights 의 reach 는 게시 후 시간이 지날수록 누적되므로 2-stage 가 정직.)
//
// 처리 정책:
//   - stage 1 후보: insights_fetched_at IS NULL AND now()-90d < posted_at < now()-1h
//   - stage 2 후보: insights_finalized_at IS NULL AND insights_fetched_at IS NOT NULL
//                  AND posted_at < now()-24h (부분 인덱스 가속)
//   - 배치 50건/stage. 한 사장님 안에서 토큰 1회 fetch.
//   - stage 1 1회 시도 후 무조건 insights_fetched_at = now() 채움 — 영구 실패 row
//     무한 재시도 방지. stage 2 도 시도 후 무조건 finalized_at 채움.
//
// 권한: instagram_manage_insights (ig-oauth 가 이미 요청)
// 스케줄: 30분 주기 — */30 * * * * (netlify.toml). 게시 후 ~1.5h 안에 stage 1 픽업.

const { getAdminClient } = require('./_shared/supabase-admin');
const { getIgTokenForSeller, igGraphRequest, IgGraphError } = require('./_shared/ig-graph');

const BATCH_SIZE = 50;
const WINDOW_DAYS = 90;
const STABILIZE_HOURS = 1;     // 게시 후 N시간 지나야 stage 1 후보 진입
const FINALIZE_HOURS = 24;     // 게시 후 N시간 지나야 stage 2 (final) 후보 진입
// IG 가 미디어 타입 무관하게 제공하는 공통 metric.
// REELS/VIDEO 는 'views' 가 따로 있지만 reach 로도 충분히 가중치 산출 가능.
const METRICS = 'reach,saved,total_interactions';

exports.handler = async () => {
  const supabase = getAdminClient();
  const now = Date.now();
  const since = new Date(now - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  const beforeStable = new Date(now - STABILIZE_HOURS * 3600 * 1000).toISOString();
  const beforeFinal = new Date(now - FINALIZE_HOURS * 3600 * 1000).toISOString();

  // stage 1 — 1차 측정 후보 (게시 1h+ 경과, fetched_at 아직 NULL)
  const { data: stage1Rows, error: stage1Err } = await supabase
    .from('seller_post_history')
    .select('user_id, ig_media_id, media_type')
    .is('insights_fetched_at', null)
    .gte('posted_at', since)
    .lte('posted_at', beforeStable)
    .order('posted_at', { ascending: false })
    .limit(BATCH_SIZE);

  // stage 2 — final 측정 후보 (게시 24h+ 경과, fetched 됐지만 finalized 아직)
  const { data: stage2Rows, error: stage2Err } = await supabase
    .from('seller_post_history')
    .select('user_id, ig_media_id, media_type')
    .is('insights_finalized_at', null)
    .not('insights_fetched_at', 'is', null)
    .gte('posted_at', since)
    .lte('posted_at', beforeFinal)
    .order('posted_at', { ascending: false })
    .limit(BATCH_SIZE);

  if (stage1Err) console.error('[post-insights] stage1 후보 조회 실패:', stage1Err.message);
  if (stage2Err) console.error('[post-insights] stage2 후보 조회 실패:', stage2Err.message);

  // stage 정보 포함한 통합 후보. 같은 row 가 양쪽 stage 에 들어올 수 없음
  // (fetched_at 채워지면 stage 1 후보에서 자동 제외).
  const rows = [
    ...(stage1Rows || []).map((r) => ({ ...r, stage: 1 })),
    ...(stage2Rows || []).map((r) => ({ ...r, stage: 2 })),
  ];
  if (rows.length === 0) {
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

  // 무한 재시도 차단용 — stage 1 row 는 fetched_at, stage 2 row 는 finalized_at 마킹.
  // (stage 2 row 는 이미 fetched_at 채워져 있으므로 finalized_at 만 마킹하면 후보 종료)
  async function markUnreachable(userId, medias) {
    const nowIso = new Date().toISOString();
    const stage1Ids = medias.filter((m) => m.stage === 1).map((m) => m.ig_media_id);
    const stage2Ids = medias.filter((m) => m.stage === 2).map((m) => m.ig_media_id);
    if (stage1Ids.length) {
      await supabase
        .from('seller_post_history')
        .update({ insights_fetched_at: nowIso })
        .eq('user_id', userId)
        .in('ig_media_id', stage1Ids);
    }
    if (stage2Ids.length) {
      await supabase
        .from('seller_post_history')
        .update({ insights_finalized_at: nowIso })
        .eq('user_id', userId)
        .in('ig_media_id', stage2Ids);
    }
  }

  for (const [userId, medias] of byUser) {
    const ig = await getIgTokenForSeller(userId, supabase);
    if (!ig) {
      // 토큰 없음 = IG 연동 해제. 후보 row 는 무한 재시도 차단.
      skippedNoToken += medias.length;
      await markUnreachable(userId, medias);
      continue;
    }

    // 토큰 무효 표시된 사장님은 skip — Meta 호출 낭비 방지.
    try {
      const { data: igRow } = await supabase
        .from('ig_accounts')
        .select('token_invalid_at')
        .eq('user_id', userId)
        .maybeSingle();
      if (igRow && igRow.token_invalid_at) {
        await markUnreachable(userId, medias);
        skippedNoToken += medias.length;
        continue;
      }
    } catch (_) { /* check 실패해도 계속 진행 */ }

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
          // 토큰 무효(code 190 또는 401) 감지 시 ig_accounts.token_invalid_at 기록.
          // 이후 같은 cron 실행에서 이 사장님의 남은 row 는 위 무효 체크로 skip 됨.
          if (e.code === 190 || e.status === 401) {
            try {
              await supabase
                .from('ig_accounts')
                .update({ token_invalid_at: new Date().toISOString() })
                .eq('user_id', userId);
              console.warn('[post-insights] 토큰 무효 표시:', userId.slice(0, 8));
            } catch (_) { /* noop */ }
          }
        } else {
          console.warn('[post-insights] 예외:', m.ig_media_id, e && e.message);
        }
        fail++;
      }

      // stage 1: 1차 측정. fetched_at 마킹 (다음 stage 2 까지 대기).
      // stage 2: final 측정. finalized_at 마킹 — 후보 query 에서 영구 제외.
      // 양쪽 모두 reach/saved/engagement 는 최신 값으로 덮어씀.
      const nowIso = new Date().toISOString();
      const update = {
        reach: typeof valMap.reach === 'number' ? valMap.reach : null,
        saved: typeof valMap.saved === 'number' ? valMap.saved : null,
        engagement: typeof valMap.total_interactions === 'number' ? valMap.total_interactions : null,
      };
      if (m.stage === 1) update.insights_fetched_at = nowIso;
      if (m.stage === 2) update.insights_finalized_at = nowIso;
      const { error: updErr } = await supabase
        .from('seller_post_history')
        .update(update)
        .eq('user_id', userId)
        .eq('ig_media_id', m.ig_media_id);
      if (updErr) console.warn('[post-insights] update 실패:', m.ig_media_id, updErr.message);
    }
  }

  const stage1Count = rows.filter((r) => r.stage === 1).length;
  const stage2Count = rows.filter((r) => r.stage === 2).length;
  console.log(`[post-insights] processed=${rows.length} (stage1=${stage1Count} stage2=${stage2Count}) ok=${ok} fail=${fail} no_token=${skippedNoToken}`);
  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      processed: rows.length,
      stage1: stage1Count,
      stage2: stage2Count,
      success: ok,
      failed: fail,
      no_token: skippedNoToken,
    }),
  };
};
