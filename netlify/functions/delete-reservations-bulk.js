// 사장님이 history 에서 "모두 삭제" 클릭 시 일괄 soft delete.
// scope:
//   - 'upcoming' (예약 목록 탭) : is_sent=false 만
//   - 'past'     (히스토리 탭) : is_sent=true 만
//   - 'all'                    : 전체
// Storage cleanup 도 best-effort 로 함께. 실패해도 soft delete 진행.
// IG/Threads 실제 게시물은 손대지 않음.

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { verifySellerToken } = require('./_shared/seller-jwt');
const { deleteReservationStorage } = require('./_shared/storage-cleanup');

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
  const scope = (body.scope === 'upcoming' || body.scope === 'past' || body.scope === 'all') ? body.scope : null;
  if (!scope) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'scope (upcoming|past|all) 가 필요합니다.' }) };
  }

  try {
    const admin = getAdminClient();

    // 대상 row 들 조회 — Storage cleanup 에 image_keys/video_key 필요
    let q = admin
      .from('reservations')
      .select('reserve_key, image_keys, video_key, is_sent')
      .eq('user_id', userId)
      .is('deleted_at', null);
    if (scope === 'upcoming') q = q.eq('is_sent', false);
    else if (scope === 'past') q = q.eq('is_sent', true);

    const { data: rows, error: selErr } = await q.limit(500);
    if (selErr) {
      console.error('[delete-reservations-bulk] select error:', selErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: '예약 조회 실패' }) };
    }
    if (!rows || rows.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, deletedCount: 0 }) };
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

    const { error: updErr, count } = await upd.select('reserve_key', { count: 'exact' });
    if (updErr) {
      console.error('[delete-reservations-bulk] update error:', updErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: '삭제 실패' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, deletedCount: count || rows.length }) };
  } catch (err) {
    console.error('[delete-reservations-bulk] unexpected:', err && err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
