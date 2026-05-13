// 사장님이 history 에서 "모두 삭제" 또는 "선택 삭제" 클릭 시 일괄 soft delete.
// scope:
//   - 'upcoming' (예약 목록 탭) : is_sent=false 만
//   - 'past'     (히스토리 탭) : is_sent=true 만
//   - 'all'                    : 전체
//   - 'selected'               : reserveKeys 배열로 지정한 row 만
//
// deleteMedia=true 면 각 row 의 channel_posts.post_id 들 Meta DELETE 시도.
// 부분 실패는 mediaResults 로 안내. soft delete 는 항상 진행.

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { verifySellerToken } = require('./_shared/seller-jwt');
const { deleteReservationStorage } = require('./_shared/storage-cleanup');
const { deleteIgMedia, IgGraphError, markIgTokenInvalid } = require('./_shared/ig-graph');
const { deleteThreadsPost, ThreadsGraphError, markThreadsTokenInvalid } = require('./_shared/threads-graph');

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
  const validScopes = new Set(['upcoming', 'past', 'all', 'selected']);
  const scope = validScopes.has(body.scope) ? body.scope : null;
  if (!scope) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'scope (upcoming|past|all|selected) 가 필요합니다.' }) };
  }
  const reserveKeys = Array.isArray(body.reserveKeys) ? body.reserveKeys.filter((k) => typeof k === 'string') : [];
  if (scope === 'selected' && reserveKeys.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'reserveKeys 가 필요합니다.' }) };
  }

  try {
    const admin = getAdminClient();

    // 대상 row 들 조회 — Storage cleanup 에 image_keys/video_key + DELETE 에 id 필요
    let q = admin
      .from('reservations')
      .select('id, reserve_key, image_keys, video_key, is_sent')
      .eq('user_id', userId)
      .is('deleted_at', null);
    if (scope === 'upcoming') q = q.eq('is_sent', false);
    else if (scope === 'past') q = q.eq('is_sent', true);
    else if (scope === 'selected') q = q.in('reserve_key', reserveKeys);

    const { data: rows, error: selErr } = await q.limit(500);
    if (selErr) {
      console.error('[delete-reservations-bulk] select error:', selErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: '예약 조회 실패' }) };
    }
    if (!rows || rows.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, deletedCount: 0 }) };
    }

    // 원본 게시물 삭제 (옵션) — channel_posts 일괄 조회 + 각 채널 토큰 1회 + 모두 DELETE 호출.
    // 부분 실패 누적 — mediaSummary 로 응답.
    let mediaSummary = null;
    if (body.deleteMedia === true) {
      mediaSummary = { ig: { deleted: 0, failed: 0 }, threads: { deleted: 0, failed: 0 } };
      const rowIds = rows.map((r) => r.id);
      const { data: cps } = await admin
        .from('channel_posts')
        .select('reservation_id, channel, post_id')
        .in('reservation_id', rowIds);
      const { data: igRow } = await admin
        .from('ig_accounts_decrypted')
        .select('access_token, page_access_token, threads_token')
        .eq('user_id', userId)
        .maybeSingle();
      const igToken      = igRow && (igRow.page_access_token || igRow.access_token);
      const threadsToken = igRow && igRow.threads_token;
      let igTokenExpired = false;
      let thTokenExpired = false;
      // IG / Threads 별 병렬 (한 채널 안은 순차 — rate limit 보호)
      for (const cp of (cps || [])) {
        if (!cp.post_id) continue;
        if (cp.channel === 'ig') {
          if (!igToken) { mediaSummary.ig.failed++; continue; }
          if (igTokenExpired) { mediaSummary.ig.failed++; continue; }
          try {
            await deleteIgMedia(igToken, cp.post_id);
            mediaSummary.ig.deleted++;
          } catch (e) {
            mediaSummary.ig.failed++;
            if (e instanceof IgGraphError && e.isTokenExpired()) {
              igTokenExpired = true;
              try { await markIgTokenInvalid(admin, userId, 'delete-reservations-bulk'); } catch (_) { /* noop */ }
            }
            console.warn('[delete-reservations-bulk] IG DELETE 실패:', cp.post_id, e && e.message);
          }
        } else if (cp.channel === 'threads') {
          if (!threadsToken) { mediaSummary.threads.failed++; continue; }
          if (thTokenExpired) { mediaSummary.threads.failed++; continue; }
          try {
            await deleteThreadsPost({ token: threadsToken, threadId: cp.post_id });
            mediaSummary.threads.deleted++;
          } catch (e) {
            mediaSummary.threads.failed++;
            if (e instanceof ThreadsGraphError && e.isTokenExpired()) {
              thTokenExpired = true;
              try { await markThreadsTokenInvalid(admin, userId, 'delete-reservations-bulk'); } catch (_) { /* noop */ }
            }
            console.warn('[delete-reservations-bulk] Threads DELETE 실패:', cp.post_id, e && e.message);
          }
        }
      }
    }

    // Storage cleanup 병렬 (best-effort)
    await Promise.allSettled(rows.map((row) =>
      deleteReservationStorage(admin, row).catch((e) => {
        console.warn('[delete-reservations-bulk] storage 예외:', row.reserve_key, e && e.message);
      })
    ));

    // soft delete 일괄
    const nowIso = new Date().toISOString();
    let upd = admin
      .from('reservations')
      .update({ deleted_at: nowIso })
      .eq('user_id', userId)
      .is('deleted_at', null);
    if (scope === 'upcoming') upd = upd.eq('is_sent', false);
    else if (scope === 'past') upd = upd.eq('is_sent', true);
    else if (scope === 'selected') upd = upd.in('reserve_key', reserveKeys);

    const { error: updErr, count } = await upd.select('reserve_key', { count: 'exact' });
    if (updErr) {
      console.error('[delete-reservations-bulk] update error:', updErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: '삭제 실패' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, deletedCount: count || rows.length, mediaSummary }) };
  } catch (err) {
    console.error('[delete-reservations-bulk] unexpected:', err && err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
