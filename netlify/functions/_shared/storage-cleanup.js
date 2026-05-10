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

// 단일 버킷 일괄 삭제 — Supabase Storage REST 의 단일 객체 DELETE 를 path 별로 호출.
// 이전엔 {prefixes:[...]} 일괄 body 를 썼는데, "prefixes" 필드가 일부 버전에서
// 진짜 prefix(LIKE) 매칭으로 동작해 의도치 않게 다른 예약의 파일까지 영향을
// 줄 가능성이 있어 path 별 단일 DELETE 로 변경 (정확한 매칭 + 한 건 실패해도
// 나머지 진행).
async function bulkDelete(bucket, keys) {
  const list = Array.isArray(keys) ? keys.filter((k) => typeof k === 'string' && k.trim()) : [];
  if (!list.length) return { deleted: 0, error: null };

  let url, serviceKey;
  try {
    ({ url, serviceKey } = getSupabaseEnv());
  } catch (e) {
    return { deleted: 0, error: e.message };
  }

  let deleted = 0;
  const errors = [];
  await Promise.all(list.map(async (path) => {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), STORAGE_TIMEOUT_MS);
    try {
      // 경로 안 ':' (예: reserve:12345) 등 reserved 문자 보호 — 세그먼트별 인코딩.
      const encodedPath = path.split('/').map(encodeURIComponent).join('/');
      const res = await fetch(`${url}/storage/v1/object/${bucket}/${encodedPath}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${serviceKey}`,
          'apikey': serviceKey,
        },
        signal: ctrl.signal,
      });
      // 200/204 = 삭제 성공, 404 = 이미 없음(무해)
      if (res.ok || res.status === 404) {
        deleted += 1;
      } else {
        const text = await res.text().catch(() => '');
        errors.push(`${path}: status=${res.status} ${text.slice(0, 120)}`);
      }
    } catch (e) {
      errors.push(`${path}: ${e?.message || String(e)}`);
    } finally {
      clearTimeout(tid);
    }
  }));

  return { deleted, error: errors.length ? errors.join(' | ') : null };
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
