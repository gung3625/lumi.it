// 옵션 대량 수정 미리보기 — Sprint 5
// POST /api/bulk-options-preview
// Content-Type: multipart/form-data  (file: xlsx)
//
// 엑셀 파싱 → 현재 DB 값과 비교 → 변경 내역 + 검증 오류 반환 (저장 안 함)
// 응답: { changes: [{option_id, field, old, new}, ...], errors: [...], summary: {...} }

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const XLSX = require('xlsx');
const busboy = require('busboy');

const MAX_ROWS = 5000;
const EDITABLE_FIELDS = ['sku', '판매가', '재고', '추가금액'];
const FIELD_MAP = {
  'SKU':    'sku',
  '판매가':  'price',
  '재고':    'stock',
  '추가금액': 'extra_price',
};

/**
 * multipart/form-data 에서 xlsx 파일 버퍼 추출
 */
function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    let fileBuffer = null;
    let filename = '';
    const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';
    const bb = busboy({ headers: { 'content-type': contentType } });

    bb.on('file', (_field, stream, info) => {
      filename = info.filename || 'upload.xlsx';
      const chunks = [];
      stream.on('data', (d) => chunks.push(d));
      stream.on('end', () => { fileBuffer = Buffer.concat(chunks); });
    });
    bb.on('finish', () => resolve({ fileBuffer, filename }));
    bb.on('error', reject);

    const body = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body || '', 'utf8');
    bb.write(body);
    bb.end();
  });
}

/**
 * 숫자 필드 검증
 */
function validateNumeric(label, raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return `${label}은 0 이상 정수여야 해요. (입력값: ${raw})`;
  return null;
}

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

  let admin;
  try { admin = getAdminClient(); } catch {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
  }

  // ── 파일 파싱 ─────────────────────────────────────────────────────────
  let fileBuffer, filename;
  try {
    ({ fileBuffer, filename } = await parseMultipart(event));
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '파일 파싱 실패: ' + e.message }) };
  }
  if (!fileBuffer || fileBuffer.length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '파일이 없어요. xlsx 파일을 첨부해주세요.' }) };
  }

  let wb;
  try {
    wb = XLSX.read(fileBuffer, { type: 'buffer' });
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '엑셀 파일을 읽지 못했어요. xlsx 형식인지 확인해주세요.' }) };
  }

  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  if (rows.length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '엑셀에 데이터가 없어요.' }) };
  }
  if (rows.length > MAX_ROWS) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `한 번에 최대 ${MAX_ROWS}행까지 처리할 수 있어요.` }) };
  }

  // ── 옵션ID 추출 + DB 조회 ─────────────────────────────────────────────
  const optionIds = [...new Set(rows.map((r) => String(r['옵션ID'] || '').trim()).filter(Boolean))];
  if (optionIds.length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '옵션ID 컬럼이 없거나 비어있어요.' }) };
  }

  // seller 소유 검증 포함 (products JOIN)
  const { data: dbOptions, error: dbErr } = await admin
    .from('product_options')
    .select(`
      id, product_id, option_name, sku, price, stock, extra_price,
      products!inner(seller_id, title, price_suggested)
    `)
    .in('id', optionIds)
    .eq('products.seller_id', payload.seller_id);

  if (dbErr) {
    console.error('[bulk-options-preview] db error:', dbErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'DB 조회 실패' }) };
  }

  const dbMap = Object.fromEntries((dbOptions || []).map((o) => [o.id, o]));

  // ── 행별 변경 분석 ────────────────────────────────────────────────────
  const changes = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // 엑셀 행 번호 (1행=헤더)
    const optionId = String(row['옵션ID'] || '').trim();

    if (!optionId) {
      errors.push({ row: rowNum, message: '옵션ID가 비어있어요.' });
      continue;
    }

    const dbOpt = dbMap[optionId];
    if (!dbOpt) {
      errors.push({ row: rowNum, option_id: optionId, message: '옵션을 찾을 수 없거나 접근 권한이 없어요.' });
      continue;
    }

    const productTitle = dbOpt.products?.title || '';
    const defaultPrice = dbOpt.products?.price_suggested ?? 0;

    // 각 수정 가능 필드 비교
    for (const [excelCol, dbField] of Object.entries(FIELD_MAP)) {
      if (!(excelCol in row)) continue; // 컬럼 없으면 스킵
      const rawVal = String(row[excelCol] ?? '').trim();
      if (rawVal === '') continue; // 빈 값은 변경 없음

      // 숫자 검증
      if (dbField !== 'sku') {
        const err = validateNumeric(excelCol, rawVal);
        if (err) {
          errors.push({ row: rowNum, option_id: optionId, field: dbField, message: err });
          continue;
        }
      }

      const newVal = dbField === 'sku' ? rawVal : Number(rawVal);

      // 가격 상한 검증
      if (dbField === 'price' && newVal > 10_000_000) {
        errors.push({ row: rowNum, option_id: optionId, field: 'price', message: `판매가가 너무 높아요 (최대 1천만원). 입력값: ${newVal}` });
        continue;
      }

      const currentVal = dbOpt[dbField] !== null && dbOpt[dbField] !== undefined
        ? dbOpt[dbField]
        : (dbField === 'price' ? defaultPrice : (dbField === 'sku' ? '' : 0));

      // 실제 변경이 있을 때만 추가
      const currentStr = String(currentVal ?? '');
      const newStr     = String(newVal);
      if (currentStr === newStr) continue;

      changes.push({
        option_id:      optionId,
        product_id:     dbOpt.product_id,
        product_title:  productTitle,
        option_name:    dbOpt.option_name,
        field:          dbField,
        old:            currentVal,
        new:            newVal,
      });
    }
  }

  const summary = {
    total_rows:       rows.length,
    option_ids_found: Object.keys(dbMap).length,
    changes_count:    changes.length,
    errors_count:     errors.length,
    filename,
  };

  console.log(`[bulk-options-preview] seller=${payload.seller_id.slice(0,8)} rows=${rows.length} changes=${changes.length} errors=${errors.length}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ changes, errors, summary }),
  };
};
