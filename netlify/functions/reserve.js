const busboy = require('busboy');
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
        const fileData = {
          fieldName: name,
          fileName: info.filename,
          mimeType: info.mimeType,
          buffer: Buffer.concat(chunks)
        };
        photos.push(fileData);
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
        let festivals = [];
        try { weather = JSON.parse(fields.weather || '{}'); } catch(e) {}
        try { trends = JSON.parse(fields.trends || '[]'); } catch(e) {}
        try { storeProfile = JSON.parse(fields.storeProfile || '{}'); } catch(e) {}
        try { airQuality = JSON.parse(fields.airQuality || '{}'); } catch(e) {}
        try { festivals = JSON.parse(fields.festivals || '[]'); } catch(e) {}

        // 초미세먼지(PM2.5) 등급만 사용
        function getPm25Grade(v) {
          const val = parseInt(v);
          if (isNaN(val)) return '알 수 없음';
          if (val <= 15) return '좋음';
          if (val <= 35) return '보통';
          if (val <= 75) return '나쁨';
          return '매우 나쁨';
        }
        const airGrade = airQuality.pm25Grade || (airQuality.pm25Value ? getPm25Grade(airQuality.pm25Value) : '알 수 없음');

        // Blob에서 ig 토큰 조회
        // ig-oauth.js는 email-ig:이메일 → igUserId, ig:igUserId → 토큰 구조로 저장
        let igUserId = '';
        let igAccessToken = '';   // 장기 유저 토큰
        let igPageAccessToken = ''; // 페이지 액세스 토큰 (게시에 필요)
        let toneLikes = [];
        let toneDislikes = [];
        let customCaptionsStr = '';
        if (storeProfile.ownerEmail) {
          try {
            const blobStore = getStore({
              name: 'users',
              siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
              token: process.env.NETLIFY_TOKEN
            });
            // 1. email-ig:이메일 → igUserId
            let igUserIdRaw;
            try { igUserIdRaw = await blobStore.get('email-ig:' + storeProfile.ownerEmail); } catch { igUserIdRaw = null; }

            // fallback: user:이메일 에서 igUserId 조회
            if (!igUserIdRaw) {
              const userRaw = await blobStore.get('user:' + storeProfile.ownerEmail);
              if (userRaw) {
                const userData = JSON.parse(userRaw);
                igUserId = userData.igUserId || '';
              }
            } else {
              igUserId = igUserIdRaw.trim();
            }

            // tone-like / tone-dislike 조회
            try {
              const likeRaw = await blobStore.get('tone-like:' + storeProfile.ownerEmail);
              if (likeRaw) toneLikes = JSON.parse(likeRaw);
            } catch {}
            try {
              const dislikeRaw = await blobStore.get('tone-dislike:' + storeProfile.ownerEmail);
              if (dislikeRaw) toneDislikes = JSON.parse(dislikeRaw);
            } catch {}

            // 커스텀 캡션 샘플 조회
            try {
              const userDataRaw = await blobStore.get('user:' + storeProfile.ownerEmail);
              if (userDataRaw) {
                const userData = JSON.parse(userDataRaw);
                const captions = userData.customCaptions || [];
                customCaptionsStr = captions.filter(c => c && c.trim()).join('|||');
              }
            } catch {}

            // 2. ig:igUserId → 토큰 정보
            if (igUserId) {
              const igRaw = await blobStore.get('ig:' + igUserId);
              if (igRaw) {
                const igData = JSON.parse(igRaw);
                igAccessToken = igData.accessToken || '';
                igPageAccessToken = igData.pageAccessToken || igData.accessToken || '';
              }
            }
          } catch(e) {
            console.error('[reserve] ig 토큰 조회 실패:', e.message);
          }
        }

        // 사진을 Blobs에 업로드하고 URL 생성 (GPT Vision용)
        const imageUrls = [];
        const imageKeys = [];
        try {
          const imgStore = getStore({
            name: 'images',
            siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
            token: process.env.NETLIFY_TOKEN
          });
          for (let i = 0; i < photos.length; i++) {
            const p = photos[i];
            const key = `temp/${Date.now()}_${i}_${p.fileName}`;
            await imgStore.set(key, p.buffer, { metadata: { contentType: p.mimeType } });
            imageKeys.push(key);
            // Netlify Blobs 공개 URL
            const siteId = process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc';
            const url = `https://blob.core.tmp.netlify.app/${siteId}/images/${encodeURIComponent(key)}`;
            imageUrls.push(url);
          }
        } catch(e) {
          console.error('[reserve] 이미지 Blobs 업로드 실패:', e.message);
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

          weatherLocation: weather.locationName || '',

          // 대기오염 등급 (PM10, PM25 중 더 나쁜 등급 하나)
          airQuality: airGrade,

          // 주변 행사 정보
          nearbyFestivals: festivals.length > 0
            ? festivals.map(f => `${f.title}(${f.startDate}~${f.endDate}, ${f.addr}${f.dist ? ', ' + f.dist + 'km' : ''})`).join(' / ')
            : '',
          hasFestival: festivals.length > 0 ? 'true' : 'false',
          festivalCount: String(festivals.length),

          // 트렌드 (문자열)
          trends: Array.isArray(trends) ? trends.join(', ') : '',

          // 매장 프로필 (개별 필드)
          storeName: storeProfile.name || '',
          storeDescription: storeProfile.description || '',
          storeInstagram: storeProfile.instagram || '',
          storeRegion: storeProfile.region || '',
          storeSido: storeProfile.sido || '',
          storeSigungu: storeProfile.sigungu || '',
          storeCategory: fields.bizCategory || storeProfile.category || '',
          ownerName: storeProfile.ownerName || '',
          ownerEmail: storeProfile.ownerEmail || '',

          // GPT Vision용 이미지 URL (Blobs)
          imageUrls: imageUrls.join(','),
          imageUrl1: imageUrls[0] || '',
          imageUrl2: imageUrls[1] || '',
          imageUrl3: imageUrls[2] || '',

          // 말투 학습 데이터
          toneLikes: toneLikes.length > 0 ? toneLikes.map(t => t.caption).join('|||') : '',
          toneDislikes: toneDislikes.length > 0 ? toneDislikes.map(t => t.caption).join('|||') : '',

          customCaptions: customCaptionsStr,
          autoStory: fields.autoStory || 'false',

          // Instagram 게시용 토큰 정보
          igUserId: igUserId,
          igAccessToken: igAccessToken,
          igPageAccessToken: igPageAccessToken
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

        // Make.com 전송 완료 후 임시 이미지 Blobs에서 즉시 삭제
        try {
          const imgStore2 = getStore({
            name: 'images',
            siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
            token: process.env.NETLIFY_TOKEN
          });
          for (const key of (imageKeys || [])) {
            await imgStore2.delete(key);
          }
          console.log('[reserve] 임시 이미지 삭제 완료:', (imageKeys || []).length, '개');
        } catch(e) {
          console.error('[reserve] 임시 이미지 삭제 실패:', e.message);
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
