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
      .select('reserve_key, caption_status, selected_caption_index, post_mode, scheduled_at, is_sent, cancelled, user_id')
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

    for (const row of rows) {
      try {
        // post_mode='immediate' 은 process-and-post 가 캡션 생성 직후 직접
        // select-and-post 를 트리거함. 여기선 그게 실패해서 stuck 된 경우만 복구한다.
        // (status='scheduled' + selected_caption_index 셋팅된 immediate 도 분기 통과)

        // captionStatus 분기
        if (row.caption_status === 'scheduled' && row.selected_caption_index !== null && row.selected_caption_index !== undefined) {
          // 사용자가 이미 캡션을 선택한 예약 → select-and-post-background 로 IG 게시
          const res = await fetch(`${siteUrl}/.netlify/functions/select-and-post-background`, {
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
        } else if (['ready', 'posting', 'failed'].includes(row.caption_status)) {
          // 캡션 선택 대기 중 또는 진행 중 / 실패 — 스킵
          console.log('[scheduler] 스킵 caption_status=' + row.caption_status + ':', row.reserve_key);
          continue;
        } else {
          // 캡션 미생성 (pending 등) → 캡션 생성 + 게시 파이프라인 트리거
          const res = await fetch(`${siteUrl}/.netlify/functions/process-and-post-background`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.LUMI_SECRET}`,
            },
            body: JSON.stringify({ reservationKey: row.reserve_key }),
          });
          if (res.ok || res.status === 202) {
            triggered++;
            console.log('[scheduler] process-and-post-background 트리거:', row.reserve_key);
          } else {
            console.error('[scheduler] process-and-post-background 트리거 실패:', row.reserve_key, res.status);
          }
        }
      } catch (e) {
        console.error('[scheduler] 항목 오류:', row.reserve_key, e.message);
      }
    }

    console.log(`[scheduler] 완료: ${triggered}건 트리거 / ${rows.length}건 조회`);
    return { statusCode: 200 };

  } catch (err) {
    console.error('[scheduler] error:', err.message);
    return { statusCode: 500 };
  }
};

module.exports.config = {
  schedule: '* * * * *',
};
