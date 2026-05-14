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
const ALLOWED_VIDEO_MIME = ['video/mp4', 'video/quicktime', 'video/x-quicktime'];
const MAX_VIDEO_BYTES = 300 * 1024 * 1024; // 300MB (Meta Reels API 한도)
const EXT_FROM_MIME = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-quicktime': 'mov',
};

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

  if (!ALLOWED_VIDEO_MIME.includes(contentType)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '영상은 MP4 또는 MOV 만 지원합니다.' }) };
  }
  if (size <= 0 || size > MAX_VIDEO_BYTES) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `영상 크기는 300MB 이하여야 합니다. (현재 ${(size / 1024 / 1024).toFixed(1)}MB)` }) };
  }

  const ext = EXT_FROM_MIME[contentType] || 'mp4';
  const reserveKey = `reserve:${Date.now()}`;
  const nonce = require('crypto').randomBytes(8).toString('hex');
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
