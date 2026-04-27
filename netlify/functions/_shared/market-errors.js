// 마켓 API 에러 코드 → 루미 친화 메시지 번역 (Principle 5)
// 모든 사용자 노출 에러는 이 매핑을 거친다. raw 4xx/5xx 코드 노출 금지.

const COUPANG_ERROR_MAP = {
  400: {
    title: '입력값 오류',
    cause: 'Vendor ID 또는 키 형식이 올바르지 않아요.',
    action: '입력값을 다시 확인하시거나, 쿠팡 Wing에서 키를 새로 발급받아 주세요.',
    deepLink: 'coupang.api_key_issue',
  },
  401: {
    title: '쿠팡 인증 실패',
    cause: 'Access Key 또는 Secret Key가 정확하지 않아요.',
    action: '키를 다시 입력하시거나, 쿠팡 Wing에서 새로 발급받아 주세요.',
    deepLink: 'coupang.api_key_issue',
  },
  403: {
    title: '쿠팡 판매 권한 없음',
    cause: '쿠팡 Wing 설정에서 [API 연동] 항목의 체크박스가 해제되어 있어요.',
    action: '체크박스를 활성화하시면 5초 안에 해결돼요.',
    deepLink: 'coupang.permission_check',
    estimatedTime: '5초',
  },
  404: {
    title: '쿠팡 셀러 정보를 찾지 못했어요',
    cause: '입력하신 Vendor ID에 해당하는 셀러 정보가 없어요.',
    action: 'Vendor ID를 다시 확인해주세요. (쿠팡 Wing 우상단에서 확인 가능)',
    deepLink: 'coupang.api_key_issue',
  },
  408: {
    title: '쿠팡 응답이 늦어요',
    cause: '쿠팡 서버 응답이 지연되고 있어요.',
    action: '잠시 후 다시 시도해주세요.',
    autoRetry: true,
  },
  429: {
    title: '쿠팡 호출 제한',
    cause: '잠시 호출이 많았어요.',
    action: '1분 후 다시 시도해주세요.',
    autoRetry: true,
  },
  500: {
    title: '쿠팡 서버 일시적 오류',
    cause: '쿠팡 측 서버 문제예요.',
    action: '잠시 후 다시 시도해주세요. 계속되면 고객센터로 문의해주세요.',
  },
  502: {
    title: '쿠팡 연결 실패',
    cause: '쿠팡 API와 통신할 수 없어요.',
    action: '잠시 후 다시 시도해주세요.',
  },
  503: {
    title: '쿠팡 점검 중',
    cause: '쿠팡 시스템이 점검 중이에요.',
    action: '점검 종료 후 다시 시도해주세요.',
  },
};

const NAVER_ERROR_MAP = {
  400: {
    title: '네이버 입력값 오류',
    cause: 'Application ID 또는 Secret 형식이 올바르지 않아요.',
    action: '네이버 커머스 API 센터에서 키를 다시 확인해주세요.',
    deepLink: 'naver.app_register',
  },
  401: {
    title: '네이버 인증 실패',
    cause: 'Application ID 또는 Secret이 정확하지 않아요.',
    action: '키를 다시 입력하시거나, 네이버 커머스 API 센터에서 발급받아 주세요.',
    deepLink: 'naver.app_register',
  },
  403: {
    title: '네이버 권한 부족',
    cause: '필요한 스코프가 활성화되어 있지 않아요.',
    action: '네이버 커머스 API 센터에서 상품/주문 스코프를 활성화해주세요.',
    deepLink: 'naver.scope_setup',
  },
  408: {
    title: '네이버 응답이 늦어요',
    cause: '네이버 서버 응답이 지연되고 있어요.',
    action: '잠시 후 다시 시도해주세요.',
    autoRetry: true,
  },
  429: {
    title: '네이버 호출 제한',
    cause: '잠시 호출이 많았어요.',
    action: '1분 후 다시 시도해주세요.',
    autoRetry: true,
  },
  500: {
    title: '네이버 서버 일시적 오류',
    cause: '네이버 측 서버 문제예요.',
    action: '잠시 후 다시 시도해주세요.',
  },
};

const GENERIC_ERROR = {
  title: '연결에 실패했어요',
  cause: '예상치 못한 오류가 발생했어요.',
  action: '잠시 후 다시 시도해주세요. 계속되면 고객센터로 문의해주세요.',
};

/**
 * 마켓 + status 코드 → 루미 친화 에러 객체
 * @param {'coupang'|'naver'} market
 * @param {number} status
 * @param {string} [fallback] - 매핑 없을 때 fallback 메시지
 * @returns {{ title, cause, action, deepLink?, estimatedTime?, autoRetry?, statusCode }}
 */
function translateMarketError(market, status, fallback) {
  const map = market === 'coupang' ? COUPANG_ERROR_MAP : market === 'naver' ? NAVER_ERROR_MAP : {};
  const entry = map[status];
  if (entry) {
    return { ...entry, statusCode: status, market };
  }
  return {
    ...GENERIC_ERROR,
    cause: fallback || GENERIC_ERROR.cause,
    statusCode: status,
    market,
  };
}

module.exports = { translateMarketError, COUPANG_ERROR_MAP, NAVER_ERROR_MAP };
