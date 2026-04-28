// /api/migration-upload — Sprint 3.5 마이그레이션 마법사 V1
// multipart 엑셀 업로드 → 메모리 처리 → 분석 결과 응답
//
// 흐름:
// 1. seller JWT 검증
// 2. multipart parse (busboy 또는 base64 fallback)
// 3. processExcelBuffer 호출 (인코딩 감지 + 솔루션 추론 + 헤더 매핑)
// 4. 결과 캐시 (선택: Supabase 또는 메모리 — 현재는 응답만)
// 5. JSON 응답 (5개 미리보기 + stats + headerMapping)
//
// 환경변수:
//   AI_MIGRATION_MOCK=true → AI 헤더 매핑 모킹 (베타 시작 시 비용 0)

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { recordAudit } = require('./_shared/onboarding-utils');
const { processExcelBuffer } = require('./_shared/migration/core/lumi-excel-processor');

const MAX_BODY_BYTES = 60 * 1024 * 1024; // multipart 오버헤드 포함

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return resp(405, CORS, { error: 'Method not allowed' });
  }

  // seller JWT 검증
  const token = extractBearerToken(event.headers || {});
  let claims;
  try {
    claims = verifySellerToken(token);
  } catch (e) {
    return resp(401, CORS, { error: '인증 실패. 다시 로그인해주세요.' });
  }

  const sellerId = claims?.seller_id;
  if (!sellerId) return resp(401, CORS, { error: '셀러 인증 정보 누락' });

  // body 추출 (multipart 또는 base64)
  let buffer;
  let filename = 'upload.xlsx';
  try {
    const parsed = parseMultipartOrBase64(event);
    buffer = parsed.buffer;
    filename = parsed.filename || filename;
  } catch (e) {
    return resp(400, CORS, { error: `파일 추출 실패: ${e.message}` });
  }

  if (!buffer || buffer.length === 0) {
    return resp(400, CORS, { error: '파일이 비어있습니다.' });
  }
  if (buffer.length > MAX_BODY_BYTES) {
    return resp(413, CORS, { error: `파일이 너무 커요 (${Math.floor(buffer.length / 1024 / 1024)}MB). 50MB 이하로 올려주세요.` });
  }

  // 처리
  let result;
  try {
    result = await processExcelBuffer(buffer, {
      filename,
      mockAi: process.env.AI_MIGRATION_MOCK === 'true',
    });
  } catch (e) {
    return resp(500, CORS, { error: `처리 실패: ${e.message}` });
  }

  if (!result.success) {
    return resp(400, CORS, { error: result.error });
  }

  // audit log (개인정보 미포함)
  try {
    const { getAdminClient } = require('./_shared/supabase-admin');
    const admin = getAdminClient();
    await recordAudit(admin, {
      seller_id: sellerId,
      action: 'migration_upload',
      target_type: 'migration',
      target_id: result.migrationId,
      metadata: {
        solution: result.solution,
        confidence: result.solutionConfidence,
        rows: result.stats.total,
        valid: result.stats.valid,
        filename: filename.slice(0, 100),
      },
    });
  } catch (_) { /* audit 실패는 비치명적 */ }

  return resp(200, CORS, {
    success: true,
    migrationId: result.migrationId,
    solution: result.solution,
    solutionConfidence: result.solutionConfidence,
    headerMapping: result.headerMapping,
    optionMode: result.optionMode,
    previews: result.previews,
    stats: result.stats,
    policyWarnings: result.policyWarnings,
    warnings: result.warnings,
    // products 전체는 migration-analyze 또는 execute에서 다시 조회
    productsCount: result.products?.length || 0,
  });
};

/**
 * multipart/form-data 또는 base64 JSON 파싱.
 * Netlify Functions는 lambda-style event 사용.
 */
function parseMultipartOrBase64(event) {
  const contentType = (event.headers?.['content-type'] || event.headers?.['Content-Type'] || '').toLowerCase();
  const body = event.body || '';

  // base64 JSON 폴백 (테스트·모바일 단순화 경로)
  if (contentType.includes('application/json')) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { throw new Error('JSON 파싱 실패'); }
    if (!parsed.fileBase64) throw new Error('fileBase64 필드 누락');
    return {
      buffer: Buffer.from(parsed.fileBase64, 'base64'),
      filename: parsed.filename || 'upload.xlsx',
    };
  }

  // multipart/form-data 파싱 (간이 — Netlify는 base64 인코딩된 body 제공)
  if (contentType.includes('multipart/form-data')) {
    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) throw new Error('multipart boundary 누락');
    const boundary = boundaryMatch[1].replace(/^["']|["']$/g, '');

    const bodyBuf = event.isBase64Encoded
      ? Buffer.from(body, 'base64')
      : Buffer.from(body, 'binary');

    const parts = splitMultipart(bodyBuf, boundary);
    const filePart = parts.find((p) => p.headers.includes('filename='));
    if (!filePart) throw new Error('파일 part 미발견');

    const filenameMatch = filePart.headers.match(/filename="([^"]+)"/);
    return {
      buffer: filePart.body,
      filename: filenameMatch ? filenameMatch[1] : 'upload.xlsx',
    };
  }

  throw new Error(`Unsupported Content-Type: ${contentType}`);
}

/**
 * multipart 파싱 — boundary 분리 (간이, busboy 미사용).
 */
function splitMultipart(buf, boundary) {
  const delimiter = Buffer.from('--' + boundary);
  const parts = [];
  let start = buf.indexOf(delimiter);
  if (start < 0) return parts;

  while (start >= 0) {
    const next = buf.indexOf(delimiter, start + delimiter.length);
    if (next < 0) break;
    const partBuf = buf.subarray(start + delimiter.length, next);
    const headerEnd = partBuf.indexOf('\r\n\r\n');
    if (headerEnd > 0) {
      const headers = partBuf.subarray(0, headerEnd).toString('utf-8');
      let body = partBuf.subarray(headerEnd + 4);
      // 끝의 \r\n 제거
      if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
        body = body.subarray(0, body.length - 2);
      }
      parts.push({ headers, body });
    }
    start = next;
  }
  return parts;
}

function resp(statusCode, headers, payload) {
  return {
    statusCode,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}
