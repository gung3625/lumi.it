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
        let airQuality = {};
        try { weather = JSON.parse(fields.weather || '{}'); } catch(e) {}
        try { trends = JSON.parse(fields.trends || '[]'); } catch(e) {}
        try { storeProfile = JSON.parse(fields.storeProfile || '{}'); } catch(e) {}
        try { airQuality = JSON.parse(fields.airQuality || '{}'); } catch(e) {}

        // 대기오염 등급 계산
        function getPm10Level(v) {
          const val = parseInt(v);
          if (isNaN(val)) return '알 수 없음';
          if (val <= 30)  return '매우 좋음 — 야외 활동하기 딱 좋은 날이에요';
          if (val <= 80)  return '보통 — 일반적인 야외 활동에 문제없어요';
          if (val <= 150) return '나쁨 — 미세먼지가 있어요. 실내 분위기를 강조해보세요';
          return '매우 나쁨 — 미세먼지가 심해요. 실내에서 즐기는 메뉴를 추천해보세요';
        }
        function getPm25Level(v) {
          const val = parseInt(v);
          if (isNaN(val)) return '알 수 없음';
          if (val <= 15)  return '매우 좋음 — 공기가 깨끗한 날이에요';
          if (val <= 35)  return '보통 — 초미세먼지 큰 문제 없어요';
          if (val <= 75)  return '나쁨 — 초미세먼지가 있어요';
          return '매우 나쁨 — 초미세먼지가 심해요';
        }

        const textFields = {
          // 기본 정보
          photoCount: String(photos.length),
          userMessage: fields.userMessage || '',
          bizCategory: fields.bizCategory || 'cafe',
          captionTone: fields.captionTone || '',
          tagStyle: fields.tagStyle || 'mid',
          submittedAt: fields.submittedAt || new Date().toISOString(),
          ...(fields.scheduledAt ? { scheduledAt: fields.scheduledAt } : {}),

          // 날씨 (개별 필드)
          weatherStatus: weather.status || '',
          weatherTemperature: (weather.temperature !== undefined && weather.temperature !== null && weather.temperature !== '' && weather.temperature !== 'null') ? String(weather.temperature) : '',
          weatherState: weather.state || '',
          weatherGuide: weather.guide || '',
          weatherMood: weather.mood || '',
          weatherLocation: weather.locationName || '',

          // 대기오염 등급 (Make 캡션 생성에 활용)
          airPm10Grade: airQuality.pm10Grade || '',
          airPm10Level: airQuality.pm10Value ? getPm10Level(airQuality.pm10Value) : '알 수 없음',
          airPm25Grade: airQuality.pm25Grade || '',
          airPm25Level: airQuality.pm25Value ? getPm25Level(airQuality.pm25Value) : '알 수 없음',

          // 트렌드 (문자열)
          trends: Array.isArray(trends) ? trends.join(', ') : '',

          // 매장 프로필 (개별 필드)
          storeName: storeProfile.name || '',
          storeDescription: storeProfile.description || '',
          storeInstagram: storeProfile.instagram || '',
          storeRegion: storeProfile.region || '',
          storeCategory: fields.bizCategory || storeProfile.category || '',
          ownerName: storeProfile.ownerName || '',
          ownerEmail: storeProfile.ownerEmail || ''
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
