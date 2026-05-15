// 영상 업로드용 signed URL 발급
// POST /api/video-upload-url
// 헤더: Authorization: Bearer <jwt>
// body: { filename, contentType, size }
// 응답: { ok, uploadUrl, token, path, publicUrl }
//
// 흐름:
//   1) JWT 검증 → sellerId
//   2) MIME · 크기 검증 (300MB, video/mp4·video/quicktime)
//   3) Supabase Storage `lumi-videos` 의 signed upload URL 발급
//   4) 클라이언트가 그 URL 로 직접 PUT — Netlify Function body 한도(6MB) 우회
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { verifySellerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const BUCKET = 'lumi-videos';
// 사장님 결정 (2026-05-15): 모든 영상 포맷 허용. process-video-background 의 ffmpeg-static
// 이 H.264/AAC MP4 로 강제 transcode → IG Reels 호환. 따라서 입력 코덱이 무엇이든 OK.
// - 화이트리스트: 자주 쓰는 mime 명시 (검증 메시지 친절화)
// - 그 외에도 video/* prefix 면 허용 (브라우저별 mime 변형 대응)
const ALLOWED_VIDEO_MIME = [
  'video/mp4', 'video/quicktime', 'video/x-quicktime',
  'video/x-msvideo', 'video/avi',                       // AVI
  'video/x-matroska', 'video/webm',                     // MKV / WebM
  'video/mpeg', 'video/mp2t', 'video/x-m4v',            // MPEG / TS / M4V
  'video/3gpp', 'video/3gpp2',                          // 3GP (구형 폰)
  'video/x-flv', 'video/x-ms-wmv',                      // FLV / WMV
  'video/hevc', 'video/h265', 'video/h264',             // 코덱 명시 (드물게 들어옴)
];
const isAllowedVideoMime = (m) => {
  if (!m) return true; // 일부 브라우저가 mime 안 채움 — 확장자만 보고 진행
  const lower = String(m).toLowerCase();
  if (ALLOWED_VIDEO_MIME.includes(lower)) return true;
  return lower.startsWith('video/');
};
const MAX_VIDEO_BYTES = 300 * 1024 * 1024; // 300MB (Meta Reels API 한도)
// 확장자 매핑 — 모르는 mime 은 파일명 확장자에서 추출 (fallback 'mp4').
const EXT_FROM_MIME = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/avi': 'avi',
  'video/x-matroska': 'mkv',
  'video/webm': 'webm',
  'video/mpeg': 'mpg',
  'video/mp2t': 'ts',
  'video/x-m4v': 'm4v',
  'video/3gpp': '3gp',
  'video/3gpp2': '3g2',
  'video/x-flv': 'flv',
  'video/x-ms-wmv': 'wmv',
};
// Storage path 에 쓸 확장자 — 단순 영숫자만 (path traversal/특수문자 차단)
const SAFE_EXT_RE = /^[a-z0-9]{1,5}$/;
function pickExt(contentType, filename) {
  const fromMime = EXT_FROM_MIME[String(contentType || '').toLowerCase()];
  if (fromMime) return fromMime;
  const m = String(filename || '').toLowerCase().match(/\.([a-z0-9]{1,5})$/);
  if (m && SAFE_EXT_RE.test(m[1])) return m[1];
  return 'mp4';
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  if (!token) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  // 인증: Supabase JWT 우선 → seller-jwt fallback
  let userId = null;
  const { user } = await verifyBearerToken(token);
  if (user && user.id) {
    userId = user.id;
  } else {
    const { payload } = verifySellerToken(token);
    if (payload && payload.seller_id) userId = payload.seller_id;
  }
  if (!userId) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (_) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청 본문입니다.' }) };
  }

  const filename = String(body.filename || '').trim();
  const contentType = String(body.contentType || '').trim().toLowerCase();
  const size = Number(body.size) || 0;

  if (!isAllowedVideoMime(contentType)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '영상 파일만 업로드할 수 있어요.' }) };
  }
  if (size <= 0 || size > MAX_VIDEO_BYTES) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `영상 크기는 300MB 이하여야 합니다. (현재 ${(size / 1024 / 1024).toFixed(1)}MB)` }) };
  }

  const ext = pickExt(contentType, filename);
  // I-B (2026-05-15): reserveKey 충돌 차단. 이전 'reserve:${Date.now()}' 는 동일 ms 두 요청 시 충돌.
  // crypto.randomBytes 4 byte hex suffix 추가 (4B = 4억 가지) → 사실상 unique.
  const nonce = require('crypto').randomBytes(8).toString('hex');
  const suffix = require('crypto').randomBytes(4).toString('hex');
  const reserveKey = `reserve:${Date.now()}-${suffix}`;
  const path = `${userId}/${reserveKey}/video-${nonce}.${ext}`;

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[video-upload-url] Supabase admin 초기화 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류입니다.' }) };
  }

  // Supabase signed upload URL — 클라이언트가 그 URL 로 PUT 업로드
  const { data: signed, error: signErr } = await admin.storage.from(BUCKET).createSignedUploadUrl(path);
  if (signErr || !signed) {
    console.error('[video-upload-url] signed URL 발급 실패:', signErr && signErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '업로드 URL 발급에 실패했습니다.' }) };
  }

  const { data: pub } = admin.storage.from(BUCKET).getPublicUrl(path);
  const publicUrl = (pub && pub.publicUrl) || '';

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      reserveKey,
      path,
      uploadUrl: signed.signedUrl || signed.signed_url,
      token: signed.token,
      publicUrl,
    }),
  };
};
