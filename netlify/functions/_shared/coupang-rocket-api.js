'use strict';
// 쿠팡 로켓그로스(Rocket Growth) 상품 등록 모듈. coupang-wing-api(HMAC)를 통해 호출.
// 공식검증(developers.coupangcorp.com, 2026-06-19):
//   - 로켓그로스 상품생성 = 마켓플레이스와 같은 엔드포인트:
//       POST /v2/providers/seller_api/apis/api/v1/marketplace/seller-products
//     items[].rocketGrowthItemData(바코드·무게·치수·skuInfo·가격) 블록이 있으면 로켓그로스 상품.
//   - 상세페이지 HTML = items[].contents[].contentDetails[].content
//   - 이미지 = items[].images[].vendorPath (쿠팡 업로드 경로 — 외부 URL 직접 불가, 별도 업로드 필요)
//   - ★사전조건(사장님이 WING에서): ①"로켓그로스 상품생성 API & 심사 동의" 체크(안하면 에러)
//        ②출고지(outboundShippingPlaceCode)·반품지(returnCenterCode) 등록
//   - 입고(IB 생성, 바코드/라벨 발급)는 현재 WING에서만 가능(API 아님) → 사장님 수동.
const { coupangCall, coupangGet, VENDOR } = require('./coupang-wing-api');

// 출고지 목록 조회 → [{code, name}]. (검증: GET .../api/v2/vendor/shipping-place/outbound)
async function getOutboundShippingPlaces() {
  const r = await coupangGet('/v2/providers/marketplace_openapi/apis/api/v2/vendor/shipping-place/outbound', 'pageNum=1&pageSize=50');
  if (!r.ok) return { ok: false, status: r.status, error: r.error || r.body };
  const list = (r.body && r.body.content) || [];
  return { ok: true, places: list.map((p) => ({ code: p.outboundShippingPlaceCode, name: p.shippingPlaceName })) };
}

// 반품지 목록 조회 → [{code, name}]. (반품지 v4, vendorId path)
async function getReturnCenters() {
  const path = '/v2/providers/openapi/apis/api/v4/vendors/' + VENDOR() + '/returnShippingCenters';
  const r = await coupangGet(path, 'pageNum=1&pageSize=50');
  if (!r.ok) return { ok: false, status: r.status, error: r.error || r.body };
  const data = (r.body && r.body.data) || {};
  const list = data.content || (Array.isArray(r.body && r.body.content) ? r.body.content : []) || [];
  return { ok: true, centers: list.map((c) => ({ code: c.returnCenterCode, name: c.shippingPlaceName || c.returnCenterName })) };
}

// 정규화 spec → 로켓그로스 seller-products 요청 body 조립(공식 스키마 충실 + 보일러플레이트 기본값).
// spec 필수: categoryCode, name, vendorUserId, outboundShippingPlaceCode, returnCenterCode,
//   detailHtml, notices[](고시정보), images[]({imageOrder,imageType,vendorPath}),
//   item{itemName, barcode, salePrice, sku{weight,width,length,height,quantityPerBox,...}}
//   legalAgreement(쿠팡 지정 동의문구). attributes/saleEndedAt 등은 옵션.
function buildRocketGrowthBody(spec) {
  const s = spec || {};
  const it = s.item || {};
  const sku = it.sku || {};
  return {
    vendorId: VENDOR(),
    vendorUserId: s.vendorUserId,
    displayCategoryCode: s.categoryCode,
    brand: s.brand || '',
    manufacture: s.manufacture || '',
    sellerProductName: s.name,
    displayProductName: s.name,
    generalProductName: s.name,
    saleStartedAt: s.saleStartedAt || '2024-01-01T00:00:00',
    saleEndedAt: s.saleEndedAt || '2099-12-30T23:59:59',
    outboundShippingPlaceCode: s.outboundShippingPlaceCode,
    returnCenterCode: s.returnCenterCode,
    requested: s.requested === true, // false=임시저장, true=즉시 승인요청
    legalAgreement: s.legalAgreement, // 로켓그로스 입고금지조건 동의(필수)
    items: [{
      itemName: it.itemName || s.name,
      images: s.images || [],
      contents: [{ contentsType: 'HTML', contentDetails: [{ content: s.detailHtml || '', detailType: 'TEXT' }] }],
      offerDescription: '',
      attributes: s.attributes || [],
      notices: s.notices || [],
      certifications: [{ certificationType: 'NOT_REQUIRED', certificationCode: '' }],
      taxType: s.taxType || 'TAX',
      adultOnly: 'EVERYONE',
      parallelImported: 'NOT_PARALLEL_IMPORTED',
      overseasPurchased: 'NOT_OVERSEAS_PURCHASED',
      pccNeeded: false,
      offerCondition: 'NEW',
      unitCount: 1,
      maximumBuyForPerson: 0,
      maximumBuyForPersonPeriod: 1,
      outboundShippingTimeDay: String(s.outboundShippingTimeDay || 1),
      searchTags: s.searchTags || [],
      rocketGrowthItemData: {
        barcode: it.barcode || '',
        externalVendorSku: it.externalVendorSku || '',
        modelNo: it.modelNo || '',
        skuInfo: {
          fragile: sku.fragile === true,
          weight: sku.weight || null,
          netWeight: sku.netWeight || null,
          leadTime: sku.leadTime || null,
          width: sku.width || null,
          length: sku.length || null,
          height: sku.height || null,
          quantityPerBox: sku.quantityPerBox || 1,
          distributionPeriod: sku.distributionPeriod || null,
          expiredAtManaged: sku.expiredAtManaged === true,
        },
        priceData: { salePrice: it.salePrice, originalPrice: it.originalPrice || 0 },
      },
    }],
  };
}

// 로켓그로스 상품 생성. dryRun 기본 true(조립된 body만 반환, 미발사).
function missingFields(s) {
  const need = ['categoryCode', 'name', 'vendorUserId', 'outboundShippingPlaceCode', 'returnCenterCode', 'legalAgreement'];
  const miss = need.filter((k) => !s || s[k] == null || s[k] === '');
  if (!s || !s.item || !s.item.barcode) miss.push('item.barcode');
  if (!s || !s.item || s.item.salePrice == null) miss.push('item.salePrice');
  if (!s || !Array.isArray(s.images) || !s.images.length) miss.push('images(vendorPath)');
  if (!s || !Array.isArray(s.notices) || !s.notices.length) miss.push('notices(고시정보)');
  return miss;
}

async function createRocketGrowthProduct(spec, { dryRun = true } = {}) {
  const miss = missingFields(spec);
  const body = buildRocketGrowthBody(spec);
  if (dryRun) return { ok: miss.length === 0, dryRun: true, missing: miss, body };
  if (miss.length) return { ok: false, error: '필수정보 누락: ' + miss.join(', '), missing: miss };
  const r = await coupangCall('POST', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', '', body);
  return r;
}

module.exports = {
  getOutboundShippingPlaces, getReturnCenters,
  buildRocketGrowthBody, createRocketGrowthProduct,
};
