// 상품 마스터 대량 수정 — 엑셀 미리보기 (변경 비교)
// POST /api/bulk-products-preview
// Body: multipart form-data (file: xlsx)
//
// 응답: { rows: [{ id, product_code, title, changes: [{field, old, new, valid}], errors }] }
// 검증: 필수 필드 누락, 가격 음수/범위 초과, 상태값 유효성

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const busboy = require('busboy');
const XLSX = require('xlsx');

const REQUIRED_HEADERS = ['품번코드', '상품명', '판매가'];
const MIN_PRICE = 0;
const MAX_PRICE = 10_000_000;
const VALID_STATUSES = new Set(['draft', 'approved', 'registering', 'live', 'failed']);
const VALID_SHIPPING_TYPES = new Set(['무료배송', '유료배송', '조건부무료', '착불']);

// 헤더 → DB 필드 매핑
const HEADER_MAP = {
  '품번코드':     'product_code',
  '자체상품코드': 'seller_code',
  '상품명':       'title',
  '모델명':       'model_name',
  '브랜드':       'brand',
  '제조사':       'manufacturer',
  '원산지':       'origin',
  '시즌':         'season',
  '상품상태':     'status',
  '배송비구분':   'shipping_type',
  '배송비':       'shipping_fee',
  '원가':         'price_cost',
  '판매가':       'price_suggested',
  'TAG가':        'price_tag',
};

// 엑셀에서 숫자 추출 (한글 콤마/원 등 제거)
function parseNum(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[,원￦\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const bb = busboy({ headers: { 'content-type': event.headers['content-type'] || event.headers['Content-Type'] } });
    bb.on('file', (_name, stream) => {
      stream.on('data', (d) => chunks.push(d));
      stream.on('end', () => {});
    });
    bb.on('finish', () => resolve(Buffer.concat(chunks)));
    bb.on('error', reject);
    const body = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64')
      : Buffer.from(event.body || '', 'utf8');
    bb.write(body);
    bb.end();
  });
}

function validateRow(row) {
  const errors = [];
  if (!row.title || String(row.title).trim().length < 2) {
    errors.push('상품명은 2자 이상이어야 해요.');
  }
  if (row.price_suggested != null) {
    const p = Number(row.price_suggested);
    if (!Number.isFinite(p) || p < MIN_PRICE) errors.push(`판매가는 ${MIN_PRICE}원 이상이어야 해요.`);
    if (p > MAX_PRICE) errors.push(`판매가는 ${MAX_PRICE.toLocaleString()}원을 넘을 수 없어요.`);
  }
  if (row.price_cost != null && Number(row.price_cost) < 0) {
    errors.push('원가는 0 이상이어야 해요.');
  }
  if (row.price_tag != null && Number(row.price_tag) < 0) {
    errors.push('TAG가는 0 이상이어야 해요.');
  }
  if (row.shipping_fee != null && Number(row.shipping_fee) < 0) {
    errors.push('배송비는 0 이상이어야 해요.');
  }
  if (row.status && !VALID_STATUSES.has(row.status)) {
    errors.push(`상품상태 값이 올바르지 않아요 (draft/approved/live 등).`);
  }
  if (row.shipping_type && !VALID_SHIPPING_TYPES.has(row.shipping_type)) {
    errors.push(`배송비구분 값이 올바르지 않아요 (무료배송/유료배송/조건부무료/착불).`);
  }
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

  // 파일 파싱
  let fileBuffer;
  try {
    fileBuffer = await parseMultipart(event);
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '파일 파싱에 실패했어요. 엑셀 파일인지 확인해주세요.' }) };
  }

  if (!fileBuffer || fileBuffer.length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '파일이 없어요.' }) };
  }

  let wb;
  try {
    wb = XLSX.read(fileBuffer, { type: 'buffer' });
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '엑셀 파일을 읽을 수 없어요.' }) };
  }

  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '엑셀에 시트가 없어요.' }) };
  }

  const rawRows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
  if (rawRows.length < 2) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '데이터가 없어요. (헤더 + 1행 이상 필요)' }) };
  }

  const headers = rawRows[0].map((h) => String(h).trim());

  // 필수 헤더 검증
  const missingHeaders = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missingHeaders.length > 0) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: `필수 헤더가 없어요: ${missingHeaders.join(', ')}` }),
    };
  }

  // 헤더 인덱스 맵
  const hIdx = {};
  headers.forEach((h, i) => { if (HEADER_MAP[h]) hIdx[HEADER_MAP[h]] = i; });

  // 행 파싱
  const excelRows = [];
  for (let i = 1; i < rawRows.length; i++) {
    const r = rawRows[i];
    if (r.every((v) => v === '' || v == null)) continue; // 빈 행 스킵
    const row = {};
    for (const [field, idx] of Object.entries(hIdx)) {
      const raw = r[idx];
      if (['price_suggested', 'price_cost', 'price_tag', 'shipping_fee'].includes(field)) {
        row[field] = parseNum(raw);
      } else {
        row[field] = raw != null ? String(raw).trim() : '';
      }
    }
    row._excel_row = i + 1; // 1-indexed 행 번호
    excelRows.push(row);
  }

  if (excelRows.length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '처리할 상품 행이 없어요.' }) };
  }
  if (excelRows.length > 1000) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '한 번에 최대 1,000행까지 처리할 수 있어요.' }) };
  }

  let admin;
  try { admin = getAdminClient(); } catch {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
  }

  // 품번코드(product_code)로 DB 조회 — id 앞 8자 접두어 기반으로 매핑
  // product_code는 id split('-')[0].toUpperCase() 형태
  // DB에서 전체 상품 가져와서 in-memory 매핑
  const { data: dbProducts, error: pErr } = await admin
    .from('products')
    .select('id, title, price_suggested, status, market_overrides')
    .eq('seller_id', payload.seller_id)
    .order('created_at', { ascending: false })
    .limit(5000);

  if (pErr) {
    console.error('[bulk-products-preview] products query error:', pErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '상품 목록을 불러오지 못했어요.' }) };
  }

  // product_code → DB 상품 매핑
  const productByCode = {};
  for (const p of (dbProducts || [])) {
    const code = p.id.split('-')[0].toUpperCase();
    productByCode[code] = p;
  }

  const previewRows = [];
  let totalErrors = 0;

  for (const row of excelRows) {
    const rowErrors = validateRow(row);
    const code = (row.product_code || '').toUpperCase();
    const dbProd = productByCode[code];

    if (!dbProd && code) {
      rowErrors.push(`품번코드 ${code}에 해당하는 상품을 찾을 수 없어요.`);
    }

    // 변경 사항 비교
    const changes = [];
    if (dbProd) {
      const ov = dbProd.market_overrides || {};

      // title
      if (row.title && row.title !== dbProd.title) {
        changes.push({ field: '상품명', old: dbProd.title, new: row.title, valid: rowErrors.filter((e) => e.includes('상품명')).length === 0 });
      }
      // price_suggested
      if (row.price_suggested != null && row.price_suggested !== dbProd.price_suggested) {
        changes.push({ field: '판매가', old: dbProd.price_suggested, new: row.price_suggested, valid: rowErrors.filter((e) => e.includes('판매가')).length === 0 });
      }
      // status
      if (row.status && row.status !== dbProd.status) {
        changes.push({ field: '상품상태', old: dbProd.status, new: row.status, valid: true });
      }
      // market_overrides fields
      const ovFields = [
        ['seller_code', '자체상품코드'],
        ['model_name', '모델명'],
        ['brand', '브랜드'],
        ['manufacturer', '제조사'],
        ['origin', '원산지'],
        ['season', '시즌'],
        ['shipping_type', '배송비구분'],
        ['shipping_fee', '배송비'],
        ['price_cost', '원가'],
        ['price_tag', 'TAG가'],
      ];
      for (const [field, label] of ovFields) {
        if (row[field] != null && row[field] !== '' && String(row[field]) !== String(ov[field] ?? '')) {
          changes.push({ field: label, old: ov[field] ?? '', new: row[field], valid: true });
        }
      }
    }

    if (rowErrors.length > 0) totalErrors++;

    previewRows.push({
      excel_row: row._excel_row,
      product_code: code,
      product_id: dbProd?.id || null,
      title: row.title || dbProd?.title || '',
      changes,
      errors: rowErrors,
      matched: !!dbProd,
    });
  }

  console.log(`[bulk-products-preview] seller=${payload.seller_id.slice(0,8)} rows=${excelRows.length} errors=${totalErrors}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      total: excelRows.length,
      matched: previewRows.filter((r) => r.matched).length,
      with_changes: previewRows.filter((r) => r.changes.length > 0).length,
      with_errors: totalErrors,
      rows: previewRows,
    }),
  };
};
