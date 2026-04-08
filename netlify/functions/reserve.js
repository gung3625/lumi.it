const busboy = require('busboy');
const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // 인증: Bearer 토큰 또는 LUMI_SECRET
  const authHeader = event.headers['authorization'] || '';
  const lumiSecret = event.headers['x-lumi-secret'] || '';
  if (!authHeader.startsWith('Bearer ') && lumiSecret !== process.env.LUMI_SECRET) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
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
        // thumbnailFile은 스토리용 별도 파일 - photos 배열에서 제외
        if (name !== 'thumbnailFile') {
          photos.push(fileData);
        }
      });
    });

    bb.on('field', (name, val) => { fields[name] = val; });

    bb.on('finish', async () => {
      if (photos.length === 0) {
        return resolve({ statusCode: 400, headers: CORS, body: JSON.stringify({ error: '사진이 없습니다.' }) });
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
        let relayMode = false;
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

            // 커스텀 캡션 + 릴레이 모드 조회
            try {
              const userDataRaw = await blobStore.get('user:' + storeProfile.ownerEmail);
              if (userDataRaw) {
                const userData = JSON.parse(userDataRaw);
                const captions = userData.customCaptions || [];
                customCaptionsStr = captions.filter(c => c && c.trim()).join('|||');
                relayMode = userData.relayMode === true;
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

        // Blobs에 예약 데이터 저장 (즉시 전송도 예약으로 통합)
        const reserveStore = getStore({
          name: 'reservations',
          consistency: 'strong',
          siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
          token: process.env.NETLIFY_TOKEN,
        });

        const reserveKey = `reserve:${Date.now()}`;
        const reserveData = {
          photos: photos.map(p => ({
            fileName: p.fileName,
            mimeType: p.mimeType,
            base64: p.buffer.toString('base64'),
          })),
          userMessage: fields.userMessage || '',
          bizCategory: fields.bizCategory || 'cafe',
          captionTone: fields.captionTone || '',
          tagStyle: fields.tagStyle || 'mid',
          submittedAt: fields.submittedAt || new Date().toISOString(),
          scheduledAt: fields.scheduledAt || new Date().toISOString(), // 즉시 전송이면 현재 시간
          weather: {
            ...weather,
            airQuality: airGrade,
          },
          trends: Array.isArray(trends) ? trends : [],
          storeProfile: storeProfile,
          storyEnabled: fields.autoStory === 'true',
          nearbyEvent: festivals.length > 0,
          nearbyFestivals: festivals.length > 0
            ? festivals.map(f => `${f.title}(${f.startDate}~${f.endDate}, ${f.addr}${f.dist ? ', ' + f.dist + 'km' : ''})`).join(' / ')
            : '',
          toneLikes: toneLikes.length > 0 ? toneLikes.map(t => t.caption).join('|||') : '',
          toneDislikes: toneDislikes.length > 0 ? toneDislikes.map(t => t.caption).join('|||') : '',
          customCaptions: customCaptionsStr,
          igUserId,
          igAccessToken,
          igPageAccessToken,
          relayMode,
          isSent: false,
        };

        console.log('[reserve] Blobs 저장 시작:', reserveKey, '사진:', reserveData.photos.length, '장');
        await reserveStore.set(reserveKey, JSON.stringify(reserveData));
        console.log('[reserve] 예약 저장 완료:', reserveKey);

        // 즉시 전송: process-and-post Background Function 트리거
        // Background Function 트리거 — await으로 202 응답 확인 후 진행
        // (Function 종료 전에 fetch가 완료돼야 함)
        const siteUrl = 'https://lumi.it.kr';
        console.log('[reserve] process-and-post 트리거 시도:', siteUrl);
        try {
          const ppRes = await fetch(`${siteUrl}/.netlify/functions/process-and-post-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.LUMI_SECRET}` },
            body: JSON.stringify({ reservationKey: reserveKey }),
          });
          console.log('[reserve] process-and-post-background 트리거:', ppRes.status);
        } catch (ppErr) {
          console.error('[reserve] 트리거 실패:', ppErr.message);
        }

        resolve({
          statusCode: 200,
          body: JSON.stringify({ success: true, reservationKey: reserveKey, photoCount: photos.length })
        });

      } catch (err) {
        console.error('reserve error:', err);
        resolve({ statusCode: 500, headers: CORS, body: JSON.stringify({ error: '처리 중 오류가 발생했습니다.' }) });
      }
    });

    bb.end(bodyBuffer);
  });
};
