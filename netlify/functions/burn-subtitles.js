const { corsHeaders, getOrigin } = require('./_shared/auth');
// Netlify Function: /api/burn-subtitles
// 내부 호출 전용(LUMI_SECRET) 래퍼.
// Modal endpoint (MODAL_BURN_SUBTITLES_URL) 호출 → 결과 MP4를 Supabase Storage `lumi-videos`에 업로드 → public URL 반환.
// 실패 시 에러만 던지고, 호출자(process-and-post-background.js)가 fallback으로 원본 video_url 유지.

const { getAdminClient } = require('./_shared/supabase-admin');


// 최대 대기: Modal timeout(300s) 여유분 +10초
const MODAL_TIMEOUT_MS = 310_000;

async function callModal(url, body) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), MODAL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { /* keep raw */ }
    if (!res.ok) {
      // 민감정보 없는 범위로만 메시지 추출
      const detail = (data && (data.detail || data.error)) || `status=${res.status}`;
      throw new Error(`Modal 오류: ${String(detail).slice(0, 300)}`);
    }
    if (!data || !data.videoBase64) {
      throw new Error('Modal 응답에 videoBase64 없음');
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
  }

  // 내부 호출 인증
  const auth = (event.headers.authorization || event.headers.Authorization || '').replace('Bearer ', '');
  if (!auth || auth !== process.env.LUMI_SECRET) {
    console.error('[burn-subtitles] 인증 실패');
    return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 실패' }) };
  }

  const modalUrl = process.env.MODAL_BURN_SUBTITLES_URL;
  if (!modalUrl) {
    console.error('[burn-subtitles] MODAL_BURN_SUBTITLES_URL 미설정');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Modal 엔드포인트 미설정' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (_) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON 파싱 실패' }) };
  }

  const { reservationKey, videoUrl, srt, fontSize, position, userId } = payload;
  if (!reservationKey || !videoUrl || !srt) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'reservationKey/videoUrl/srt 필요' }) };
  }

  try {
    // 1) Modal 호출
    const modalBody = { videoUrl, srt };
    if (fontSize) modalBody.fontSize = fontSize;
    if (position) modalBody.position = position;
    console.log('[burn-subtitles] Modal 호출 시작:', reservationKey);
    const t0 = Date.now();
    const data = await callModal(modalUrl, modalBody);
    const elapsedMs = Date.now() - t0;
    console.log('[burn-subtitles] Modal 완료:', reservationKey, 'bytes=', data.sizeBytes, 'dur=', data.durationSec, 'elapsed=', elapsedMs, 'ms');

    // 2) base64 → Buffer
    const buf = Buffer.from(data.videoBase64, 'base64');
    if (!buf.length) throw new Error('디코딩 결과 0 bytes');

    // 3) Supabase Storage 업로드
    const supabase = getAdminClient();

    // reservation 조회하여 user_id 확정 (payload.userId 우선, 없으면 DB 조회)
    let ownerId = userId || null;
    if (!ownerId) {
      const { data: rsv, error: rsvErr } = await supabase
        .from('reservations')
        .select('user_id')
        .eq('reserve_key', reservationKey)
        .maybeSingle();
      if (rsvErr || !rsv) {
        throw new Error('예약 조회 실패');
      }
      ownerId = rsv.user_id;
    }
    if (!ownerId) throw new Error('user_id 확인 불가');

    const ts = Date.now();
    const storagePath = `${ownerId}/${reservationKey}/subtitled-${ts}.mp4`;
    const { error: upErr } = await supabase
      .storage
      .from('lumi-videos')
      .upload(storagePath, buf, {
        contentType: 'video/mp4',
        upsert: false,
        cacheControl: '3600',
      });
    if (upErr) throw new Error(`Supabase 업로드 실패: ${upErr.message}`);

    const { data: pub } = supabase.storage.from('lumi-videos').getPublicUrl(storagePath);
    const publicUrl = pub?.publicUrl;
    if (!publicUrl) throw new Error('public URL 생성 실패');

    console.log('[burn-subtitles] 업로드 완료:', reservationKey, 'path=', storagePath);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        videoUrl: publicUrl,
        storagePath,
        durationSec: data.durationSec || 0,
        sizeBytes: data.sizeBytes || buf.length,
      }),
    };
  } catch (err) {
    console.error('[burn-subtitles] 실패:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || '자막 burn-in 실패' }),
    };
  }
};

exports.headers = headers;
