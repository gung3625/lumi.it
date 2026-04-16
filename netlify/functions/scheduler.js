const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  try {
    const store = getStore({
      name: 'reservations',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN,
    });

    const now = new Date();
    let list;
    try { list = await store.list({ prefix: 'reserve:' }); } catch(e) {
      console.log('[scheduler] 예약 목록 없음:', e.message);
      return { statusCode: 200 };
    }

    if (!list.blobs || list.blobs.length === 0) return { statusCode: 200 };

    let triggered = 0;

    for (const blob of list.blobs) {
      try {
        const raw = await store.get(blob.key);
        if (!raw) continue;
        const item = JSON.parse(raw);

        // 이미 게시됐거나 취소된 항목 스킵
        if (item.isSent || item.cancelled || item.captionStatus === 'posted') continue;
        if (!item.scheduledAt) continue;
        if (new Date(item.scheduledAt) > now) continue;

        // 즉시 게시 모드는 select-caption→select-and-post-background가 전담 — scheduler 불개입
        if (item.postMode === 'immediate') continue;

        // Background Function은 즉시 202 반환 — fire-and-forget
        const siteUrl = 'https://lumi.it.kr';

        // captionStatus 기반 분기
        if (item.captionStatus === 'scheduled' && item.selectedCaptionIndex !== undefined) {
          // 사용자가 이미 캡션을 선택한 예약건 → select-and-post-background로 IG 게시
          const res = await fetch(`${siteUrl}/.netlify/functions/select-and-post-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.LUMI_SECRET}` },
            body: JSON.stringify({
              reservationKey: blob.key,
              captionIndex: item.selectedCaptionIndex,
              email: item.storeProfile?.ownerEmail || '',
            }),
          });
          if (res.ok || res.status === 202) {
            triggered++;
            console.log('[scheduler] select-and-post-background 트리거:', blob.key);
          } else {
            console.error('[scheduler] select-and-post-background 트리거 실패:', blob.key, res.status);
          }
        } else if (['ready', 'posting', 'failed'].includes(item.captionStatus)) {
          // 캡션 선택 대기 중 또는 게시 진행 중 → 스킵
          console.log('[scheduler] 스킵 (captionStatus=' + item.captionStatus + '):', blob.key);
          continue;
        } else {
          // 캡션 미생성 예약건 → 기존 process-and-post-background 호출
          const res = await fetch(`${siteUrl}/.netlify/functions/process-and-post-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.LUMI_SECRET}` },
            body: JSON.stringify({ reservationKey: blob.key }),
          });
          if (res.ok || res.status === 202) {
            triggered++;
            console.log('[scheduler] process-and-post-background 트리거:', blob.key);
          } else {
            console.error('[scheduler] 트리거 실패:', blob.key, res.status);
          }
        }
      } catch(e) {
        console.error('[scheduler] 항목 오류:', blob.key, e.message);
      }
    }

    console.log(`[scheduler] 완료: ${triggered}건 트리거`);
    return { statusCode: 200 };

  } catch (err) {
    console.error('[scheduler] error:', err.message);
    return { statusCode: 500 };
  }
};

module.exports.config = {
  schedule: '* * * * *',
};
