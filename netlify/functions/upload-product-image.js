// 상품 이미지 업로드 — Sprint 2 (Ingestion 단계)
// POST /api/upload-product-image
// Multipart form-data: file=<image binary>
//
// 동작:
// 1. seller JWT 검증
// 2. multipart 파싱 (외부 의존 없이 boundary 분할)
// 3. Supabase Storage `product-images` 버킷에 sellerId/{uuid}.{ext} 경로로 업로드
// 4. public URL 반환 (AI 분석 단계로 전달)
//
// 모킹: SIGNUP_MOCK=true → Storage 업로드 스킵, 더미 URL 반환

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { recordAudit } = require('./_shared/onboarding-utils');
const crypto = require('crypto');

const BUCKET = 'product-images';
const MAX_BYTES = 10 * 1024 * 1024; // 10MB (쿠팡 한도)
const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

/**
 * Multipart form-data 파싱 (외부 의존 없이 boundary 분할)
 * @param {Buffer} body
 * @param {string} boundary
 * @returns {{ file?: { fieldName, filename, contentType, data }, fields: Object }}
 */
function parseMultipart(body, boundary) {
  const result = { fields: {}, file: null };
  const delimiter = Buffer.from(`--${boundary}`);
  const closing = Buffer.from(`--${boundary}--`);

  let start = 0;
  while (start < body.length) {
    const idx = body.indexOf(delimiter, start);
    if (idx === -1) break;
    const next = body.indexOf(delimiter, idx + delimiter.length);
    if (next === -1) {
      // closing or end
      const closeIdx = body.indexOf(closing, idx);
      if (closeIdx === -1) break;
      processPart(body.slice(idx + delimiter.length + 2, closeIdx - 2), result);
      break;
    }
    processPart(body.slice(idx + delimiter.length + 2, next - 2), result);
    start = next;
  }
  return result;
}

function processPart(part, result) {
  const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
  if (headerEnd === -1) return;
  const headerStr = part.slice(0, headerEnd).toString('utf8');
  const data = part.slice(headerEnd + 4);

  const dispositionMatch = headerStr.match(/Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]+)")?/i);
  if (!dispositionMatch) return;
  const fieldName = dispositionMatch[1];
  const filename = dispositionMatch[2];
  const contentTypeMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);
  const contentType = contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream';

  if (filename) {
    result.file = { fieldName, filename, contentType, data };
  } else {
    result.fields[fieldName] = data.toString('utf8');
  }
}

function inferExtension(mime, filename) {
  const fromName = (filename || '').match(/\.([a-zA-Z0-9]+)$/);
  if (fromName) return fromName[1].toLowerCase();
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/heic') return 'heic';
  if (mime === 'image/heif') return 'heif';
  return 'jpg';
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // 1. seller JWT
  const token = extractBearerToken(event);
  const { payload, error: authErr } = verifySellerToken(token);
  if (authErr || !payload) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  // 2. Content-Type boundary
  const ct = (event.headers['content-type'] || event.headers['Content-Type'] || '');
  const boundaryMatch = ct.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'multipart/form-data가 아닙니다.' }) };
  }
  const boundary = boundaryMatch[1].replace(/^"|"$/g, '');

  // 3. body Buffer
  let body;
  try {
    body = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64')
      : Buffer.from(event.body || '', 'binary');
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '요청 본문을 읽을 수 없습니다.' }) };
  }

  if (body.length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '파일이 비어 있습니다.' }) };
  }
  if (body.length > MAX_BYTES + 100_000) {
    return { statusCode: 413, headers: CORS, body: JSON.stringify({ error: '파일이 너무 큽니다 (최대 10MB).' }) };
  }

  // 4. 파싱
  const parsed = parseMultipart(body, boundary);
  if (!parsed.file) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '파일을 찾을 수 없습니다.' }) };
  }
  const { contentType, data: fileData, filename } = parsed.file;
  if (!ALLOWED_MIME.has(contentType.toLowerCase())) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '지원하지 않는 이미지 형식입니다. (JPG/PNG/WebP/HEIC만)' }) };
  }
  if (fileData.length > MAX_BYTES) {
    return { statusCode: 413, headers: CORS, body: JSON.stringify({ error: '파일이 너무 큽니다 (최대 10MB).' }) };
  }

  // 5. 파일명 — sellerId/timestamp_uuid.ext
  const ext = inferExtension(contentType, filename);
  const uniqueId = crypto.randomBytes(8).toString('hex');
  const objectPath = `${payload.seller_id}/${Date.now()}_${uniqueId}.${ext}`;

  // 6. Supabase Storage 업로드
  const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
  let admin;
  try { admin = getAdminClient(); } catch (e) {
    if (isSignupMock) {
      const mockUrl = `https://mock.supabase.co/storage/v1/object/public/${BUCKET}/${objectPath}`;
      console.log(`[upload-product-image] mock seller=${payload.seller_id.slice(0, 8)} bytes=${fileData.length}`);
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          success: true,
          imageUrl: mockUrl,
          objectPath,
          contentType,
          size: fileData.length,
          mock: true,
        }),
      };
    }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류입니다.' }) };
  }

  const { error: uploadErr } = await admin.storage
    .from(BUCKET)
    .upload(objectPath, fileData, {
      contentType,
      cacheControl: '3600',
      upsert: false,
    });

  if (uploadErr) {
    console.error('[upload-product-image] upload 오류:', uploadErr.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '이미지 업로드에 실패했어요. 잠시 후 다시 시도해주세요.' }),
    };
  }

  const { data: pub } = admin.storage.from(BUCKET).getPublicUrl(objectPath);
  const imageUrl = pub?.publicUrl || `https://${process.env.SUPABASE_URL?.replace(/^https?:\/\//, '')}/storage/v1/object/public/${BUCKET}/${objectPath}`;

  await recordAudit(admin, {
    actor_id: payload.seller_id,
    actor_type: 'seller',
    action: 'product_image_upload',
    resource_type: 'storage_object',
    resource_id: objectPath,
    metadata: { size: fileData.length, content_type: contentType },
    event,
  });

  console.log(`[upload-product-image] uploaded seller=${payload.seller_id.slice(0, 8)} bytes=${fileData.length} mime=${contentType}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      imageUrl,
      objectPath,
      contentType,
      size: fileData.length,
    }),
  };
};
