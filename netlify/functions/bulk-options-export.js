// 옵션 대량 내보내기 — Sprint 5
// GET /api/bulk-options-export?product_id=&category=&market=&zero_stock=1&min_price=&max_price=
//
// 응답: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
// 컬럼: 상품ID | 상품명 | 옵션ID | 옵션명 | SKU | 판매가 | 재고 | 추가금액

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const XLSX = require('xlsx');

const MAX_EXPORT_ROWS = 5000;

exports.handler = async (event) => {
  const origin = getOrigin(event);
  const CORS = corsHeaders(origin, { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
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

  const params = event.queryStringParameters || {};
  const sellerId = payload.seller_id;

  // ── 상품 조회 (필터 적용) ─────────────────────────────────────────────
  let productQuery = admin
    .from('products')
    .select('id, title, price_suggested, status')
    .eq('seller_id', sellerId)
    .not('status', 'eq', 'draft')
    .order('created_at', { ascending: false })
    .limit(MAX_EXPORT_ROWS);

  if (params.product_id) productQuery = productQuery.eq('id', params.product_id);
  if (params.min_price)  productQuery = productQuery.gte('price_suggested', Number(params.min_price));
  if (params.max_price)  productQuery = productQuery.lte('price_suggested', Number(params.max_price));

  const { data: products, error: pErr } = await productQuery;
  if (pErr) {
    console.error('[bulk-options-export] products error:', pErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '상품을 불러오지 못했어요.' }) };
  }
  if (!products || products.length === 0) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '내보낼 상품이 없어요.' }) };
  }

  const productIds = products.map((p) => p.id);
  const productMap = Object.fromEntries(products.map((p) => [p.id, p]));

  // ── 옵션 조회 ─────────────────────────────────────────────────────────
  let optionQuery = admin
    .from('product_options')
    .select('id, product_id, option_name, option_values, sku, price, stock, extra_price, display_order')
    .in('product_id', productIds)
    .order('display_order', { ascending: true });

  // zero_stock 필터
  if (params.zero_stock === '1') optionQuery = optionQuery.eq('stock', 0);

  const { data: options, error: oErr } = await optionQuery;
  if (oErr) {
    console.error('[bulk-options-export] options error:', oErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '옵션을 불러오지 못했어요.' }) };
  }

  // ── 마켓 매핑 조회 (필터용) ──────────────────────────────────────────
  let marketRegs = [];
  if (params.market) {
    const { data: regs } = await admin
      .from('product_market_registrations')
      .select('product_id, market, market_product_id')
      .eq('seller_id', sellerId)
      .eq('market', params.market)
      .in('product_id', productIds);
    marketRegs = regs || [];
  }
  const marketProductSet = new Set(marketRegs.map((r) => r.product_id));
  // market 필터 적용 — 해당 마켓에 등록된 상품만
  const filteredOptions = params.market
    ? (options || []).filter((o) => marketProductSet.has(o.product_id))
    : (options || []);

  // ── 엑셀 생성 ─────────────────────────────────────────────────────────
  const rows = filteredOptions.map((opt) => {
    const prod = productMap[opt.product_id] || {};
    const optionValueStr = Array.isArray(opt.option_values)
      ? opt.option_values.join(', ')
      : String(opt.option_values || '');
    return {
      '상품ID':    prod.id   || '',
      '상품명':    prod.title || '',
      '옵션ID':    opt.id,
      '옵션명':    opt.option_name || '',
      '옵션값':    optionValueStr,
      'SKU':       opt.sku          || '',
      '판매가':    opt.price        !== null ? opt.price : (prod.price_suggested || 0),
      '재고':      opt.stock        ?? 0,
      '추가금액':  opt.extra_price  ?? 0,
    };
  });

  if (rows.length === 0) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '조건에 맞는 옵션이 없어요.' }) };
  }

  const ws = XLSX.utils.json_to_sheet(rows);
  // 컬럼 너비 설정
  ws['!cols'] = [
    { wch: 38 }, // 상품ID
    { wch: 30 }, // 상품명
    { wch: 38 }, // 옵션ID
    { wch: 20 }, // 옵션명
    { wch: 20 }, // 옵션값
    { wch: 16 }, // SKU
    { wch: 10 }, // 판매가
    { wch:  8 }, // 재고
    { wch: 10 }, // 추가금액
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '옵션목록');

  // 안내 시트 추가
  const guideData = [
    { '안내': '-- 루미 옵션 대량 편집 양식 --' },
    { '안내': '수정 가능한 컬럼: SKU, 판매가, 재고, 추가금액' },
    { '안내': '상품ID / 옵션ID는 수정하지 마세요 (매칭 키)' },
    { '안내': '판매가·추가금액: 0 이상 정수, 재고: 0 이상 정수' },
    { '안내': '저장 후 루미 대시보드 > 옵션 대량 편집 > 엑셀 업로드' },
  ];
  const wsGuide = XLSX.utils.json_to_sheet(guideData);
  wsGuide['!cols'] = [{ wch: 60 }];
  XLSX.utils.book_append_sheet(wb, wsGuide, '사용법');

  const xlsxBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const base64 = xlsxBuffer.toString('base64');

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const filename = `lumi_options_${dateStr}.xlsx`;

  console.log(`[bulk-options-export] seller=${sellerId.slice(0,8)} rows=${rows.length}`);

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
