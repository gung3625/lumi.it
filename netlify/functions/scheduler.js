const { getStore } = require('@netlify/blobs');

function buildMultipart(fields, files) {
  const boundary = '----LumiBoundary' + Date.now().toString(16);
  const buffers = [];

  for (const [name, value] of Object.entries(fields)) {
    buffers.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      'utf8'
    ));
  }

  for (const file of files) {
    buffers.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.fileName}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`,
      'utf8'
    ));
    buffers.push(file.buffer);
    buffers.push(Buffer.from('\r\n', 'utf8'));
  }

  buffers.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    body: Buffer.concat(buffers),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

exports.handler = async (event) => {
  const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
  if (!MAKE_WEBHOOK_URL) {
    console.error('MAKE_WEBHOOK_URL 없음');
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
    try { list = await store.list({ prefix: 'reserve:' }); } catch(e) {
      console.log('예약 목록 없음:', e.message);
      return { statusCode: 200 };
    }

    if (!list.blobs || list.blobs.length === 0) return { statusCode: 200 };

    let sent = 0;

    for (const blob of list.blobs) {
      try {
        const raw = await store.get(blob.key);
        if (!raw) continue;
        const item = JSON.parse(raw);
        if (item.isSent) continue;
        if (!item.scheduledAt) continue;
        if (new Date(item.scheduledAt) > now) continue;

        const w = item.weather || {};
        const sp = item.storeProfile || {};
        const textFields = {
          // 기본 정보
          photoCount: String(item.photos.length),
          userMessage: item.userMessage || '',
          bizCategory: item.bizCategory || 'cafe',
          captionTone: item.captionTone || '',
          tagStyle: item.tagStyle || 'mid',
          submittedAt: item.submittedAt || '',
          scheduledAt: item.scheduledAt || '',

          // 날씨 (개별 필드)
          weatherStatus: w.status || '',
          weatherTemperature: String(w.temperature || ''),
          weatherState: w.state || '',
          weatherGuide: w.guide || '',
          weatherMood: w.mood || '',
          weatherLocation: w.locationName || '',

          // 트렌드 (문자열)
          trends: Array.isArray(item.trends) ? item.trends.join(', ') : '',

          // 매장 프로필 (개별 필드)
          storeName: sp.name || '',
          storeDescription: sp.description || '',
          storeInstagram: sp.instagram || '',
          storeRegion: sp.region || '',
          storeCategory: sp.category || '',
          storeToneStyle: sp.toneStyle || '',
          storeTagStyle: sp.tagStyle || '',
          ownerName: sp.ownerName || '',
          ownerEmail: sp.ownerEmail || ''
        };

        // Make {{1.files.files}} 형식에 맞게 fieldName을 'files'로 통일
        const files = item.photos.map((p) => ({
          fieldName: 'files',
          fileName: p.fileName,
          mimeType: p.mimeType,
          buffer: Buffer.from(p.base64, 'base64')
        }));

        const { body, contentType } = buildMultipart(textFields, files);

        const res = await fetch(MAKE_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': contentType },
          body
        });

        if (res.ok) {
          item.isSent = true;
          item.sentAt = now.toISOString();
          await store.set(blob.key, JSON.stringify(item));
          sent++;
          console.log('예약 전송 완료:', blob.key);
        } else {
          console.error('Make 전송 실패:', blob.key, res.status);
        }
      } catch(e) {
        console.error('항목 오류:', blob.key, e.message);
      }
    }

    console.log(`스케줄러 완료: ${sent}건`);
    return { statusCode: 200 };

  } catch (err) {
    console.error('scheduler error:', err.message);
    return { statusCode: 500 };
  }
};

module.exports.config = {
  schedule: '*/5 * * * *'
};
