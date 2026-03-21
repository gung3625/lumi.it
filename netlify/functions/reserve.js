const busboy = require('busboy');

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
    const photos = []; // 여러 장 사진 처리

    bb.on('file', (name, file, info) => {
      const chunks = [];
      file.on('data', (d) => chunks.push(d));
      file.on('end', () => {
        const buffer = Buffer.concat(chunks);
        photos.push({
          fieldName: name,
          fileName: info.filename,
          mimeType: info.mimeType,
          base64: buffer.toString('base64')
        });
      });
    });

    bb.on('field', (name, val) => {
      fields[name] = val;
    });

    bb.on('finish', async () => {
      if (photos.length === 0) {
        return resolve({ statusCode: 400, body: JSON.stringify({ error: '사진이 없습니다.' }) });
      }

      try {
        // 텍스트 데이터 파싱
        let weather = {};
        let trends = [];
        let storeProfile = {};

        try { weather = JSON.parse(fields.weather || '{}'); } catch(e) {}
        try { trends = JSON.parse(fields.trends || '[]'); } catch(e) {}
        try { storeProfile = JSON.parse(fields.storeProfile || '{}'); } catch(e) {}

        // Make 웹훅으로 전송할 페이로드
        const payload = {
          // 사진 데이터 (1장~10장)
          photos: photos.map(p => ({
            name: p.fileName,
            mimeType: p.mimeType,
            base64: p.base64
          })),
          photoCount: photos.length,

          // 사용자 메모
          userMessage: fields.userMessage || '',

          // 업종 및 스타일
          bizCategory: fields.bizCategory || 'cafe',
          captionTone: fields.captionTone || 'warm',
          tagStyle: fields.tagStyle || 'mid',

          // 날씨 (실시간)
          weather,

          // 트렌드 태그 (실시간)
          trends,

          // 매장 프로필
          storeProfile,

          // 시간 정보
          submittedAt: fields.submittedAt || new Date().toISOString(),
          scheduledAt: fields.scheduledAt || null
        };

        // Make 웹훅 전송
        const res = await fetch(MAKE_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!res.ok) {
          console.error('Make webhook error:', res.status);
          return resolve({
            statusCode: 500,
            body: JSON.stringify({ error: 'Make 웹훅 전송 실패' })
          });
        }

        resolve({
          statusCode: 200,
          body: JSON.stringify({
            success: true,
            photoCount: photos.length,
            scheduledAt: payload.scheduledAt
          })
        });

      } catch (err) {
        console.error('reserve error:', err);
        resolve({
          statusCode: 500,
          body: JSON.stringify({ error: '처리 중 오류가 발생했습니다.' })
        });
      }
    });

    bb.end(bodyBuffer);
  });
};
