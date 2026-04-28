// 택배사 코드 — Sprint 3
// migrations/2026-04-28-sprint-3-orders-cs.sql courier_codes 테이블과 동기화
// 셀러 모바일 송장 입력 드롭다운 + 추적 API용

const COURIERS = [
  { code: 'CJGLS', display_name: 'CJ대한통운', smart_tracker_code: '04', display_order: 10 },
  { code: 'LOGEN', display_name: '로젠택배',   smart_tracker_code: '06', display_order: 20 },
  { code: 'HJT',   display_name: '한진택배',   smart_tracker_code: '05', display_order: 30 },
  { code: 'LOTTE', display_name: '롯데택배',   smart_tracker_code: '08', display_order: 40 },
  { code: 'EPOST', display_name: '우체국택배', smart_tracker_code: '01', display_order: 50 },
  { code: 'CVSNET',display_name: '편의점택배', smart_tracker_code: '46', display_order: 60 },
];

const COURIER_BY_CODE = COURIERS.reduce((acc, c) => { acc[c.code] = c; return acc; }, {});

function listCouriers() {
  return COURIERS.slice().sort((a, b) => a.display_order - b.display_order);
}

function getCourier(code) {
  return COURIER_BY_CODE[String(code || '').toUpperCase()] || null;
}

function isValidCourierCode(code) {
  return !!getCourier(code);
}

module.exports = {
  COURIERS,
  listCouriers,
  getCourier,
  isValidCourierCode,
};
