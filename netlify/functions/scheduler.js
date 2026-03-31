const { getStore } = require('@netlify/blobs');

const SITE_URL = process.env.URL || 'https://lumi.it.kr';

function getBlobStore(name) {
  return getStore({
    name,
    consistency: 'strong',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });
}

exports.handler = async (event) => {
  const now = new Date();

  try {
    const store = getBlobStore('reservations');

    let list;
    try {
      list = await store.list({ prefix: 'reserve:' });
    } catch (e) {
      console.log('[scheduler] 예약 목록 없음:', e.message);
      return { statusCode: 200 };
    }

    if (!list.blobs || list.blobs.length === 0) return { statusCode: 200 };

    let processed = 0;
    let autoPosted = 0;

    for (const blob of list.blobs) {
      try {
        const raw = await store.get(blob.key);
        if (!raw) continue;
        const item = JSON.parse(raw);

        // ── A. 예약 시간 도달 → process-and-post 호출 ──
        if (!item.isSent && item.scheduledAt && new Date(item.scheduledAt) <= now) {
          console.log(`[scheduler] 캡션 생성 시작: ${blob.key}`);

          const res = await fetch(`${SITE_URL}/.netlify/functions/process-and-post`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reserveKey: blob.key }),
          });

          if (res.status === 202 || res.ok) {
            // Background Function은 202 반환
            item.isSent = true;
            item.sentAt = now.toISOString();
            await store.set(blob.key, JSON.stringify(item));
            processed++;
            console.log(`[scheduler] process-and-post 호출 완료: ${blob.key}`);
          } else {
            console.error(`[scheduler] process-and-post 실패: ${blob.key}, status=${res.status}`);
          }
          continue;
        }

        // ── B. 캡션 선택 대기 30분 초과 → 자동 게시 (캡션 #1) ──
        if (
          item.captionStatus === 'pending' &&
          item.autoPostAt &&
          new Date(item.autoPostAt) <= now &&
          item.captions &&
          item.captions.length > 0
        ) {
          console.log(`[scheduler] 30분 초과, 자동 게시: ${blob.key}`);

          const res = await fetch(`${SITE_URL}/.netlify/functions/select-caption`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Lumi-Secret': process.env.LUMI_SECRET,
            },
            body: JSON.stringify({
              reservationKey: blob.key,
              captionIndex: 0,
              secret: process.env.LUMI_SECRET,
            }),
          });

          if (res.ok) {
            autoPosted++;
            console.log(`[scheduler] 자동 게시 완료: ${blob.key}`);
          } else {
            const errBody = await res.text();
            console.error(`[scheduler] 자동 게시 실패: ${blob.key}, ${res.status}, ${errBody}`);
          }
        }

      } catch (e) {
        console.error('[scheduler] 항목 처리 오류:', blob.key, e.message);
      }
    }

    console.log(`[scheduler] 완료: 처리 ${processed}건, 자동게시 ${autoPosted}건`);
    return { statusCode: 200 };

  } catch (err) {
    console.error('[scheduler] 치명적 오류:', err.message);
    return { statusCode: 500 };
  }
};

module.exports.config = {
  schedule: '*/5 * * * *',
};
