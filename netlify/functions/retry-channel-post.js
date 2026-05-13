// retry-channel-post.js — 한 채널 실패 시 수동 재시도.
// POST /api/retry-channel-post
// 헤더: Authorization: Bearer <jwt>
// 본문: { reservationId: number|string, channel: 'threads' }
//
// 응답:
//   성공:      { ok: true, postId: '<thread-id>' }
//   토큰 만료: { ok: false, tokenExpired: true }
//   미연동:    { ok: false, error: 'Threads 미연동' }
//   거부:      { ok: false, error: '...' } (status 4xx)
//   서버 오류: { ok: false, error: '...' } (status 5xx)
//
// 정책 (베타):
//   - **Threads only**. IG 실패는 대부분 토큰 만료가 원인 — 재연동 흐름이 정직.
//     향후 carousel/video 까지 포괄하는 IG retry 는 후속.
//   - channel_posts(reservation_id, channel='threads', status='failed') row 가
//     실제로 존재해야 retry 가능. 그 외 상태는 거부.
//   - 성공 시 channel_posts row 를 posted 로 갱신 + credit_consumed=true.
//   - 실패 시 channel_posts.error_message 갱신, status 는 그대로 failed 유지.

'use strict';

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { getAdminClient } = require('./_shared/supabase-admin');
const {
  getThreadsTokenForSeller,
  createThreadsContainer,
  waitForThreadsContainer,
  publishThreadsContainer,
  ThreadsGraphError,
  markThreadsTokenInvalid,
} = require('./_shared/threads-graph');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user || !user.id) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: '인증이 필요합니다.' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: '잘못된 요청 본문' }) };
  }
  const reservationId = body.reservationId;
  const channel = body.channel;
  if (!reservationId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'reservationId 누락' }) };
  }
  if (channel !== 'threads') {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: '현재 Threads 재시도만 지원합니다.' }) };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[retry-channel-post] admin 초기화 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: '서버 오류' }) };
  }

  // 1) reservation 본인 검증 + 게시 정보 조회
  const { data: reservation, error: resErr } = await admin
    .from('reservations')
    .select('id, user_id, image_urls, video_url, media_type, generated_threads_caption, generated_captions, captions')
    .eq('id', reservationId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (resErr) {
    console.error('[retry-channel-post] reservation 조회 실패:', resErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: '예약 조회 실패' }) };
  }
  if (!reservation) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ ok: false, error: '예약을 찾을 수 없습니다.' }) };
  }

  // 2) channel_posts(threads, failed) row 존재 검증
  const { data: cp, error: cpErr } = await admin
    .from('channel_posts')
    .select('reservation_id, channel, status')
    .eq('reservation_id', reservation.id)
    .eq('channel', 'threads')
    .maybeSingle();
  if (cpErr) {
    console.error('[retry-channel-post] channel_posts 조회 실패:', cpErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: '게시 상태 조회 실패' }) };
  }
  if (!cp || cp.status !== 'failed') {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: '재시도 가능한 실패 기록이 없습니다.' }) };
  }

  // 3) Threads 토큰 + 캡션·미디어 준비
  const threadsCtx = await getThreadsTokenForSeller(user.id, admin);
  if (!threadsCtx) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'Threads 연동이 필요합니다.' }) };
  }
  const caption = (reservation.generated_threads_caption && String(reservation.generated_threads_caption).trim())
    || (Array.isArray(reservation.generated_captions) && reservation.generated_captions[0])
    || (Array.isArray(reservation.captions) && reservation.captions[0])
    || '';
  const imageUrl = Array.isArray(reservation.image_urls) && reservation.image_urls.length ? reservation.image_urls[0] : null;
  const videoUrl = reservation.video_url || null;
  if (!imageUrl && !videoUrl) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: '게시할 미디어가 없습니다.' }) };
  }

  // 4) Threads 게시 — postToThreadsForSeller 와 동일 흐름 (container → 폴링 → publish)
  let publishedId = '';
  try {
    const mediaType = videoUrl ? 'VIDEO' : 'IMAGE';
    const created = await createThreadsContainer({
      token: threadsCtx.accessToken,
      threadsUserId: threadsCtx.threadsUserId,
      mediaType,
      imageUrl: videoUrl ? null : imageUrl,
      videoUrl: videoUrl || null,
      text: caption,
    }, { timeoutMs: 60000 });
    if (!created || !created.id) throw new ThreadsGraphError('Threads 컨테이너 생성 응답에 id 없음');
    await waitForThreadsContainer({ token: threadsCtx.accessToken, creationId: created.id });
    const published = await publishThreadsContainer({
      token: threadsCtx.accessToken,
      threadsUserId: threadsCtx.threadsUserId,
      creationId: created.id,
    }, { timeoutMs: 60000 });
    if (!published || !published.id) throw new ThreadsGraphError('Threads publish 응답에 id 없음');
    publishedId = published.id;
  } catch (e) {
    if (e instanceof ThreadsGraphError && e.isTokenExpired()) {
      try { await markThreadsTokenInvalid(admin, user.id, 'retry-channel-post'); } catch (_) { /* noop */ }
      try {
        await admin.from('channel_posts').update({ error_message: 'token_expired' })
          .eq('reservation_id', reservation.id).eq('channel', 'threads');
      } catch (_) { /* noop */ }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, tokenExpired: true }) };
    }
    console.warn('[retry-channel-post] Threads 호출 실패:', e && e.message);
    try {
      await admin.from('channel_posts').update({ error_message: String(e && e.message || 'unknown') })
        .eq('reservation_id', reservation.id).eq('channel', 'threads');
    } catch (_) { /* noop */ }
    const status = (e instanceof ThreadsGraphError && e.status >= 400 && e.status < 500) ? e.status : 502;
    return { statusCode: status, headers: CORS, body: JSON.stringify({ ok: false, error: (e && e.message) || '재시도 실패' }) };
  }

  // 5) 성공 — channel_posts 갱신 (성공 시에만 credit_consumed=true, 결정 §12-A #7)
  try {
    await admin.from('channel_posts').update({
      status:           'posted',
      post_id:          publishedId,
      posted_at:        new Date().toISOString(),
      credit_consumed:  true,
      error_message:    null,
    }).eq('reservation_id', reservation.id).eq('channel', 'threads');
  } catch (e) {
    console.warn('[retry-channel-post] channel_posts 갱신 경고:', e && e.message);
  }

  console.log(`[retry-channel-post] seller=${String(user.id).slice(0,8)} reservation=${reservation.id} threads_post=${publishedId}`);
  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ ok: true, postId: publishedId }),
  };
};
