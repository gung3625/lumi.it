// Privacy-by-Design 마스킹 유틸 — Sprint 3
// 구매자 이름·전화·주소를 평문 저장하기 전에 모두 이 모듈을 거친다.
// 메모리 feedback_market_integration_principles.md (Privacy-by-Design)

/**
 * 이름 마스킹 — "김철수" → "김**" / "Smith" → "S****"
 * @param {string} name
 * @returns {string}
 */
function maskName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return '';
  // 한글: 첫 1자만 유지
  if (/[\uAC00-\uD7AF]/.test(trimmed)) {
    if (trimmed.length === 1) return trimmed;
    return trimmed[0] + '*'.repeat(Math.max(1, trimmed.length - 1));
  }
  // 영문: 첫 1자 유지 + 나머지 *
  if (trimmed.length === 1) return trimmed;
  return trimmed[0] + '*'.repeat(Math.max(1, trimmed.length - 1));
}

/**
 * 전화 마스킹 — "010-1234-5678" → "010-****-5678" / "01012345678" → "010-****-5678"
 * @param {string} phone
 * @returns {string}
 */
function maskPhone(phone) {
  const digits = String(phone || '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  // 11자리 010 패턴
  if (/^010\d{8}$/.test(digits)) {
    return `010-****-${digits.slice(7)}`;
  }
  // 10자리
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-****-${digits.slice(6)}`;
  }
  // 그 외 (일반 fallback) — 마지막 4자리만 노출
  if (digits.length >= 4) {
    return '*'.repeat(digits.length - 4) + digits.slice(-4);
  }
  return '*'.repeat(digits.length);
}

/**
 * 주소 마스킹 — "서울특별시 강남구 테헤란로 152, 101동 1234호" → "서울특별시 강남구 ***"
 * 주요 행정구역(시/도 + 시/군/구)만 남기고 나머지를 ***로 치환.
 * @param {string} address
 * @returns {string}
 */
function maskAddress(address) {
  const trimmed = String(address || '').trim();
  if (!trimmed) return '';
  // "시" 또는 "도" + "시/군/구" 추출
  const m = trimmed.match(/^([가-힣]+(?:특별시|광역시|특별자치시|특별자치도|도|시))\s*([가-힣]+(?:시|군|구))?/);
  if (m) {
    const head = [m[1], m[2]].filter(Boolean).join(' ');
    return `${head} ***`;
  }
  // 패턴 매칭 실패 — 첫 5글자만 노출
  return `${trimmed.slice(0, Math.min(5, trimmed.length))} ***`;
}

/**
 * 마켓 raw 주문 → 마스킹된 buyer 필드 묶음
 * @param {Object} raw
 * @returns {{ buyer_name_masked: string, buyer_phone_masked: string, buyer_address_masked: string }}
 */
function maskBuyerFields(raw) {
  return {
    buyer_name_masked: maskName(raw?.buyer_name || raw?.buyerName || raw?.purchaserName || ''),
    buyer_phone_masked: maskPhone(raw?.buyer_phone || raw?.buyerPhone || raw?.recipientPhone || ''),
    buyer_address_masked: maskAddress(raw?.buyer_address || raw?.buyerAddress || raw?.shippingAddress || ''),
  };
}

module.exports = {
  maskName,
  maskPhone,
  maskAddress,
  maskBuyerFields,
};
