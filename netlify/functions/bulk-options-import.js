// 옵션 대량 수정 적용 — Sprint 5
// POST /api/bulk-options-import
// Body: { changes: [{option_id, field, old, new, product_id?, option_name?}], filename?: string }
//
// preview에서 확정한 변경을 실제로 DB에 적용
// 응답: { applied: N, failed: M, errors: [...] }

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const ALLOWED_FIELDS = new Set(['sku', 'price', 'stock', 'extra_price']);
const MAX_CHANGES = 5000;

exports.handler = async (event) => {
  const origin = getOrigin(event);
  const CORS = corsHeaders(origin, { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // 인증
  const token = extractBearerToken(event);
  const { payload, error: authErr } = verifySellerToken(token);
  if (authErr || !payload) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요해요.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청 형식이에요.' }) };
  }

  const changes = Array.isArray(body.changes) ? body.changes : [];
  const excelFilename = String(body.filename || '').slice(0, 255);

  if (changes.length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '적용할 변경 내역이 없어요.' }) };
  }
  if (changes.length > MAX_CHANGES) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `한 번에 최대 ${MAX_CHANGES}건까지 적용할 수 있어요.` }) };
  }

  let admin;
  try { admin = getAdminClient(); } catch {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
  }

  const sellerId = payload.seller_id;

  // ── 옵션ID 소유권 사전 검증 ───────────────────────────────────────────
  const optionIds = [...new Set(changes.map((c) => String(c.option_id || '')).filter(Boolean))];
  if (optionIds.length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'option_id가 없어요.' }) };
  }

  const { data: ownedOptions, error: ownerErr } = await admin
    .from('product_options')
    .select('id, product_id, sku, price, stock, extra_price, products!inner(seller_id)')
    .in('id', optionIds)
    .eq('products.seller_id', sellerId);

  if (ownerErr) {
    console.error('[bulk-options-import] ownership check error:', ownerErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'DB 조회 실패' }) };
  }

  const ownedSet = new Set((ownedOptions || []).map((o) => o.id));
  const currentMap = Object.fromEntries((ownedOptions || []).map((o) => [o.id, o]));

  // ── 변경사항을 옵션별로 그룹화 ────────────────────────────────────────
  // option_id → { field: newVal, ... }
  const updateMap = {}; // option_id → patch object
  const logEntries = [];
  const errors = [];

  for (const change of changes) {
    const optId  = String(change.option_id || '').trim();
    const field  = String(change.field     || '').trim();
    const newVal = change.new;

    if (!optId) { errors.push({ option_id: optId, field, message: 'option_id가 없어요.' }); continue; }
    if (!ALLOWED_FIELDS.has(field)) { errors.push({ option_id: optId, field, message: `수정할 수 없는 필드예요: ${field}` }); continue; }
    if (!ownedSet.has(optId)) { errors.push({ option_id: optId, field, message: '옵션을 찾을 수 없거나 권한이 없어요.' }); continue; }

    // 추가 검증
    if (field !== 'sku') {
      const n = Number(newVal);
      if (!Number.isInteger(n) || n < 0) {
        errors.push({ option_id: optId, field, message: `${field}은 0 이상 정수여야 해요. 입력값: ${newVal}` });
        continue;
      }
      if (field === 'price' && n > 10_000_000) {
        errors.push({ option_id: optId, field, message: `판매가가 너무 높아요 (최대 1천만원). 입력값: ${n}` });
        continue;
      }
    }

    if (!updateMap[optId]) updateMap[optId] = {};
    updateMap[optId][field] = field === 'sku' ? String(newVal ?? '') : Number(newVal);

    // 이력 엔트리 준비
    const current = currentMap[optId];
    logEntries.push({
      seller_id:      sellerId,
      option_id:      optId,
      product_id:     current?.product_id ?? (change.product_id || null),
      field_name:     field,
      old_value:      String(current?.[field] ?? ''),
      new_value:      String(field === 'sku' ? (newVal ?? '') : Number(newVal)),
      changed_by:     'bulk_import',
      excel_filename: excelFilename || null,
    });
  }

  // ── 옵션별 UPDATE 실행 ────────────────────────────────────────────────
  let applied = 0;
  let failed  = 0;

  const optionEntries = Object.entries(updateMap);
  // 배치 처리 (50개씩 병렬)
  const BATCH = 50;
  for (let i = 0; i < optionEntries.length; i += BATCH) {
    const batch = optionEntries.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(([optId, patch]) =>
        admin
          .from('product_options')
          .update({ ...patch })
          .eq('id', optId)
          .then(({ error: uErr }) => {
            if (uErr) throw new Error(uErr.message);
          })
      )
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === 'fulfilled') {
        applied++;
      } else {
        failed++;
        const optId = batch[j][0];
        errors.push({ option_id: optId, message: r.reason?.message || '업데이트 실패' });
        console.error('[bulk-options-import] update failed optId=', optId, r.reason?.message);
      }
    }
  }

  // ── 변경 이력 INSERT ──────────────────────────────────────────────────
  if (logEntries.length > 0) {
    // 실패한 옵션 제외
    const failedIds = new Set(errors.filter((e) => e.option_id).map((e) => e.option_id));
    const successLog = logEntries.filter((l) => !failedIds.has(l.option_id));
    if (successLog.length > 0) {
      const { error: logErr } = await admin.from('option_change_log').insert(successLog);
      if (logErr) console.error('[bulk-options-import] log insert error:', logErr.message);
    }
  }

  console.log(`[bulk-options-import] seller=${sellerId.slice(0,8)} applied=${applied} failed=${failed} errors=${errors.length} file=${excelFilename}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      applied,
      failed,
      errors,
      total: changes.length,
    }),
  };
};
