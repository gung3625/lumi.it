const busboy = require('busboy');

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
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
  if (!MAKE_WEBHOOK_URL) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Webhook URL이 설정되지 않았습니다.' }) };
  }

  const headers = event.headers;
  const isBase64Encoded = event.isBase64Encoded;
  const bodyBuffer = Buffer.from(event.body, isBase64Encoded ? 'base64' : 'utf8');

  return new Promise((resolve) => {
    const bb = busboy({ headers });
    const fields = {};
    const photos = [];

    bb.on('file', (name, file, info) => {
      const chunks = [];
      file.on('data', (d) => chunks.push(d));
      file.on('end', () => {
        photos.push({
          fieldName: name,
          fileName: info.filename,
          mimeType: info.mimeType,
          buffer: Buffer.concat(chunks)
        });
      });
    });

    bb.on('field', (name, val) => { fields[name] = val; });

    bb.on('finish', async () => {
      if (photos.length === 0) {
        return resolve({ statusCode: 400, body: JSON.stringify({ error: '사진이 없습니다.' }) });
      }

      try {
        let weather = {};
        let trends = [];
        let storeProfile = {};
        try { weather = JSON.parse(fields.weather || '{}'); } catch(e) {}
        try { trends = JSON.parse(fields.trends || '[]'); } catch(e) {}
        try { storeProfile = JSON.parse(fields.storeProfile || '{}'); } catch(e) {}

        const textFields = {
          photoCount: String(photos.length),
          userMessage: fields.userMessage || '',
          bizCategory: fields.bizCategory || 'cafe',
          captionTone: fields.captionTone || '',
          tagStyle: fields.tagStyle || 'mid',
          weather: JSON.stringify(weather),
          trends: JSON.stringify(trends),
          storeProfile: JSON.stringify(storeProfile),
          submittedAt: fields.submittedAt || new Date().toISOString(),
          ...(fields.scheduledAt ? { scheduledAt: fields.scheduledAt } : {})
        };

        // Make {{1.files.files}} 형식에 맞게 fieldName을 'files'로 통일
        const filesForMake = photos.map(p => ({
          fieldName: 'files',
          fileName: p.fileName,
          mimeType: p.mimeType,
          buffer: p.buffer
        }));

        const { body, contentType } = buildMultipart(textFields, filesForMake);

        const res = await fetch(MAKE_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': contentType },
          body
        });

        if (!res.ok) {
          console.error('Make webhook error:', res.status);
          return resolve({ statusCode: 500, body: JSON.stringify({ error: 'Make 웹훅 전송 실패' }) });
        }

        resolve({
          statusCode: 200,
          body: JSON.stringify({ success: true, photoCount: photos.length, scheduledAt: fields.scheduledAt || null })
        });

      } catch (err) {
        console.error('reserve error:', err);
        resolve({ statusCode: 500, body: JSON.stringify({ error: '처리 중 오류가 발생했습니다.' }) });
      }
    });

    bb.end(bodyBuffer);
  });
};
