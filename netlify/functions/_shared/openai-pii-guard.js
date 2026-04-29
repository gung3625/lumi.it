// openai-pii-guard.js — OpenAI 호출 전 셀러/주문자 식별정보 stripping
// 개인정보보호법 §28의8: 비식별 데이터만 OpenAI에 전송

const PII_FIELDS = [
  'name', 'ownerName', 'full_name',
  'email',
  'phone', 'phone_number',
  'businessNumber', 'business_no',
  'address',
  // 주문자·수취인 정보 (마켓플레이스 주문 PII)
  'recipient_name', 'buyer_name', 'receiver_name',
  'buyer_phone', 'receiver_phone',
  'buyer_email',
  'zip_code', 'postal_code',
  'shipping_address', 'detailed_address',
];

/**
 * 객체에서 PII 필드를 재귀적으로 제거
 * @param {any} obj
 * @returns {any}
 */
function stripPII(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const cleaned = Array.isArray(obj) ? [] : {};
  for (const k of Object.keys(obj)) {
    if (PII_FIELDS.includes(k)) continue;
    cleaned[k] = typeof obj[k] === 'object' ? stripPII(obj[k]) : obj[k];
  }
  return cleaned;
}

module.exports = { stripPII, PII_FIELDS };
