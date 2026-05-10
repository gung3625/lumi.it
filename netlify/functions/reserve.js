// 예약 생성 — Supabase DB + Storage 기반
// - 이미지: Supabase Storage `lumi-images` 버킷에 업로드 (10MB 제한, JPEG/PNG/WebP)
// - 예약 레코드: public.reservations insert
// - IG 토큰: public.ig_accounts_decrypted 뷰 조회 (service_role)
// - 처리 완료 후 process-and-post-background 트리거
const crypto = require('crypto');
const busboy = require('busboy');
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');

const CORS = {
  'Access-Control-Allow-Origin': 'https://lumi.it.kr',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const BUCKET = 'lumi-images';
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// 초미세먼지(PM2.5) 등급 계산
function getPm25Grade(v) {
  const val = parseInt(v);
  if (isNaN(val)) return '알 수 없음';
  if (val <= 15) return '좋음';
  if (val <= 35) return '보통';
  if (val <= 75) return '나쁨';
  return '매우 나쁨';
}

function contentTypeToExt(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Supabase Bearer 토큰 검증
  const token = extractBearerToken(event);
  if (!token) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '로그인이 필요합니다.' }) };
  }
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    console.warn('[reserve] 토큰 검증 실패');
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증에 실패했습니다.' }) };
  }

  const headers = event.headers;
  const isBase64Encoded = event.isBase64Encoded;
  const bodyBuffer = Buffer.from(event.body, isBase64Encoded ? 'base64' : 'utf8');

  return new Promise((resolve) => {
    const bb = busboy({ headers, limits: { fileSize: MAX_BYTES } });
    const fields = {};
    const photos = [];
    let oversize = false;

    bb.on('file', (name, file, info) => {
      if (!ALLOWED_MIME.includes(info.mimeType)) {
        file.resume();
        return;
      }
      const chunks = [];
      let truncated = false;
      file.on('data', (d) => chunks.push(d));
      file.on('limit', () => { truncated = true; oversize = true; });
      file.on('end', () => {
        if (truncated) return; // 10MB 초과는 버림 → 전체 요청 거부 처리
        const fileData = {
          fieldName: name,
          fileName: info.filename,
          mimeType: info.mimeType,
          buffer: Buffer.concat(chunks),
        };
        // thumbnailFile은 스토리용 별도 — photos 배열에서 제외
        if (name !== 'thumbnailFile') {
          photos.push(fileData);
        }
      });
    });

    bb.on('field', (name, val) => { fields[name] = val; });

    bb.on('finish', async () => {
      if (oversize) {
        return resolve({ statusCode: 413, headers: CORS, body: JSON.stringify({ error: '이미지 한 장당 10MB를 초과할 수 없습니다.' }) });
      }

      // mediaType 분기 (기본 IMAGE)
      const mediaType = (fields.mediaType === 'REELS') ? 'REELS' : 'IMAGE';
      const videoUrl = fields.videoUrl || '';
      const videoKey = fields.videoKey || '';

      if (mediaType === 'REELS') {
        if (!videoUrl) {
          return resolve({ statusCode: 400, headers: CORS, body: JSON.stringify({ error: '영상 URL이 필요합니다' }) });
        }
        if (photos.length === 0) {
          return resolve({ statusCode: 400, headers: CORS, body: JSON.stringify({ error: '프레임 이미지가 필요합니다' }) });
        }
      } else if (photos.length === 0) {
        return resolve({ statusCode: 400, headers: CORS, body: JSON.stringify({ error: '사진이 없습니다.' }) });
      }

      const supabase = getAdminClient();

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

        const airGrade = airQuality.pm25Grade || (airQuality.pm25Value ? getPm25Grade(airQuality.pm25Value) : '알 수 없음');

        // IG 계정/토큰 조회 (public.ig_accounts + ig_accounts_decrypted 뷰)
        let igUserId = '';
        let igAccessToken = '';
        let igPageAccessToken = '';
        try {
          const { data: igRow, error: igErr } = await supabase
            .from('ig_accounts')
            .select('ig_user_id')
            .eq('user_id', user.id)
            .maybeSingle();
          if (igErr) {
            console.error('[reserve] ig_accounts 조회 오류:', igErr.message);
          } else if (igRow && igRow.ig_user_id) {
            igUserId = igRow.ig_user_id;
            const { data: dec, error: decErr } = await supabase
              .from('ig_accounts_decrypted')
              .select('access_token, page_access_token')
              .eq('ig_user_id', igUserId)
              .maybeSingle();
            if (decErr) {
              console.error('[reserve] ig_accounts_decrypted 조회 오류:', decErr.message);
            } else if (dec) {
              igAccessToken = dec.access_token || '';
              igPageAccessToken = dec.page_access_token || dec.access_token || '';
            }
          }
        } catch (e) {
          console.error('[reserve] IG 토큰 조회 실패:', e.message);
        }

        // 말투 학습 피드백(like/dislike) 조회 — 최근 20개 롤링 윈도우
        let toneLikes = [];
        let toneDislikes = [];
        try {
          const { data: likeRows } = await supabase
            .from('tone_feedback')
            .select('caption')
            .eq('user_id', user.id).eq('kind', 'like')
            .order('created_at', { ascending: false })
            .limit(20);
          const { data: dislikeRows } = await supabase
            .from('tone_feedback')
            .select('caption')
            .eq('user_id', user.id).eq('kind', 'dislike')
            .order('created_at', { ascending: false })
            .limit(20);
          toneLikes = Array.isArray(likeRows) ? likeRows : [];
          toneDislikes = Array.isArray(dislikeRows) ? dislikeRows : [];
        } catch (e) {
          console.error('[reserve] tone_feedback 조회 실패:', e.message);
        }

        // 유저 프로필(custom_captions) 조회
        // custom_captions 는 옛 멀티마켓 features. 현재 미사용.
        const customCaptionsStr = '';

        // 릴레이 모드 폐지됨 — 항상 true (캡션 확인 후 바로 게시)
        const relayMode = true;

        const reserveKey = `reserve:${Date.now()}`;

        // Storage 업로드 — 병렬 처리 (Promise.all). 사진 N장 직렬 → 동시 업로드로
        // 함수 응답시간 N배 단축. 경로: {user_id}/{reserveKey}/{ts}-{nonce}.ext.
        let imageUrls = [];
        let imageKeys = [];
        let uploadedPaths = [];
        try {
          const ts = Date.now();
          const tasks = photos.map(async (p) => {
            const nonce = crypto.randomBytes(8).toString('hex');
            const ext = contentTypeToExt(p.mimeType);
            const path = `${user.id}/${reserveKey}/${ts}-${nonce}.${ext}`;
            const { error: upErr } = await supabase.storage
              .from(BUCKET)
              .upload(path, p.buffer, { contentType: p.mimeType, upsert: false });
            if (upErr) throw new Error(`이미지 업로드 실패: ${upErr.message}`);
            const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
            return { path, url: (pub && pub.publicUrl) || '' };
          });
          const results = await Promise.all(tasks);
          imageUrls = results.map(r => r.url);
          imageKeys = results.map(r => r.path);
          uploadedPaths = results.map(r => r.path);
        } catch (uploadErr) {
          // 롤백: 부분 업로드된 파일 제거 (best-effort) — Promise.all 실패 시
          //        성공한 path 정보가 결과에서 사라지므로 prefix 단위로 정리.
          try {
            const prefix = `${user.id}/${reserveKey}/`;
            const { data: list } = await supabase.storage.from(BUCKET).list(prefix);
            const orphans = (list || []).map(f => prefix + f.name);
            if (orphans.length) await supabase.storage.from(BUCKET).remove(orphans);
          } catch (e) { console.error('[reserve] 롤백 실패:', e.message); }
          console.error('[reserve] 업로드 중 오류:', uploadErr.message);
          return resolve({ statusCode: 500, headers: CORS, body: JSON.stringify({ error: '이미지 업로드에 실패했습니다.' }) });
        }

        const postMode = fields.postMode || 'immediate';
        const scheduledAt = fields.scheduledAt || new Date().toISOString();
        const submittedAt = fields.submittedAt || new Date().toISOString();

        // (옛 public.users FK 보장용 upsert 는 sellers 로 FK 재지정 후 불필요해서 제거)

        // reservations insert
        const reservationRow = {
          reserve_key: reserveKey,
          user_id: user.id,
          user_message: fields.userMessage || '',
          biz_category: fields.bizCategory || 'cafe',
          caption_tone: fields.captionTone || '',
          tag_style: fields.tagStyle || 'mid',
          weather: { ...weather, airQuality: airGrade },
          trends: Array.isArray(trends) ? trends : [],
          store_profile: storeProfile,
          post_mode: (postMode === 'scheduled' || postMode === 'best-time') ? postMode : 'immediate',
          scheduled_at: scheduledAt,
          submitted_at: submittedAt,
          story_enabled: fields.postToStory === 'true',
          post_to_thread: fields.postToThread === 'true',
          nearby_event: festivals.length > 0,
          nearby_festivals: festivals.length > 0
            ? festivals.map(f => `${f.title}(${f.startDate}~${f.endDate}, ${f.addr}${f.dist ? ', ' + f.dist + 'km' : ''})`).join(' / ')
            : '',
          tone_likes: toneLikes.length > 0 ? toneLikes.map(t => t.caption).join('|||') : '',
          tone_dislikes: toneDislikes.length > 0 ? toneDislikes.map(t => t.caption).join('|||') : '',
          custom_captions: customCaptionsStr,
          relay_mode: relayMode,
          use_weather: fields.useWeather !== 'false',
          is_sent: false,
          caption_status: 'pending',
          image_urls: imageUrls,
          image_keys: imageKeys,
          media_type: mediaType,
          video_url: mediaType === 'REELS' ? videoUrl : null,
          video_key: mediaType === 'REELS' ? (videoKey || null) : null,
          frame_urls: mediaType === 'REELS' ? imageUrls : [],
        };

        const { error: insertErr } = await supabase.from('reservations').insert(reservationRow);
        if (insertErr) {
          console.error('[reserve] reservations insert 오류:', insertErr.message);
          // 롤백: Storage 업로드 제거 (best-effort)
          try { await supabase.storage.from(BUCKET).remove(uploadedPaths); }
          catch (e) { console.error('[reserve] 롤백 실패:', e.message); }
          return resolve({ statusCode: 500, headers: CORS, body: JSON.stringify({ error: '예약 저장에 실패했습니다.' }) });
        }

        if (mediaType === 'REELS') {
          console.log('[reserve] REELS 예약 생성', { reservationKey: reserveKey, hasVideo: !!videoUrl, frameCount: imageUrls.length });
        } else {
          console.log('[reserve] 예약 저장 완료:', reserveKey, '사진:', imageUrls.length, '장');
        }

        // 캡션 생성 Background Function 트리거 (postMode 무관하게 항상 캡션 생성)
        const siteUrl = 'https://lumi.it.kr';
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

        // 응답: reservationKey(기존 프론트 호환) + reserveKey(신규 스펙)
        resolve({
          statusCode: 200,
          headers: CORS,
          body: JSON.stringify({
            success: true,
            reserveKey,
            reservationKey: reserveKey,
            photoCount: photos.length,
          }),
        });

      } catch (err) {
        console.error('[reserve] error:', err.message);
        resolve({ statusCode: 500, headers: CORS, body: JSON.stringify({ error: '처리 중 오류가 발생했습니다.' }) });
      }
    });

    bb.on('error', (err) => {
      console.error('[reserve] busboy error:', err.message);
      resolve({ statusCode: 400, headers: CORS, body: JSON.stringify({ error: '요청 형식이 올바르지 않습니다.' }) });
    });

    bb.end(bodyBuffer);
  });
};
