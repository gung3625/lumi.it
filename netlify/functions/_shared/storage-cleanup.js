// Supabase Storage 정리 헬퍼.
// 예약 실패/완료/스테일 케이스에서 orphan 스토리지 파일과 row를 안전하게 제거.
// 모든 네트워크 호출은 AbortController 30초 타임아웃 + 에러 스왈로우.

const STORAGE_TIMEOUT_MS = 30_000;

function getSupabaseEnv() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Supabase 환경변수(SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)가 설정되지 않았습니다.');
  }
  return { url, serviceKey };
}

// 단일 버킷 일괄 삭제 — POST + method:DELETE + {prefixes:[...]} 스펙 사용.
async function bulkDelete(bucket, keys) {
  const list = Array.isArray(keys) ? keys.filter((k) => typeof k === 'string' && k.trim()) : [];
  if (!list.length) return { deleted: 0, error: null };

  let url, serviceKey;
  try {
    ({ url, serviceKey } = getSupabaseEnv());
  } catch (e) {
    return { deleted: 0, error: e.message };
  }

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), STORAGE_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/storage/v1/object/${bucket}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'apikey': serviceKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prefixes: list }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { deleted: 0, error: `status=${res.status} ${text.slice(0, 200)}` };
    }
    return { deleted: list.length, error: null };
  } catch (e) {
    return { deleted: 0, error: e?.message || String(e) };
  } finally {
    clearTimeout(tid);
  }
}

// reservation row를 받아 image_keys / video_key에 해당하는 스토리지 파일 삭제.
// 절대 throw 하지 않음 — 호출자는 반환 객체의 errors만 로깅.
async function deleteReservationStorage(_supabase, reservation) {
  const result = { imagesDeleted: 0, videoDeleted: false, errors: [] };
  if (!reservation) return result;

  const imageKeys = Array.isArray(reservation.image_keys) ? reservation.image_keys : [];
  const videoKey = typeof reservation.video_key === 'string' && reservation.video_key.trim()
    ? reservation.video_key.trim()
    : null;

  if (imageKeys.length) {
    const r = await bulkDelete('lumi-images', imageKeys);
    result.imagesDeleted = r.deleted;
    if (r.error) result.errors.push(`lumi-images: ${r.error}`);
  }

  if (videoKey) {
    const r = await bulkDelete('lumi-videos', [videoKey]);
    result.videoDeleted = r.deleted > 0;
    if (r.error) result.errors.push(`lumi-videos: ${r.error}`);
  }

  return result;
}

// 단일 row 삭제. 실패 시 error 반환, throw 없음.
async function deleteReservationRow(supabase, reserveKey) {
  if (!reserveKey) return { deleted: false, error: 'reserveKey 없음' };
  try {
    const { error } = await supabase
      .from('reservations')
      .delete()
      .eq('reserve_key', reserveKey);
    if (error) return { deleted: false, error: error.message };
    return { deleted: true, error: null };
  } catch (e) {
    return { deleted: false, error: e?.message || String(e) };
  }
}

module.exports = { deleteReservationStorage, deleteReservationRow };
