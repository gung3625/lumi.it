const { corsHeaders, getOrigin } = require('./_shared/auth');
// 예약 취소 — Bearer 토큰 검증 후 본인 예약을 행과 스토리지까지 삭제.
// 사장님이 취소했으면 목록에서 즉시 사라져야 자연스러움 (이전엔 cancelled=true
// 만 set 해서 "취소됨" 카드로 남았음).
// invariant: sellers.id = reservations.user_id (UUID 동일)
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { verifySellerToken } = require('./_shared/seller-jwt');
const { deleteReservationStorage, deleteReservationRow } = require('./_shared/storage-cleanup');


exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  // 1) Supabase JWT 우선 검증
  let userId = null;
  const { user } = await verifyBearerToken(token);
  if (user && user.id) {
    userId = user.id;
  } else {
    // 2) seller-jwt fallback (카카오 가입자)
    const { payload } = verifySellerToken(token);
    if (payload && payload.seller_id) userId = payload.seller_id;
  }
  if (!userId) {
    return { statusCode: 401, headers: headers, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: '잘못된 요청' }) };
  }
  const rKey = body.reserveKey || body.reserve_key || body.reservationKey;
  if (!rKey) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'reserveKey가 필요합니다.' }) };
  }

  try {
    const admin = getAdminClient();

    // 1) 본인 예약 행 조회 (storage cleanup 에 image_keys/video_key 필요)
    const { data: row, error: selErr } = await admin
      .from('reservations')
      .select('reserve_key, user_id, is_sent, image_keys, video_key')
      .eq('reserve_key', rKey)
      .eq('user_id', userId)
      .maybeSingle();
    if (selErr) {
      console.error('[cancel-reservation] select error:', selErr.message);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '예약 조회 실패' }) };
    }
    if (!row) {
      return { statusCode: 404, headers: headers, body: JSON.stringify({ error: '예약을 찾을 수 없습니다.' }) };
    }

    // 2) 이미 IG 게시된 건은 행 삭제하면 게시 이력이 사라져 부적절
    //    — 이 경우만 cancelled=true 마킹 (실제로는 거의 일어나지 않음).
    if (row.is_sent) {
      const { error: updErr } = await admin
        .from('reservations')
        .update({ cancelled: true })
        .eq('reserve_key', rKey)
        .eq('user_id', userId);
      if (updErr) {
        console.error('[cancel-reservation] update error:', updErr.message);
        return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '예약 취소 실패' }) };
      }
      return { statusCode: 200, headers: headers, body: JSON.stringify({ success: true, deleted: false }) };
    }

    // 3) 미게시 건 — Storage 정리 + 행 삭제 (목록에서 사라짐)
    const cleanup = await deleteReservationStorage(admin, row);
    if (cleanup.errors && cleanup.errors.length) {
      console.warn('[cancel-reservation] storage cleanup 경고:', cleanup.errors.join(' | '));
    }

    const drop = await deleteReservationRow(admin, rKey);
    if (drop.error) {
      console.error('[cancel-reservation] row delete 실패:', drop.error);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '예약 취소 실패' }) };
    }

    return { statusCode: 200, headers: headers, body: JSON.stringify({ success: true, deleted: true }) };
  } catch (err) {
    console.error('[cancel-reservation] unexpected:', err && err.message);
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
