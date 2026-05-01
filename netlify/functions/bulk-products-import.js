// 상품 마스터 대량 수정 — 엑셀 일괄 적용
// POST /api/bulk-products-import
// Body: { rows: [{ product_id, title?, price_suggested?, status?, market_overrides?: {...} }], excel_filename? }
//
// 응답: { applied, failed, errors: [{ product_id, error }] }
// 변경 이력 → product_change_log 기록

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const MIN_PRICE = 0;
const MAX_PRICE = 10_000_000;
const VALID_STATUSES = new Set(['draft', 'approved', 'registering', 'live', 'failed']);
const VALID_SHIPPING_TYPES = new Set(['무료배송', '유료배송', '조건부무료', '착불']);
const MAX_ROWS = 1000;

// 업데이트 가능한 products 컬럼
const PRODUCT_DIRECT_FIELDS = new Set(['title', 'description', 'price_suggested', 'status']);

// market_overrides에 저장할 필드
const OVERRIDES_FIELDS = new Set([
  'seller_code', 'model_name', 'brand', 'manufacturer',
  'origin', 'season', 'shipping_type', 'shipping_fee',
  'price_cost', 'price_tag',
]);

function validateRow(row) {
  const errors = [];
  if (!row.product_id) {
    errors.push('product_id가 없어요.');
    return errors;
  }
  if ('title' in row && row.title) {
    const t = String(row.title).trim();
    if (t.length < 2) errors.push('상품명은 2자 이상이어야 해요.');
    if (t.length > 100) errors.push('상품명은 100자를 넘을 수 없어요.');
  }
  if ('price_suggested' in row && row.price_suggested != null) {
    const p = Number(row.price_suggested);
    if (!Number.isFinite(p) || p < MIN_PRICE) errors.push(`판매가는 ${MIN_PRICE}원 이상이어야 해요.`);
    if (p > MAX_PRICE) errors.push(`판매가는 ${MAX_PRICE.toLocaleString()}원을 넘을 수 없어요.`);
  }
  if ('status' in row && row.status && !VALID_STATUSES.has(row.status)) {
    errors.push('상품상태 값이 올바르지 않아요.');
  }
  const ov = row.market_overrides || {};
  if (ov.price_cost != null && Number(ov.price_cost) < 0) errors.push('원가는 0 이상이어야 해요.');
  if (ov.price_tag != null && Number(ov.price_tag) < 0) errors.push('TAG가는 0 이상이어야 해요.');
  if (ov.shipping_fee != null && Number(ov.shipping_fee) < 0) errors.push('배송비는 0 이상이어야 해요.');
  if (ov.shipping_type && !VALID_SHIPPING_TYPES.has(ov.shipping_type)) errors.push('배송비구분 값이 올바르지 않아요.');
  return errors;
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error: authErr } = verifySellerToken(token);
  if (authErr || !payload) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요해요.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청 형식이에요.' }) };
  }

  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '적용할 행이 없어요.' }) };
  }
  if (rows.length > MAX_ROWS) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `한 번에 최대 ${MAX_ROWS}행까지 적용할 수 있어요.` }) };
  }

  const excelFilename = String(body.excel_filename || '').trim() || null;

  let admin;
  try { admin = getAdminClient(); } catch {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
  }

  // 대상 상품 ID 목록 추출
  const productIds = [...new Set(rows.map((r) => r.product_id).filter(Boolean))];

  // 소유권 확인 (seller_id 일치 상품만)
  const { data: dbProducts, error: pErr } = await admin
    .from('products')
    .select('id, title, price_suggested, status, market_overrides')
    .eq('seller_id', payload.seller_id)
    .in('id', productIds);

  if (pErr) {
    console.error('[bulk-products-import] products query error:', pErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '상품 목록을 불러오지 못했어요.' }) };
  }

  const dbMap = {};
  for (const p of (dbProducts || [])) dbMap[p.id] = p;

  let applied = 0;
  let failed = 0;
  const errors = [];
  const changeLogs = [];

  for (const row of rows) {
    const rowErrors = validateRow(row);
    if (rowErrors.length > 0) {
      errors.push({ product_id: row.product_id, error: rowErrors.join(' / ') });
      failed++;
      continue;
    }

    const dbProd = dbMap[row.product_id];
    if (!dbProd) {
      errors.push({ product_id: row.product_id, error: '이 셀러의 상품이 아니거나 존재하지 않아요.' });
      failed++;
      continue;
    }

    // products 컬럼 업데이트 페이로드 구성
    const dbUpdate = { updated_at: new Date().toISOString() };

    // Direct product fields
    if (row.title && String(row.title).trim() !== dbProd.title) {
      dbUpdate.title = String(row.title).trim();
      changeLogs.push({
        seller_id: payload.seller_id,
        product_id: row.product_id,
        field_name: 'title',
        old_value: dbProd.title,
        new_value: dbUpdate.title,
        changed_by: 'excel_import',
        excel_filename: excelFilename,
      });
    }

    if (row.description != null && row.description !== dbProd.description) {
      dbUpdate.description = String(row.description);
      changeLogs.push({
        seller_id: payload.seller_id,
        product_id: row.product_id,
        field_name: 'description',
        old_value: dbProd.description || '',
        new_value: dbUpdate.description,
        changed_by: 'excel_import',
        excel_filename: excelFilename,
      });
    }

    if (row.price_suggested != null && Number(row.price_suggested) !== dbProd.price_suggested) {
      dbUpdate.price_suggested = Math.trunc(Number(row.price_suggested));
      changeLogs.push({
        seller_id: payload.seller_id,
        product_id: row.product_id,
        field_name: 'price_suggested',
        old_value: String(dbProd.price_suggested),
        new_value: String(dbUpdate.price_suggested),
        changed_by: 'excel_import',
        excel_filename: excelFilename,
      });
    }

    if (row.status && row.status !== dbProd.status) {
      dbUpdate.status = row.status;
      changeLogs.push({
        seller_id: payload.seller_id,
        product_id: row.product_id,
        field_name: 'status',
        old_value: dbProd.status,
        new_value: row.status,
        changed_by: 'excel_import',
        excel_filename: excelFilename,
      });
    }

    // market_overrides 병합
    const existingOv = dbProd.market_overrides || {};
    const incomingOv = row.market_overrides || {};
    const mergedOv = { ...existingOv };
    let ovChanged = false;
    for (const field of OVERRIDES_FIELDS) {
      if (field in incomingOv && incomingOv[field] != null && String(incomingOv[field]) !== String(existingOv[field] ?? '')) {
        changeLogs.push({
          seller_id: payload.seller_id,
          product_id: row.product_id,
          field_name: field,
          old_value: existingOv[field] != null ? String(existingOv[field]) : '',
          new_value: String(incomingOv[field]),
          changed_by: 'excel_import',
          excel_filename: excelFilename,
        });
        mergedOv[field] = incomingOv[field];
        ovChanged = true;
      }
    }
    if (ovChanged) dbUpdate.market_overrides = mergedOv;

    // 변경 없으면 스킵
    if (Object.keys(dbUpdate).length === 1) { // updated_at만
      applied++;
      continue;
    }

    const { error: uErr } = await admin
      .from('products')
      .update(dbUpdate)
      .eq('id', row.product_id)
      .eq('seller_id', payload.seller_id);

    if (uErr) {
      console.error(`[bulk-products-import] update error product=${row.product_id}:`, uErr.message);
      errors.push({ product_id: row.product_id, error: '저장 중 오류가 발생했어요.' });
      failed++;
    } else {
      applied++;
    }
  }

  // 변경 이력 일괄 저장 (실패해도 메인 응답에 영향 X)
  if (changeLogs.length > 0) {
    const BATCH = 500;
    for (let i = 0; i < changeLogs.length; i += BATCH) {
      const { error: logErr } = await admin
        .from('product_change_log')
        .insert(changeLogs.slice(i, i + BATCH));
      if (logErr) {
        console.error('[bulk-products-import] change log insert error:', logErr.message);
      }
    }
  }

  console.log(`[bulk-products-import] seller=${payload.seller_id.slice(0,8)} applied=${applied} failed=${failed} logs=${changeLogs.length}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: applied > 0,
      applied,
      failed,
      errors,
    }),
  };
};
