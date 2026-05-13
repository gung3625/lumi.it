// 사장님이 history 에서 특정 reservation 삭제.
//   - 디폴트: reservations.deleted_at 마킹 (soft delete) + Storage 정리.
//             IG/Threads 실제 게시물은 손대지 않음.
//   - body.deleteMedia=true: 위 + 각 채널 (channel_posts.post_id) 의 실 게시물도
//             Meta DELETE 시도 (IG: instagram_manage_contents, Threads: threads_delete).
//             부분 실패는 응답 mediaResults 로 안내. soft delete 는 항상 진행.

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { verifySellerToken } = require('./_shared/seller-jwt');
const { deleteReservationStorage } = require('./_shared/storage-cleanup');
const { deleteIgMedia, IgGraphError, markIgTokenInvalid } = require('./_shared/ig-graph');
const { deleteThreadsPost, ThreadsGraphError, markThreadsTokenInvalid } = require('./_shared/threads-graph');

// channel_posts.post_id 로 Meta 측 실 게시물 삭제. 각 채널 graceful.
// 반환: { ig: 'deleted'|'failed:<msg>'|'skipped', threads: ... }
async function deleteRealMedia(admin, userId, reservationId) {
  const results = { ig: 'skipped', threads: 'skipped' };
  const { data: cps } = await admin
    .from('channel_posts')
    .select('channel, post_id, status')
    .eq('reservation_id', reservationId);
  const ig      = (cps || []).find((c) => c.channel === 'ig'      && c.post_id);
  const threads = (cps || []).find((c) => c.channel === 'threads' && c.post_id);

  // IG 토큰 (page_access_token 우선) — 본인 미디어만 DELETE 가능
  if (ig) {
    try {
      const { data: igRow } = await admin
        .from('ig_accounts_decrypted')
        .select('access_token, page_access_token')
        .eq('user_id', userId)
        .maybeSingle();
      const token = igRow && (igRow.page_access_token || igRow.access_token);
      if (!token) {
        results.ig = 'failed:no_token';
      } else {
        await deleteIgMedia(token, ig.post_id);
        results.ig = 'deleted';
      }
    } catch (e) {
      if (e instanceof IgGraphError && e.isTokenExpired()) {
        try { await markIgTokenInvalid(admin, userId, 'delete-reservation'); } catch (_) { /* noop */ }
        results.ig = 'failed:token_expired';
      } else {
        results.ig = `failed:${(e && e.message) || 'unknown'}`;
      }
      console.warn('[delete-reservation] IG DELETE 실패:', results.ig);
    }
  }

  if (threads) {
    try {
      const { data: thRow } = await admin
        .from('ig_accounts_decrypted')
        .select('threads_token')
        .eq('user_id', userId)
        .maybeSingle();
      const token = thRow && thRow.threads_token;
      if (!token) {
        results.threads = 'failed:no_token';
      } else {
        await deleteThreadsPost({ token, threadId: threads.post_id });
        results.threads = 'deleted';
      }
    } catch (e) {
      if (e instanceof ThreadsGraphError && e.isTokenExpired()) {
        try { await markThreadsTokenInvalid(admin, userId, 'delete-reservation'); } catch (_) { /* noop */ }
        results.threads = 'failed:token_expired';
      } else {
        results.threads = `failed:${(e && e.message) || 'unknown'}`;
      }
      console.warn('[delete-reservation] Threads DELETE 실패:', results.threads);
    }
  }
  return results;
}

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  let userId = null;
  const { user } = await verifyBearerToken(token);
  if (user && user.id) {
    userId = user.id;
  } else {
    const { payload } = verifySellerToken(token);
    if (payload && payload.seller_id) userId = payload.seller_id;
  }
  if (!userId) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '잘못된 요청' }) };
  }
  const rKey = body.reserveKey || body.reserve_key || body.reservationKey;
  if (!rKey) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'reserveKey가 필요합니다.' }) };
  }

  try {
    const admin = getAdminClient();

    // 본인 row 권한 검증 + Storage cleanup 에 image_keys 필요
    const { data: row, error: selErr } = await admin
      .from('reservations')
      .select('id, reserve_key, user_id, image_keys, video_key, deleted_at')
      .eq('reserve_key', rKey)
      .eq('user_id', userId)
      .maybeSingle();
    if (selErr) {
      console.error('[delete-reservation] select error:', selErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: '예약 조회 실패' }) };
    }
    if (!row) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: '예약을 찾을 수 없습니다.' }) };
    }
    if (row.deleted_at) {
      // 이미 삭제됨 — idempotent
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, alreadyDeleted: true }) };
    }

    // 원본 게시물 삭제 (옵션) — soft delete 전에 시도. 실패해도 lumi 기록은 삭제.
    let mediaResults = null;
    if (body.deleteMedia === true) {
      mediaResults = await deleteRealMedia(admin, userId, row.id);
    }

    // Storage 사진 정리 (best-effort — 실패해도 soft delete 는 진행)
    try {
      const cleanup = await deleteReservationStorage(admin, row);
      if (cleanup.errors && cleanup.errors.length) {
        console.warn('[delete-reservation] storage cleanup 경고:', cleanup.errors.join(' | '));
      }
    } catch (e) {
      console.warn('[delete-reservation] storage cleanup 예외 (무시):', e && e.message);
    }

    // soft delete
    const { error: updErr } = await admin
      .from('reservations')
      .update({ deleted_at: new Date().toISOString() })
      .eq('reserve_key', rKey)
      .eq('user_id', userId);
    if (updErr) {
      console.error('[delete-reservation] update error:', updErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: '삭제 실패' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, deleted: true, mediaResults }) };
  } catch (err) {
    console.error('[delete-reservation] unexpected:', err && err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
