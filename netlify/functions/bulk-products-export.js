// 상품 마스터 대량 수정 — 엑셀 다운로드
// GET /api/bulk-products-export
// 쿼리: category?, market?, status?, date_from?, date_to?, page?, limit?
//
// 응답: xlsx 파일 다운로드
// 컬럼: 품번코드/자체상품코드/상품명/모델명/브랜드/제조사/원산지/시즌/상품상태/배송비구분/배송비/원가/판매가/TAG가

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const XLSX = require('xlsx');

// 한국 상거래 표준 컬럼 헤더
const COLUMNS = [
  { key: 'product_code',    header: '품번코드',     width: 18 },
  { key: 'seller_code',     header: '자체상품코드', width: 18 },
  { key: 'title',           header: '상품명',       width: 40 },
  { key: 'model_name',      header: '모델명',       width: 20 },
  { key: 'brand',           header: '브랜드',       width: 16 },
  { key: 'manufacturer',    header: '제조사',       width: 16 },
  { key: 'origin',          header: '원산지',       width: 14 },
  { key: 'season',          header: '시즌',         width: 10 },
  { key: 'status',          header: '상품상태',     width: 12 },
  { key: 'shipping_type',   header: '배송비구분',   width: 12 },
  { key: 'shipping_fee',    header: '배송비',       width: 10 },
  { key: 'price_cost',      header: '원가',         width: 12 },
  { key: 'price_suggested', header: '판매가',       width: 12 },
  { key: 'price_tag',       header: 'TAG가',        width: 12 },
];

// market_overrides JSONB에서 추가 필드 추출
function extractOverrides(product) {
  const ov = product.market_overrides || {};
  return {
    product_code:    product.id ? product.id.split('-')[0].toUpperCase() : '',
    seller_code:     ov.seller_code   || ov.seller_product_code || '',
    title:           product.title    || '',
    model_name:      ov.model_name    || '',
    brand:           ov.brand         || '',
    manufacturer:    ov.manufacturer  || '',
    origin:          ov.origin        || '',
    season:          ov.season        || '',
    status:          product.status   || '',
    shipping_type:   ov.shipping_type || '무료배송',
    shipping_fee:    ov.shipping_fee  != null ? Number(ov.shipping_fee) : 0,
    price_cost:      ov.price_cost    != null ? Number(ov.price_cost)   : 0,
    price_suggested: product.price_suggested || 0,
    price_tag:       ov.price_tag     != null ? Number(ov.price_tag)    : 0,
  };
}

const MAX_EXPORT = 5000;

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error: authErr } = verifySellerToken(token);
  if (authErr || !payload) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요해요.' }) };
  }

  let admin;
  try { admin = getAdminClient(); } catch {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
  }

  const params = event.queryStringParameters || {};
  const limit = Math.min(parseInt(params.limit || '1000', 10), MAX_EXPORT);

  let query = admin.from('products')
    .select('id, title, description, price_suggested, status, market_overrides, created_at, updated_at')
    .eq('seller_id', payload.seller_id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (params.status)    query = query.eq('status', params.status);
  if (params.date_from) query = query.gte('created_at', params.date_from);
  if (params.date_to)   query = query.lte('created_at', params.date_to + 'T23:59:59Z');

  const { data: products, error: pErr } = await query;
  if (pErr) {
    console.error('[bulk-products-export] query error:', pErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '상품 목록을 불러오지 못했어요.' }) };
  }

  const rows = (products || []).map((p) => {
    const flat = extractOverrides(p);
    return COLUMNS.map((c) => flat[c.key] ?? '');
  });

  // 워크북 생성
  const wb = XLSX.utils.book_new();
  const wsData = [COLUMNS.map((c) => c.header), ...rows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // 컬럼 너비 설정
  ws['!cols'] = COLUMNS.map((c) => ({ wch: c.width }));

  // 헤더 행 스타일 (볼드 효과를 위해 빈 행을 명시적으로 스타일 지정)
  XLSX.utils.book_append_sheet(wb, ws, '상품마스터');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const base64 = buf.toString('base64');

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const filename = `lumi_products_${today}.xlsx`;

  console.log(`[bulk-products-export] seller=${payload.seller_id.slice(0,8)} count=${(products||[]).length} filename=${filename}`);

  return {
    statusCode: 200,
    headers: {
      ...CORS,
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Transfer-Encoding': 'base64',
    },
    body: base64,
    isBase64Encoded: true,
  };
};
