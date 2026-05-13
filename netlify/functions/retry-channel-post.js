// retry-channel-post.js — 한 채널 실패 시 수동 재시도 (IG / Threads).
// POST /api/retry-channel-post
// 헤더: Authorization: Bearer <jwt>
// 본문: { reservationId: number|string, channel: 'ig' | 'threads' }
//
// 응답:
//   성공:      { ok: true, postId: '<id>', channel }
//   토큰 만료: { ok: false, tokenExpired: true, channel }
//   미연동:    { ok: false, error: '...', channel }
//   거부:      { ok: false, error: '...', channel } (status 4xx)
//   서버 오류: { ok: false, error: '...', channel } (status 5xx)
//
// 정책:
//   - channel_posts(reservation_id, channel, status='failed') row 존재 시에만
//     retry 가능. 그 외 상태는 거부.
//   - 성공 시 channel_posts(posted, post_id, posted_at, credit_consumed=true,
//     error_message=null) 갱신 — 결정 §12-A #7.
//   - 실패 시 error_message 만 갱신, status 는 failed 유지.
//   - IG retry 도 carousel/video/REELS/STORIES 옵션 모두 동일 흐름 (postToInstagram
//     공유 헬퍼 재사용 — select-and-post 와 1:1).

'use strict';

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { getAdminClient } = require('./_shared/supabase-admin');
const { markIgTokenInvalid } = require('./_shared/ig-graph');
const { postToInstagram } = require('./_shared/ig-publish');
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
  const channel = body.channel === 'ig' ? 'ig' : body.channel === 'threads' ? 'threads' : null;
  if (!reservationId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'reservationId 누락' }) };
  }
  if (!channel) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'channel 은 ig 또는 threads 여야 합니다.' }) };
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
    .select('id, user_id, image_urls, video_url, media_type, story_enabled, generated_threads_caption, generated_captions, captions')
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

  // 2) channel_posts(channel, failed) row 존재 검증
  const { data: cp, error: cpErr } = await admin
    .from('channel_posts')
    .select('reservation_id, channel, status')
    .eq('reservation_id', reservation.id)
    .eq('channel', channel)
    .maybeSingle();
  if (cpErr) {
    console.error('[retry-channel-post] channel_posts 조회 실패:', cpErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: '게시 상태 조회 실패', channel }) };
  }
  if (!cp || cp.status !== 'failed') {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: '재시도 가능한 실패 기록이 없습니다.', channel }) };
  }

  // 3) 미디어·캡션 준비 (둘 다 공통)
  const imageUrl = Array.isArray(reservation.image_urls) && reservation.image_urls.length ? reservation.image_urls[0] : null;
  const videoUrl = reservation.video_url || null;
  if (!imageUrl && !videoUrl) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: '게시할 미디어가 없습니다.', channel }) };
  }

  let publishedId = '';

  if (channel === 'threads') {
    // 4-A) Threads 게시
    const threadsCtx = await getThreadsTokenForSeller(user.id, admin);
    if (!threadsCtx) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'Threads 연동이 필요합니다.', channel }) };
    }
    const caption = (reservation.generated_threads_caption && String(reservation.generated_threads_caption).trim())
      || (Array.isArray(reservation.generated_captions) && reservation.generated_captions[0])
      || (Array.isArray(reservation.captions) && reservation.captions[0])
      || '';
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
        try { await admin.from('channel_posts').update({ error_message: 'token_expired' })
          .eq('reservation_id', reservation.id).eq('channel', 'threads'); } catch (_) { /* noop */ }
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, tokenExpired: true, channel }) };
      }
      console.warn('[retry-channel-post] Threads 호출 실패:', e && e.message);
      try { await admin.from('channel_posts').update({ error_message: String(e && e.message || 'unknown') })
        .eq('reservation_id', reservation.id).eq('channel', 'threads'); } catch (_) { /* noop */ }
      const status = (e instanceof ThreadsGraphError && e.status >= 400 && e.status < 500) ? e.status : 502;
      return { statusCode: status, headers: CORS, body: JSON.stringify({ ok: false, error: (e && e.message) || '재시도 실패', channel }) };
    }
  } else {
    // 4-B) IG 게시 — select-and-post 와 동일 헬퍼 (carousel/single/REELS + STORIES)
    const { data: igRow, error: igRowErr } = await admin
      .from('ig_accounts_decrypted')
      .select('ig_user_id, access_token, page_access_token')
      .eq('user_id', user.id)
      .maybeSingle();
    if (igRowErr || !igRow || !igRow.access_token || !igRow.ig_user_id) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'IG 연동이 필요합니다.', channel }) };
    }
    // 토큰 만료 사전 차단
    const { data: igMeta } = await admin
      .from('ig_accounts')
      .select('token_invalid_at')
      .eq('user_id', user.id)
      .maybeSingle();
    if (igMeta && igMeta.token_invalid_at) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, tokenExpired: true, channel }) };
    }
    const captions = reservation.generated_captions || reservation.captions || [];
    const caption = (Array.isArray(captions) && captions[0]) ? captions[0] : '';
    const imageUrls = Array.isArray(reservation.image_urls) ? reservation.image_urls : [];
    const igUserAccessToken = igRow.access_token;
    const igAccessToken = igRow.page_access_token || igRow.access_token;
    try {
      publishedId = await postToInstagram({
        igUserId: igRow.ig_user_id,
        igAccessToken,
        igUserAccessToken,
        storyEnabled: !!reservation.story_enabled,
        mediaType: reservation.media_type || 'IMAGE',
        videoUrl,
      }, caption, imageUrls);
    } catch (e) {
      const msg = String(e && e.message || '');
      // IG 토큰 만료 패턴 — postToInstagram 이 d.error.message 만 throw 하므로 문자열 매칭.
      const isTokenExpired = /access token|OAuthException|session has expired|code 190|expired/i.test(msg);
      if (isTokenExpired) {
        try { await markIgTokenInvalid(admin, user.id, 'retry-channel-post'); } catch (_) { /* noop */ }
        try { await admin.from('channel_posts').update({ error_message: 'token_expired' })
          .eq('reservation_id', reservation.id).eq('channel', 'ig'); } catch (_) { /* noop */ }
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, tokenExpired: true, channel }) };
      }
      console.warn('[retry-channel-post] IG 호출 실패:', msg);
      try { await admin.from('channel_posts').update({ error_message: msg || 'unknown' })
        .eq('reservation_id', reservation.id).eq('channel', 'ig'); } catch (_) { /* noop */ }
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ ok: false, error: msg || '재시도 실패', channel }) };
    }
  }

  // 5) 성공 — channel_posts 갱신 (성공 시에만 credit_consumed=true, 결정 §12-A #7)
  try {
    await admin.from('channel_posts').update({
      status:           'posted',
      post_id:          publishedId,
      posted_at:        new Date().toISOString(),
      credit_consumed:  true,
      error_message:    null,
    }).eq('reservation_id', reservation.id).eq('channel', channel);
  } catch (e) {
    console.warn('[retry-channel-post] channel_posts 갱신 경고:', e && e.message);
  }

  console.log(`[retry-channel-post] seller=${String(user.id).slice(0,8)} reservation=${reservation.id} ${channel}_post=${publishedId}`);
  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ ok: true, postId: publishedId, channel }),
  };
};
