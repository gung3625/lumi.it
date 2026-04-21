// upload-link-image — POST multipart/form-data, Bearer 인증
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

// multipart/form-data 파싱 (단일 file 필드만 기대)
function parseMultipart(buffer, boundary) {
  const delim = Buffer.from('--' + boundary);
  const crlf = Buffer.from('\r\n');
  let idx = buffer.indexOf(delim);
  if (idx < 0) return null;
  idx += delim.length;
  while (idx < buffer.length) {
    // 각 파트 시작: \r\n (헤더블록) \r\n\r\n (바디) ... \r\n--boundary
    if (buffer.slice(idx, idx + 2).toString() === '--') return null; // 종료
    if (buffer.slice(idx, idx + 2).equals(crlf)) idx += 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), idx);
    if (headerEnd < 0) return null;
    const headerStr = buffer.slice(idx, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;
    const nextBoundary = buffer.indexOf(delim, bodyStart);
    if (nextBoundary < 0) return null;
    const bodyEnd = nextBoundary - 2; // 직전 \r\n 제거
    const body = buffer.slice(bodyStart, bodyEnd);

    const nameMatch = headerStr.match(/name="([^"]+)"/i);
    const filenameMatch = headerStr.match(/filename="([^"]*)"/i);
    const ctMatch = headerStr.match(/content-type:\s*([^\r\n;]+)/i);

    if (nameMatch && nameMatch[1] === 'file') {
      return {
        filename: filenameMatch ? filenameMatch[1] : 'upload',
        contentType: ctMatch ? ctMatch[1].trim().toLowerCase() : 'application/octet-stream',
        data: body,
      };
    }
    idx = nextBoundary + delim.length;
  }
  return null;
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

  const contentType = (event.headers['content-type'] || event.headers['Content-Type'] || '').toLowerCase();
  if (!contentType.startsWith('multipart/form-data')) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'multipart/form-data 만 허용됩니다.' }) };
  }
  const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
  if (!boundaryMatch) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'multipart boundary 누락' }) };
  }
  const boundary = boundaryMatch[1].replace(/^"|"$/g, '').trim();

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64')
    : Buffer.from(event.body || '', 'utf8');

  if (raw.length > MAX_BYTES + 1024) {
    return { statusCode: 413, headers: CORS, body: JSON.stringify({ error: '파일이 너무 커요 (최대 5MB).' }) };
  }

  const file = parseMultipart(raw, boundary);
  if (!file) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '파일을 찾을 수 없어요.' }) };
  }
  if (!ALLOWED_MIME.has(file.contentType)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '이미지 형식(JPG/PNG/WebP/GIF)만 업로드 가능해요.' }) };
  }
  if (file.data.length > MAX_BYTES) {
    return { statusCode: 413, headers: CORS, body: JSON.stringify({ error: '파일이 너무 커요 (최대 5MB).' }) };
  }

  try {
    const admin = getAdminClient();
    const ext = extFromMime(file.contentType);
    const objectPath = `${user.id}/${crypto.randomUUID()}.${ext}`;

    const { error: upErr } = await admin.storage
      .from('link-assets')
      .upload(objectPath, file.data, {
        contentType: file.contentType,
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
