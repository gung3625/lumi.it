// 사장님이 history 에서 특정 reservation 삭제 (soft delete).
//   - reservations.deleted_at 마킹 → list-reservations 가 자동 필터
//   - 미게시 row 면 Storage 사진도 함께 삭제 (재게시 가능성 0)
//   - 이미 IG/Threads 게시된 row 는 Storage 만 정리하고 row 는 soft delete
//     (실제 IG/Threads 게시물은 손대지 않음 — 사장님이 인스타 앱에서 별도 처리)
//   - tone_feedback 등 학습 데이터는 user_id 기반이라 row 가 살아있어야 보존됨 (soft delete 채택 사유)

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
  const rKey = body.reserveKey || body.reserve_key || body.reservationKey;
  if (!rKey) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'reserveKey가 필요합니다.' }) };
  }

  try {
    const admin = getAdminClient();

    // 본인 row 권한 검증 + Storage cleanup 에 image_keys 필요
    const { data: row, error: selErr } = await admin
      .from('reservations')
      .select('reserve_key, user_id, image_keys, video_key, deleted_at')
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

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, deleted: true }) };
  } catch (err) {
    console.error('[delete-reservation] unexpected:', err && err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
