const { getStore } = require('@netlify/blobs');
const FormData = require('form-data');

exports.handler = async (event) => {
  const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
  if (!MAKE_WEBHOOK_URL) {
    console.error('MAKE_WEBHOOK_URL 환경변수가 없습니다.');
    return { statusCode: 500 };
  }

  try {
    const store = getStore({
      name: 'reservations',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN
    });

    const now = new Date();
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
        if (item.isSent) continue;
        if (!item.scheduledAt) continue;

        const scheduledAt = new Date(item.scheduledAt);
        if (scheduledAt > now) continue;

        // multipart/form-data로 Make에 전송 (원본 파일)
        const form = new FormData();

        item.photos.forEach((p, i) => {
          const buffer = Buffer.from(p.base64, 'base64');
          form.append(`photo_${i}`, buffer, {
            filename: p.fileName,
            contentType: p.mimeType
          });
        });

        form.append('photoCount', String(item.photos.length));
        form.append('userMessage', item.userMessage || '');
        form.append('bizCategory', item.bizCategory || 'cafe');
        form.append('captionTone', item.captionTone || '');
        form.append('tagStyle', item.tagStyle || 'mid');
        form.append('weather', JSON.stringify(item.weather || {}));
        form.append('trends', JSON.stringify(item.trends || []));
        form.append('storeProfile', JSON.stringify(item.storeProfile || {}));
        form.append('submittedAt', item.submittedAt || '');
        form.append('scheduledAt', item.scheduledAt || '');

        const res = await fetch(MAKE_WEBHOOK_URL, {
          method: 'POST',
          body: form,
          headers: form.getHeaders()
        });

        if (res.ok) {
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

module.exports.config = {
  schedule: '*/5 * * * *'
};
