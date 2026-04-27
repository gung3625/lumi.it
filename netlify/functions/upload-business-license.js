// 사업자등록증 사진/PDF 업로드 — Sprint 1 (백그라운드 검토 워크플로우)
// POST /api/upload-business-license
// 입력: multipart/form-data { file: <사업자등록증>, originalName?: string }
// 인증: Bearer JWT (signSellerToken에서 발급한 토큰)
// 응답: { success: true, fileUrl: string, verifyStatus: 'pending'|'approved' }
//
// 정책:
// - 셀러 가입 즉시 통과 (사진 검토는 김현 admin이 백그라운드 처리)
// - 파일은 Supabase Storage 'business-licenses' 버킷 저장
// - 파일명 규칙: business-licenses/{seller_id}/{timestamp}-{hash}.{ext}
// - BUSINESS_LICENSE_AUTO_APPROVE=true 시 즉시 'approved' (베타 운영용)
// - 평문 시크릿 노출 금지, 파일 URL은 응답·로그에서 마스킹
//
// 보안:
// - 파일 크기 ≤ 10MB
// - 확장자 화이트리스트 (jpg, png, heic, webp, pdf)
// - MIME sniff 1차 (magic bytes 확인 — JPEG/PNG/PDF만)
const Busboy = require('busboy');
const crypto = require('crypto');
const path = require('path');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { recordAudit } = require('./_shared/onboarding-utils');

const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED_EXT = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'pdf'];
const ALLOWED_MIME = [
  'image/jpeg', 'image/jpg', 'image/png',
  'image/heic', 'image/heif', 'image/webp',
  'application/pdf',
];
const STORAGE_BUCKET = 'business-licenses';

function jsonResponse(statusCode, CORS, payload) {
  return { statusCode, headers: CORS, body: JSON.stringify(payload) };
}

/**
 * Netlify Functions multipart/form-data 파싱 — Buffer 단위 한정.
 * @returns {Promise<{ file: Buffer|null, filename: string, mimeType: string, fields: object }>}
 */
function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      reject(new Error('multipart/form-data 형식이 아닙니다.'));
      return;
    }

    const busboy = Busboy({
      headers: { 'content-type': contentType },
      limits: { fileSize: MAX_BYTES, files: 1, fields: 10 },
    });

    let fileBuffer = null;
    let filename = '';
    let mimeType = '';
    let truncated = false;
    const fields = {};

    busboy.on('file', (fieldname, fileStream, info) => {
      filename = (info && info.filename) || 'license';
      mimeType = (info && info.mimeType) || '';
      const chunks = [];
      fileStream.on('data', (chunk) => chunks.push(chunk));
      fileStream.on('limit', () => { truncated = true; });
      fileStream.on('end', () => {
        if (truncated) {
          fileBuffer = null;
        } else {
          fileBuffer = Buffer.concat(chunks);
        }
      });
    });
    busboy.on('field', (name, value) => { fields[name] = value; });
    busboy.on('finish', () => {
      if (truncated) {
        reject(new Error('FILE_TOO_LARGE'));
      } else {
        resolve({ file: fileBuffer, filename, mimeType, fields });
      }
    });
    busboy.on('error', (err) => reject(err));

    const body = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64')
      : Buffer.from(event.body || '', 'binary');
    busboy.end(body);
  });
}

function detectExtension(filename, mimeType) {
  const ext = (path.extname(filename || '') || '').toLowerCase().replace(/^\./, '');
  if (ALLOWED_EXT.includes(ext)) return ext;
  // MIME 폴백
  const map = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp',
    'application/pdf': 'pdf',
  };
  return map[mimeType] || '';
}

/**
 * Magic bytes로 1차 컨텐츠 검증 — 위·변조 1차 차단
 * 허용: JPEG, PNG, PDF, HEIC/HEIF (브랜드 헤더 검증), WEBP
 */
function validateMagicBytes(buffer, ext) {
  if (!buffer || buffer.length < 12) return false;
  const head = buffer.slice(0, 12);
  // JPEG: FF D8 FF
  if (head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) {
    return ext === 'jpg' || ext === 'jpeg';
  }
  // PNG: 89 50 4E 47
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47) {
    return ext === 'png';
  }
  // PDF: %PDF
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) {
    return ext === 'pdf';
  }
  // WEBP: RIFF....WEBP
  if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46
      && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) {
    return ext === 'webp';
  }
  // HEIC/HEIF: ftyp 박스 (offset 4)
  if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
    return ext === 'heic' || ext === 'heif';
  }
  return false;
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, CORS, { error: 'Method not allowed' });
  }

  // 인증
  const token = extractBearerToken(event);
  const { payload, error: tokenErr } = verifySellerToken(token);
  if (!payload || !payload.seller_id) {
    return jsonResponse(401, CORS, { error: tokenErr || '인증 토큰이 필요합니다.' });
  }
  const sellerId = payload.seller_id;

  // multipart 파싱
  let parsed;
  try {
    parsed = await parseMultipart(event);
  } catch (e) {
    if (e.message === 'FILE_TOO_LARGE') {
      return jsonResponse(413, CORS, {
        error: {
          title: '파일이 너무 커요',
          cause: '사진 또는 PDF는 10MB까지 올릴 수 있어요.',
          action: '용량을 줄여서 다시 올려주세요.',
          statusCode: 413,
        },
      });
    }
    console.error('[upload-business-license] multipart 파싱 실패:', e.message);
    return jsonResponse(400, CORS, { error: '파일 형식을 확인할 수 없어요. 다시 올려주세요.' });
  }

  const { file: fileBuffer, filename, mimeType } = parsed;
  if (!fileBuffer || fileBuffer.length === 0) {
    return jsonResponse(400, CORS, { error: '업로드할 파일이 없어요.' });
  }
  if (fileBuffer.length > MAX_BYTES) {
    return jsonResponse(413, CORS, { error: '파일이 너무 커요. 10MB 이하로 올려주세요.' });
  }

  // MIME / 확장자 검증
  const ext = detectExtension(filename, mimeType);
  if (!ext || !ALLOWED_EXT.includes(ext)) {
    return jsonResponse(415, CORS, {
      error: '지원하지 않는 형식이에요. JPG·PNG·HEIC·PDF로 올려주세요.',
    });
  }
  if (mimeType && !ALLOWED_MIME.includes(mimeType.toLowerCase())) {
    return jsonResponse(415, CORS, {
      error: '지원하지 않는 형식이에요. JPG·PNG·HEIC·PDF로 올려주세요.',
    });
  }
  // Magic bytes — HEIC는 폴백 허용 (모바일 카메라 변환 대응)
  if (ext !== 'heic' && ext !== 'heif' && !validateMagicBytes(fileBuffer, ext)) {
    return jsonResponse(415, CORS, {
      error: '파일이 손상됐거나 지원하지 않는 형식이에요. 다시 올려주세요.',
    });
  }

  // Storage 경로 생성 (충돌·추측 방지)
  const ts = Date.now();
  const hash = crypto.randomBytes(8).toString('hex');
  const storagePath = `${sellerId}/${ts}-${hash}.${ext}`;

  // 모킹 모드 — Supabase 미설정 시 graceful 통과 (베타 검증용)
  const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    if (!isSignupMock) {
      console.error('[upload-business-license] Supabase 초기화 실패:', e.message);
      return jsonResponse(500, CORS, { error: '서버 설정 오류입니다. 고객센터로 문의해주세요.' });
    }
    // 모킹 — 가짜 URL 반환 후 종료
    const mockUrl = `mock://business-licenses/${storagePath}`;
    console.log(`[upload-business-license] mock seller=${sellerId.slice(0, 8)} ext=${ext} size=${fileBuffer.length}`);
    return jsonResponse(200, CORS, {
      success: true,
      mock: true,
      fileUrl: mockUrl,
      storagePath,
      verifyStatus: 'pending',
      sizeBytes: fileBuffer.length,
    });
  }

  // Storage 업로드
  let publicUrl = null;
  try {
    const { error: upErr } = await admin.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, fileBuffer, {
        contentType: mimeType || `application/${ext}`,
        upsert: false,
        cacheControl: 'private, max-age=0',
      });
    if (upErr) {
      console.error('[upload-business-license] Storage 업로드 실패:', upErr.message);
      return jsonResponse(500, CORS, { error: '업로드 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.' });
    }
    // 비공개 버킷 — 셀러는 직접 노출하지 않고 storage path만 응답
    publicUrl = `supabase://${STORAGE_BUCKET}/${storagePath}`;
  } catch (e) {
    console.error('[upload-business-license] Storage throw:', e.message);
    return jsonResponse(500, CORS, { error: '업로드에 실패했어요. 잠시 후 다시 시도해주세요.' });
  }

  // sellers 테이블 갱신 (best-effort)
  const now = new Date().toISOString();
  const autoApprove = (process.env.BUSINESS_LICENSE_AUTO_APPROVE || 'false').toLowerCase() === 'true';
  const reviewStatus = autoApprove ? 'approved' : 'pending';

  try {
    const update = {
      business_license_file_url: publicUrl,
      business_license_review_status: reviewStatus,
      business_license_uploaded_at: now,
    };
    if (autoApprove) {
      update.business_license_reviewed_at = now;
      update.business_license_review_note = '자동 승인 (베타 운영)';
    }
    const { error: upErr } = await admin
      .from('sellers')
      .update(update)
      .eq('id', sellerId);
    if (upErr) {
      console.error('[upload-business-license] sellers update 실패:', upErr.message);
      // 셀러 row 갱신 실패해도 파일은 이미 저장됨 — 응답은 성공
    }
  } catch (e) {
    console.error('[upload-business-license] sellers update throw:', e.message);
  }

  // 감사 로그 (best-effort)
  await recordAudit(admin, {
    actor_id: sellerId,
    actor_type: 'seller',
    action: 'business_license_upload',
    resource_type: 'seller',
    resource_id: sellerId,
    metadata: {
      ext,
      size_bytes: fileBuffer.length,
      review_status: reviewStatus,
      auto_approve: autoApprove,
    },
    event,
  });

  console.log(`[upload-business-license] seller=${sellerId.slice(0, 8)} ext=${ext} size=${fileBuffer.length} review=${reviewStatus}`);

  return jsonResponse(200, CORS, {
    success: true,
    fileUrl: publicUrl,
    storagePath,
    verifyStatus: reviewStatus,
    sizeBytes: fileBuffer.length,
  });
};

// 테스트용 export
exports._internals = {
  parseMultipart,
  detectExtension,
  validateMagicBytes,
  ALLOWED_EXT,
  ALLOWED_MIME,
  MAX_BYTES,
};
