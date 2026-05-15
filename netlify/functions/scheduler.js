// 1분 cron — 예약 게시 트리거.
// public.reservations 에서 pending/scheduled 상태 + scheduled_at <= now() 조회 후
// process-and-post-background / select-and-post-background 로 위임.
const { getAdminClient } = require('./_shared/supabase-admin');

exports.handler = async () => {
  try {
    const supabase = getAdminClient();
    const nowIso = new Date().toISOString();

    // 처리 대상: 아직 게시되지 않고 취소되지 않았으며 scheduled_at 이 지난 예약
    // caption_status 는 뒤에서 분기 처리.
    const { data: rows, error } = await supabase
      .from('reservations')
      .select('reserve_key, caption_status, selected_caption_index, post_mode, scheduled_at, is_sent, cancelled, user_id, created_at, media_type, video_processed_at')
      .eq('is_sent', false)
      .eq('cancelled', false)
      .not('scheduled_at', 'is', null)
      .lte('scheduled_at', nowIso)
      .order('scheduled_at', { ascending: true })
      .limit(50);

    if (error) {
      console.error('[scheduler] reservations 조회 실패:', error.message);
      return { statusCode: 500 };
    }

    if (!rows || rows.length === 0) return { statusCode: 200 };

    const siteUrl = 'https://lumi.it.kr';
    let triggered = 0;

    // Important fix (2026-05-15): row 직렬 await 가 hang 하면 1분 cycle 안에 50건 처리 불가.
    // Promise.allSettled + AbortController 5초 timeout 으로 병렬화.
    // background function 트리거 자체는 202 즉시 응답이라 5초 cap 안전.
    const safeFetch = async (url, opts) => {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 5000);
      try {
        return await fetch(url, { ...opts, signal: ctrl.signal });
      } finally {
        clearTimeout(tid);
      }
    };

    const results = await Promise.allSettled(rows.map(async (row) => {
      try {
        // post_mode='immediate' 은 process-and-post 가 캡션 생성 직후 직접
        // select-and-post 를 트리거함. 여기선 그게 실패해서 stuck 된 경우만 복구한다.
        // (status='scheduled' + selected_caption_index 셋팅된 immediate 도 분기 통과)

        // captionStatus 분기
        if (row.caption_status === 'scheduled' && row.selected_caption_index !== null && row.selected_caption_index !== undefined) {
          // REELS gate: ffmpeg 후처리(자막 burn-in, overlay text)가 끝나기 전엔 원본 .mov 로
          // 게시되지 않도록 차단. process-video 가 완료 시 video_processed_at 을 세팅한다.
          if (row.media_type === 'REELS' && !row.video_processed_at) {
            console.log('[scheduler] 스킵 REELS 후처리 대기:', row.reserve_key);
            continue;
          }
          // 사용자가 이미 캡션을 선택한 예약 → select-and-post-background 로 IG 게시
          const res = await safeFetch(`${siteUrl}/.netlify/functions/select-and-post-background`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.LUMI_SECRET}`,
            },
            body: JSON.stringify({
              reservationKey: row.reserve_key,
              captionIndex: row.selected_caption_index,
            }),
          });
          if (res.ok || res.status === 202) {
            triggered++;
            console.log('[scheduler] select-and-post-background 트리거:', row.reserve_key);
          } else {
            console.error('[scheduler] select-and-post-background 트리거 실패:', row.reserve_key, res.status);
          }
        } else if (['ready', 'posting', 'failed', 'generating'].includes(row.caption_status)) {
          // 캡션 선택 대기 중 또는 진행 중 / 실패 — 스킵
          console.log('[scheduler] 스킵 caption_status=' + row.caption_status + ':', row.reserve_key);
          continue;
        } else {
          // 캡션 미생성 (pending 등) → 캡션 생성 + 게시 파이프라인 트리거.
          //
          // race 차단: reserve.js 가 reservation insert 직후 process-and-post 를 이미
          // 트리거하므로, 새로 생긴 'pending' row 는 처리 중일 가능성이 매우 높다.
          // scheduler 가 같은 분 안에 끼어들어서 process-and-post 가 두 번 호출되면
          // 같은 사진이 다른 캡션으로 두 번 게시되는 버그 발생 (2026-05-13 검증).
          //
          // 따라서 'pending' 은 stuck 으로 의심될 만큼 시간이 지난 경우만 트리거한다.
          // 5분: reserve.js 의 1차 트리거가 처리 + caption 생성 + state 전이까지 충분한 여유.
          // process-and-post 자체에도 atomic CAS 가 있어 race 시 한 호출만 통과한다.
          const createdMs = row.created_at ? new Date(row.created_at).getTime() : 0;
          const ageMs = Date.now() - createdMs;
          const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
          if (ageMs < STUCK_THRESHOLD_MS) {
            console.log('[scheduler] 스킵 pending (신규, reserve.js 가 처리 중일 가능성):', row.reserve_key);
            continue;
          }
          const res = await safeFetch(`${siteUrl}/.netlify/functions/process-and-post-background`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.LUMI_SECRET}`,
            },
            body: JSON.stringify({ reservationKey: row.reserve_key }),
          });
          if (res.ok || res.status === 202) {
            triggered++;
            console.log('[scheduler] stuck 복구 — process-and-post-background 트리거:', row.reserve_key);
          } else {
            console.error('[scheduler] process-and-post-background 트리거 실패:', row.reserve_key, res.status);
          }
        }
      } catch (e) {
        console.error('[scheduler] 항목 오류:', row.reserve_key, e.message);
      }
    }));
    const failed = results.filter((r) => r.status === 'rejected').length;
    console.log(`[scheduler] 완료: ${triggered}건 트리거 / ${rows.length}건 조회 / ${failed}건 실패`);
    return { statusCode: 200 };

  } catch (err) {
    console.error('[scheduler] error:', err.message);
    return { statusCode: 500 };
  }
};

module.exports.config = {
  schedule: '* * * * *',
};
