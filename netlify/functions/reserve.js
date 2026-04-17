const busboy = require('busboy');
const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': 'https://lumi.it.kr',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // 인증: Bearer 토큰 Blobs 검증 또는 LUMI_SECRET
  const authHeader = event.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const lumiSecret = event.headers['x-lumi-secret'] || '';
  if (!bearerToken && lumiSecret !== process.env.LUMI_SECRET) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }
  if (bearerToken && lumiSecret !== process.env.LUMI_SECRET) {
    const userStore = getStore({ name: 'users', consistency: 'strong' });
    let tokenRaw = null;
    for (let i = 0; i < 3; i++) {
      try { tokenRaw = await userStore.get('token:' + bearerToken); } catch(e) { console.error('[reserve] token fetch error:', e.message); }
      if (tokenRaw) break;
      if (i < 2) await new Promise(r => setTimeout(r, 300));
    }
    if (!tokenRaw) {
      console.warn('[reserve] token not found after 3 retries, bearer prefix:', bearerToken.substring(0, 8));
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증 실패' }) };
    }
  }

  const headers = event.headers;
  const isBase64Encoded = event.isBase64Encoded;
  const bodyBuffer = Buffer.from(event.body, isBase64Encoded ? 'base64' : 'utf8');

  return new Promise((resolve) => {
    const bb = busboy({ headers });
    const fields = {};
    const photos = [];

    const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
    bb.on('file', (name, file, info) => {
      if (!ALLOWED_MIME.includes(info.mimeType)) {
        file.resume(); // 스트림 소비 후 무시
        return;
      }
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
              name: 'users'
            });
            // Blob 4개 병렬 읽기 (기존 6개 순차 → 1회 병렬 + 1회 순차)
            const ownerEmail = storeProfile.ownerEmail;
            const [igUserIdRaw, likeRaw, dislikeRaw, userDataRaw] = await Promise.all([
              blobStore.get('email-ig:' + ownerEmail).catch(() => null),
              blobStore.get('tone-like:' + ownerEmail).catch(() => null),
              blobStore.get('tone-dislike:' + ownerEmail).catch(() => null),
              blobStore.get('user:' + ownerEmail).catch(() => null),
            ]);

            // igUserId
            if (igUserIdRaw) {
              igUserId = igUserIdRaw.trim();
            } else if (userDataRaw) {
              igUserId = JSON.parse(userDataRaw).igUserId || '';
            }

            // tone
            if (likeRaw) try { toneLikes = JSON.parse(likeRaw); } catch {}
            if (dislikeRaw) try { toneDislikes = JSON.parse(dislikeRaw); } catch {}

            // customCaptions + relayMode (userDataRaw 재사용)
            if (userDataRaw) {
              try {
                const userData = JSON.parse(userDataRaw);
                const captions = userData.customCaptions || [];
                customCaptionsStr = captions.filter(c => c && c.trim()).join('|||');
                relayMode = userData.relayMode === true;
              } catch {}
            }
            // 릴레이 모드 폐지됨 — 항상 true (캡션 확인 후 바로 게시)
            relayMode = true;

            // ig 토큰 (igUserId 의존이라 순차)
            if (igUserId) {
              const igRaw = await blobStore.get('ig:' + igUserId).catch(() => null);
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
          consistency: 'strong'
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
          postMode: fields.postMode || 'immediate',
          storyEnabled: fields.postToStory === 'true',
          postToThread: fields.postToThread === 'true',
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
          useWeather: fields.useWeather !== 'false',
          isSent: false,
        };

        console.log('[reserve] Blobs 저장 시작:', reserveKey, '사진:', reserveData.photos.length, '장');
        await reserveStore.set(reserveKey, JSON.stringify(reserveData));
        console.log('[reserve] 예약 저장 완료:', reserveKey);

        // per-user 인덱스 업데이트 (best-effort — 실패해도 예약 자체에는 영향 없음)
        const indexOwnerEmail = storeProfile && storeProfile.ownerEmail;
        if (indexOwnerEmail) {
          try {
            const indexKey = 'user-index:' + indexOwnerEmail;
            const existingRaw = await reserveStore.get(indexKey).catch(() => null);
            let indexArr = [];
            if (existingRaw) {
              try {
                const parsed = JSON.parse(existingRaw);
                if (Array.isArray(parsed)) indexArr = parsed;
              } catch {}
            }
            if (!indexArr.includes(reserveKey)) {
              indexArr.push(reserveKey);
              await reserveStore.set(indexKey, JSON.stringify(indexArr));
            }
          } catch (indexErr) {
            console.warn('[reserve] user-index 업데이트 실패:', indexErr.message);
          }
        }

        // 캡션 생성 Background Function 트리거 (postMode 무관하게 항상 캡션 생성)
        const siteUrl = 'https://lumi.it.kr';
        const postMode = reserveData.postMode || 'immediate';
        console.log('[reserve] process-and-post 트리거 시도 (postMode:', postMode, ')');
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
          headers: CORS,
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
