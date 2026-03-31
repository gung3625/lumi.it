const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  try {
    const store = getStore({
      name: 'reservations',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID,
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

        // 이미 처리됐거나 처리 중이면 스킵
        if (item.isSent) continue;
        if (item.captionsGeneratedAt) continue;
        if (!item.scheduledAt) continue;
        if (new Date(item.scheduledAt) > now) continue;

        // process-and-post Background Function 트리거
        const siteUrl = process.env.URL || 'https://lumi.it.kr';
        const res = await fetch(`${siteUrl}/.netlify/functions/process-and-post`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reservationKey: blob.key }),
        });

        if (res.ok || res.status === 202) {
          triggered++;
          console.log('[scheduler] process-and-post 트리거:', blob.key);
        } else {
          console.error('[scheduler] 트리거 실패:', blob.key, res.status);
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
  schedule: '*/5 * * * *',
};
