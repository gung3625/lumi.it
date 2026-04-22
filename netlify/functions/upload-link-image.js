// upload-link-image — POST JSON {filename, contentType, base64}, Bearer 인증
// Supabase Storage 'link-assets/{user_id}/{uuid}.{ext}' 업로드 후 public URL 반환
const crypto = require('crypto');
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function extFromMime(mime) {
  switch (mime) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    default: return 'bin';
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON 본문 파싱 실패' }) };
  }

  const contentType = (body.contentType || '').toLowerCase();
  if (!ALLOWED_MIME.has(contentType)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '이미지 형식(JPG/PNG/WebP/GIF)만 업로드 가능해요.' }) };
  }
  const base64 = typeof body.base64 === 'string' ? body.base64.replace(/^data:[^;]+;base64,/, '') : '';
  if (!base64) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'base64 본문이 비어있어요.' }) };
  }

  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'base64 디코딩 실패' }) };
  }
  if (buffer.length > MAX_BYTES) {
    return { statusCode: 413, headers: CORS, body: JSON.stringify({ error: '파일이 너무 커요 (최대 5MB).' }) };
  }

  try {
    const admin = getAdminClient();
    const ext = extFromMime(contentType);
    const objectPath = `${user.id}/${crypto.randomUUID()}.${ext}`;

    const { error: upErr } = await admin.storage
      .from('link-assets')
      .upload(objectPath, buffer, {
        contentType,
        cacheControl: '31536000',
        upsert: false,
      });
    if (upErr) {
      console.error('[upload-link-image] upload error:', upErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '업로드 실패' }) };
    }

    const { data: pub } = admin.storage.from('link-assets').getPublicUrl(objectPath);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, path: objectPath, url: pub.publicUrl }),
    };
  } catch (err) {
    console.error('[upload-link-image] unexpected:', err && err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
