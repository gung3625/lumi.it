const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
  if (!MAKE_WEBHOOK_URL) {
    console.error('MAKE_WEBHOOK_URL 환경변수가 없습니다.');
    return { statusCode: 500 };
  }

  try {
    const store = getStore('reservations');
    const now = new Date();

    // 예약된 게시물 목록 조회
    let list;
    try {
      list = await store.list({ prefix: 'reserve:' });
    } catch(e) {
      console.log('예약 목록 없음:', e.message);
      return { statusCode: 200 };
    }

    if (!list.blobs || list.blobs.length === 0) {
      return { statusCode: 200 };
    }

    let sent = 0;

    for (const blob of list.blobs) {
      try {
        const raw = await store.get(blob.key);
        if (!raw) continue;

        const item = JSON.parse(raw);

        // 이미 전송됐으면 스킵
        if (item.isSent) continue;

        // 예약 시간 확인
        if (!item.scheduledAt) continue;
        const scheduledAt = new Date(item.scheduledAt);
        if (scheduledAt > now) continue; // 아직 시간 안 됨

        // Make 웹훅으로 전송
        const res = await fetch(MAKE_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...item,
            sentAt: now.toISOString()
          })
        });

        if (res.ok) {
          // 전송 완료 표시
          item.isSent = true;
          item.sentAt = now.toISOString();
          await store.set(blob.key, JSON.stringify(item));
          sent++;
          console.log('예약 게시 전송 완료:', blob.key);
        } else {
          console.error('Make 웹훅 전송 실패:', blob.key, res.status);
        }
      } catch(e) {
        console.error('항목 처리 오류:', blob.key, e.message);
      }
    }

    console.log(`스케줄러 완료: ${sent}건 전송`);
    return { statusCode: 200 };

  } catch (err) {
    console.error('scheduler error:', err.message);
    return { statusCode: 500 };
  }
};

// 매 5분마다 실행 (1분은 너무 잦음)
module.exports.config = {
  schedule: '*/5 * * * *'
};
