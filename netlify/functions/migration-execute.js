// /api/migration-execute — Sprint 3.5 마이그레이션 V1
// 검수 완료된 Lumi 표준 상품 배열 → DB INSERT (+ 선택적 마켓 등록)
//
// Body: { migrationId, products: [Lumi standard], markets?: ['coupang','naver'], dryRun?: true }
// 응답: { success, inserted, failed, marketResults }
//
// 동작:
// 1. seller JWT
// 2. products 배열 검증 (validateRow)
// 3. Supabase products 테이블 INSERT (배치 200개씩)
// 4. markets 지정 시 register-product 호출 (현재 V1은 스킵, 셀러가 별도 등록 흐름)

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { recordAudit } = require('./_shared/onboarding-utils');
const { validateRow } = require('./_shared/migration/core/lumi-excel-processor');

const BATCH_SIZE = 200;

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return resp(405, CORS, { error: 'Method not allowed' });

  const token = extractBearerToken(event.headers || {});
  let claims;
  try { claims = verifySellerToken(token); }
  catch { return resp(401, CORS, { error: '인증 실패' }); }

  const sellerId = claims?.seller_id;
  if (!sellerId) return resp(401, CORS, { error: '셀러 정보 누락' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return resp(400, CORS, { error: '잘못된 요청' }); }

  const { migrationId, products = [], dryRun = false } = body;
  if (!Array.isArray(products) || products.length === 0) {
    return resp(400, CORS, { error: 'products 배열 필요' });
  }

  // 검증
  const valid = [];
  const failed = [];
  for (const p of products) {
    const errors = validateRow(p);
    if (errors.length === 0) valid.push(p);
    else failed.push({ sku_code: p.sku_code, errors });
  }

  if (dryRun) {
    return resp(200, CORS, {
      success: true,
      dryRun: true,
      migrationId,
      wouldInsert: valid.length,
      failed: failed.length,
      failedItems: failed.slice(0, 10),
    });
  }

  // 실제 INSERT
  let admin;
  try {
    const { getAdminClient } = require('./_shared/supabase-admin');
    admin = getAdminClient();
  } catch (e) {
    return resp(500, CORS, { error: `DB 연결 실패: ${e.message}` });
  }

  const inserted = [];
  const insertErrors = [];

  for (let i = 0; i < valid.length; i += BATCH_SIZE) {
    const chunk = valid.slice(i, i + BATCH_SIZE);
    const rows = chunk.map((p) => ({
      seller_id: sellerId,
      sku_code: p.sku_code,
      title: p.title,
      price: p.price,
      msrp: p.msrp || null,
      stock: p.stock,
      options: p.options || [],
      category_id: p.category_id || null,
      image_urls: p.image_urls || [],
      tax_type: p.tax_type || '과세',
      source: 'migration',
      migration_id: migrationId,
      created_at: new Date().toISOString(),
    }));

    try {
      const { data, error } = await admin.from('products').upsert(rows, {
        onConflict: 'seller_id,sku_code',
        ignoreDuplicates: false,
      }).select('id, sku_code');

      if (error) {
        insertErrors.push({ batch: i / BATCH_SIZE, error: error.message, count: chunk.length });
      } else if (Array.isArray(data)) {
        inserted.push(...data);
      }
    } catch (e) {
      insertErrors.push({ batch: i / BATCH_SIZE, error: e.message, count: chunk.length });
    }
  }

  // audit log
  try {
    await recordAudit(admin, {
      seller_id: sellerId,
      action: 'migration_execute',
      target_type: 'migration',
      target_id: migrationId,
      metadata: {
        attempted: valid.length,
        inserted: inserted.length,
        failed: failed.length,
        insertErrors: insertErrors.length,
      },
    });
  } catch (_) {}

  return resp(200, CORS, {
    success: true,
    migrationId,
    inserted: inserted.length,
    failed: failed.length,
    failedItems: failed.slice(0, 20),
    insertErrors,
  });
};

function resp(statusCode, headers, payload) {
  return {
    statusCode,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}
