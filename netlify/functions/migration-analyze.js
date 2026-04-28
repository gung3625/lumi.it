// /api/migration-analyze — Sprint 3.5 마이그레이션 마법사 V1
// 헤더 매핑 결과 검수 + 셀러 수정 입력 반영 + 미리보기 재생성
//
// Body: { migrationId, headerOverrides?: { [original]: lumiField }, products? }
// 응답: { success, headerMapping, previews, stats, redFlagFields }
//
// 동작:
// - 클라이언트가 검수 화면에서 일부 매핑 수정 → 다시 정규화
// - migrationId만 있고 products 없으면 캐시 조회 (현재는 stateless: products 다시 받음)

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { applyHeaderMapping, normalizeProduct, validateRow, buildAhaCopy } = require('./_shared/migration/core/lumi-excel-processor');
const { checkProducts } = require('./_shared/migration/transformers/policy-word-checker');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return resp(405, CORS, { error: 'Method not allowed' });

  // seller JWT
  const token = extractBearerToken(event.headers || {});
  try { verifySellerToken(token); } catch { return resp(401, CORS, { error: '인증 실패' }); }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return resp(400, CORS, { error: '잘못된 요청' }); }

  const { migrationId, rawRows, headerMapping = [], headerOverrides = {} } = body;

  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    return resp(400, CORS, { error: 'rawRows 배열 필요 (또는 stateful 캐시 미구현)' });
  }
  if (!Array.isArray(headerMapping)) {
    return resp(400, CORS, { error: 'headerMapping 배열 필요' });
  }

  // 셀러 입력으로 매핑 덮어쓰기
  const finalMapping = headerMapping.map((m) => {
    const override = headerOverrides[m.original];
    if (override !== undefined) {
      return {
        ...m,
        mapped: override === null || override === '' ? null : override,
        confidence: 1.0, // 셀러 직접 수정 = 100%
        source: 'user',
      };
    }
    return m;
  });

  // 재정규화
  const products = rawRows.map((row) => {
    const lumi = normalizeProduct(row, [], finalMapping);
    const errors = validateRow(lumi);
    return { ...lumi, _errors: errors, _valid: errors.length === 0 };
  });

  const policyResult = checkProducts(products.map((p) => ({ product_name: p.title, sku_code: p.sku_code })));
  const valid = products.filter((p) => p._valid).length;
  const redFlagFields = finalMapping.filter((m) => m.confidence < 0.95 && m.mapped).map((m) => m.original);

  const previews = products.slice(0, 5).map((p, i) => ({
    index: i,
    sku_code: p.sku_code,
    title: p.title,
    price: p.price,
    stock: p.stock,
    image_urls: p.image_urls,
    options: p.options,
    valid: p._valid,
    errors: p._errors,
    aha: buildAhaCopy(p),
  }));

  return resp(200, CORS, {
    success: true,
    migrationId,
    headerMapping: finalMapping,
    redFlagFields,
    previews,
    stats: {
      total: products.length,
      valid,
      invalid: products.length - valid,
      policyViolations: policyResult.violatingCount,
    },
    policyWarnings: policyResult.warnings,
  });
};

function resp(statusCode, headers, payload) {
  return {
    statusCode,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}
