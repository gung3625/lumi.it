'use strict';
// admin-source-to-listing.js — 소싱 오케스트레이션. 도매꾹 상품번호 하나로 전 과정을 한 번에:
//   getItemView(상품정보) → predictCategory(쿠팡카테고리) → generateDetailPage(상세HTML)
//   → setOrderDome(매입주문) → createRocketGrowthProduct(로켓그로스 등록)
// 입력(POST, Bearer LUMI_SECRET):
//   { no, salePrice, qty?, optCode?, sellerMsg?, barcode?, sku?{weight,width,length,height,quantityPerBox..},
//     vendorUserId?, legalAgreement?, images?[{imageOrder,imageType,vendorPath}],
//     diffHook?, painPoints?, sellingHook?, model?, execute? }
// execute=true 면 매입·등록을 실제 발사(돈/주문 발생). 기본 false=dryRun(조립·검증만).
const { getItemView, setOrderDome } = require('./_shared/domeggook-api');
const { generateDetailPage } = require('./_shared/detail-page');
const { predictCategory, createRocketGrowthProduct, getOutboundShippingPlaces, getReturnCenters } = require('./_shared/coupang-rocket-api');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};
const ok = (b) => ({ statusCode: 200, headers: CORS, body: JSON.stringify(b) });
const err = (c, m) => ({ statusCode: c, headers: CORS, body: JSON.stringify({ error: m }) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return err(405, 'POST만 허용됩니다.');
  const auth = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!process.env.LUMI_SECRET || auth !== process.env.LUMI_SECRET) return err(401, '인증 실패');

  let body; try { body = JSON.parse(event.body || '{}'); } catch (_) { return err(400, '잘못된 요청 형식'); }
  if (!body.no) return err(400, 'no(도매꾹 상품번호)가 필요합니다.');
  const execute = body.execute === true;
  const dryRun = !execute;

  // 1) 도매꾹 상품정보
  const product = await getItemView(body.no);
  if (!product) return err(502, '도매꾹 상품 조회 실패 (상품번호/DOMEGGOOK_API_KEY 확인)');

  // 2~5) 카테고리·상세페이지·출고지/반품지 병렬
  const [cat, detail, outb, retc] = await Promise.all([
    predictCategory({ productName: product.title }),
    generateDetailPage(product, { diffHook: body.diffHook, painPoints: body.painPoints, sellingHook: body.sellingHook, model: body.model }),
    getOutboundShippingPlaces(),
    getReturnCenters(),
  ]);

  // 6) 매입 주문(배송지는 setOrderDome이 기본 배송지 자동 사용)
  const purchase = await setOrderDome({ no: body.no, qty: body.qty || 1, optCode: body.optCode || '', sellerMsg: body.sellerMsg || '', dryRun });

  // 7) 로켓그로스 등록 spec 조립 — 도매꾹 이미지 URL을 vendorPath로(쿠팡이 http(s) URL 자동 다운로드, 포트80/443·200자↓)
  //   첫 장=REPRESENTATION(대표, 정사각 500x500↑ 권장), 나머지=DETAIL(최대 9). 별도 업로드 불필요.
  const autoImages = (product.images || [])
    .filter((u) => /^https?:\/\//.test(String(u)) && String(u).length <= 200)
    .slice(0, 10)
    .map((u, i) => ({ imageOrder: i, imageType: i === 0 ? 'REPRESENTATION' : 'DETAIL', vendorPath: u }));
  const images = (body.images && body.images.length) ? body.images : autoImages;
  const spec = {
    categoryCode: cat && cat.ok ? cat.categoryId : null,
    name: (detail && detail.copy && detail.copy.seoTitle) || product.title,
    vendorUserId: body.vendorUserId,
    outboundShippingPlaceCode: outb && outb.ok && outb.places[0] ? outb.places[0].code : null,
    returnCenterCode: retc && retc.ok && retc.centers[0] ? retc.centers[0].code : null,
    legalAgreement: body.legalAgreement,
    detailHtml: detail && detail.html ? detail.html : '',
    images,
    item: { itemName: product.title, barcode: body.barcode, salePrice: body.salePrice, sku: body.sku || {} },
  };
  const listing = await createRocketGrowthProduct(spec, { dryRun });

  // 다음 단계 안내(아직 채워야 할 것)
  const todo = [];
  if (!body.salePrice) todo.push('salePrice(쿠팡 판매가)');
  if (!body.barcode) todo.push('barcode(GTIN)');
  if (!images.length) todo.push('images(도매꾹 이미지 자동매핑 실패 — 수동 지정 필요)');
  if (!body.vendorUserId) todo.push('vendorUserId(쿠팡 WING 아이디)');
  if (!body.legalAgreement) todo.push('legalAgreement(로켓그로스 동의문구)');
  if (!body.sku || !body.sku.weight) todo.push('sku 무게/치수(실측)');

  return ok({
    mode: dryRun ? 'dryRun' : 'execute',
    product: { no: product.no, title: product.title, domePrice: product.domePrice, moq: product.moq, imageCount: (product.images || []).length },
    category: cat,
    detail: detail && detail.copy ? { seoTitle: detail.copy.seoTitle, sections: detail.copy.sections.length, htmlLength: (detail.html || '').length } : { error: detail && detail.error },
    purchase,
    listing: { ok: listing.ok, missing: listing.missing, status: listing.status, error: listing.error },
    ready: !!(purchase && purchase.ok && listing && listing.ok),
    todo,
  });
};
