// _shared/naver-shopping-insight.js — 네이버 데이터랩 쇼핑인사이트 API 헬퍼
//
// 9개 엔드포인트 전체 통합:
//   A. 검색어 트렌드 (이미 scheduled-trends-v2-background 가 /datalab/search 사용)
//   B. 쇼핑 분야별 (분야만): categories / category/device / category/gender / category/age
//   C. 쇼핑 분야 + 키워드: category/keywords / category/keyword/device / .../gender / .../age
//
// 인증: 헤더 X-Naver-Client-Id / X-Naver-Client-Secret (기존 NAVER_CLIENT_ID/SECRET 재사용)
// 무료 일 25,000회 한도. Lumi 운영상 일 ~440회 호출 예상 → 충분.
//
// 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
//
// ⚠️ 시크릿 평문 로그 금지.
//
// 히스토리:
//   2026-04-28: 멀티마켓 SaaS 시절 최초 통합 (커밋 62a2288)
//   2026-05-02~10: lumi 의 SNS 자동화 피보팅 과정에서 일괄 정리·삭제
//   2026-05-12: lumi 트렌드 v2 통합 컨텍스트로 재도입. 본 파일은 helper 만 복원,
//               호출은 scheduled-trends-v2-background 가 직접 통합.

const https = require('https');

const HOSTNAME = 'openapi.naver.com';

// ─────────────────────────────────────────────
// 네이버 쇼핑 1차 카테고리 (참고용)
// 50000000 ~ 50000009 = 트리 root
// ─────────────────────────────────────────────
const NAVER_CATEGORY_ROOT = {
  fashion:    { code: '50000000', name: '패션의류' },
  fashionAcc: { code: '50000001', name: '패션잡화' },
  beauty:     { code: '50000002', name: '화장품/미용' },
  digital:    { code: '50000003', name: '디지털/가전' },
  interior:   { code: '50000004', name: '가구/인테리어' },
  baby:       { code: '50000005', name: '출산/육아' },
  food:       { code: '50000006', name: '식품' },
  sports:     { code: '50000007', name: '스포츠/레저' },
  health:     { code: '50000008', name: '생활/건강' },
  leisure:    { code: '50000009', name: '여가/생활편의' },
};

// ─────────────────────────────────────────────
// Lumi 8 업종 → 네이버 쇼핑 카테고리 매핑
//
// 각 lumi 업종을 1개 이상의 네이버 카테고리에 매핑. 1차 카테고리 코드만 사용
// (서브카테고리는 네이버 측 공개 트리가 변동 가능해 안정성 위해 root 만 유지).
// 매장 운영자에게 의사결정 가치 있는 신호 위주로 선별:
//   - 카페·식당 → 식품 (커피·차·디저트·간편식·신선식품 트렌드 = 메뉴 인사이트)
//   - 미용·네일·헤어 → 화장품/미용 (직접 매칭, 가장 강력)
//   - 의류 → 패션의류 + 패션잡화 (탑 + 액세서리 동시)
//   - 꽃집 → 가구/인테리어 (꽃·식물·원예 서브 포함)
//   - 피트니스 → 스포츠/레저 (헬스·요가용품 = 운동 트렌드 간접 신호)
//
// 다중 매핑 (의류) 은 가치 있는 보조 신호 모두 받기 위한 의도적 확장.
// ─────────────────────────────────────────────
const LUMI_INDUSTRY_CATEGORIES = {
  cafe:       [NAVER_CATEGORY_ROOT.food],
  restaurant: [NAVER_CATEGORY_ROOT.food],
  beauty:     [NAVER_CATEGORY_ROOT.beauty],
  nail:       [NAVER_CATEGORY_ROOT.beauty],
  hair:       [NAVER_CATEGORY_ROOT.beauty],
  clothing:   [NAVER_CATEGORY_ROOT.fashion, NAVER_CATEGORY_ROOT.fashionAcc],
  flower:     [NAVER_CATEGORY_ROOT.interior],
  fitness:    [NAVER_CATEGORY_ROOT.sports],
};

// 옛 export 명 호환 — 다른 곳에서 import 시 깨지지 않도록 (현재 호출자 0).
const LUMI_TO_NAVER_CATEGORY = NAVER_CATEGORY_ROOT;

// ─────────────────────────────────────────────
// 응답 정규화 보조 함수
// ─────────────────────────────────────────────
function safeJsonParse(text) {
  try { return JSON.parse(text); }
  catch (_) { return null; }
}

/**
 * 네이버 응답 시계열 데이터 → Lumi 표준 포맷 정규화
 * @param {Array} results - data.results 배열
 * @returns {Array<{title: string, group: string|null, keyword: string|null, data: Array<{period:string, ratio:number, group?:string}>}>}
 */
function normalizeResults(results) {
  if (!Array.isArray(results)) return [];
  return results.map(r => ({
    title: r.title || '',
    group: r.group || null,
    keyword: Array.isArray(r.keyword) ? r.keyword.join(',') : (r.keyword || null),
    data: Array.isArray(r.data)
      ? r.data.map(d => ({
          period: d.period || '',
          ratio: typeof d.ratio === 'number' ? d.ratio : Number(d.ratio) || 0,
          group: d.group || undefined,
        }))
      : [],
  }));
}

/**
 * 카테고리 코드 + 키워드 입력 검증
 */
function ensureCredentials() {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const err = new Error('NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수 미설정');
    err.code = 'MISSING_CREDENTIALS';
    throw err;
  }
  return { clientId, clientSecret };
}

function ensureCategoryCode(code) {
  if (!code || typeof code !== 'string' || !/^\d{8}$/.test(code)) {
    const err = new Error(`유효하지 않은 카테고리 코드: ${String(code).slice(0, 16)}`);
    err.code = 'INVALID_CATEGORY';
    throw err;
  }
  return code;
}

function ensureKeyword(keyword) {
  if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
    const err = new Error('키워드(keyword)는 비어있지 않은 문자열이어야 합니다');
    err.code = 'INVALID_KEYWORD';
    throw err;
  }
  if (keyword.length > 80) {
    const err = new Error('키워드는 80자 이내여야 합니다');
    err.code = 'INVALID_KEYWORD';
    throw err;
  }
  return keyword.trim();
}

// ─────────────────────────────────────────────
// HTTP 헬퍼 (httpsPostJson) — 의존성 최소
// ─────────────────────────────────────────────
function httpsPostJson(path, headers, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: HOSTNAME, path, method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      let chunks = '';
      res.on('data', (chunk) => { chunks += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: chunks }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// 테스트 시 모킹 가능하도록 노출
let _httpClient = httpsPostJson;
function _setHttpClient(fn) { _httpClient = fn; }
function _resetHttpClient() { _httpClient = httpsPostJson; }

// ─────────────────────────────────────────────
// Rate Limit (보수적 큐) — 단일 프로세스 내 직렬 호출 + 지터
// 네이버 한도(일 25,000)는 여유롭지만 동시 호출 시 429 회피
// ─────────────────────────────────────────────
let _gateChain = Promise.resolve();
const RATE_LIMIT_DELAY_MS = 250;  // 호출 간 최소 간격

function rateLimited(fn) {
  const next = _gateChain.then(async () => {
    const result = await fn();
    await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
    return result;
  });
  // 체인 깨짐 방지: 에러도 흡수해서 다음 호출은 진행
  _gateChain = next.then(() => undefined, () => undefined);
  return next;
}

// ─────────────────────────────────────────────
// 친절한 에러 번역 (메모리 feedback_market_integration_principles.md ⑤)
// ─────────────────────────────────────────────
function translateNaverError(status, body) {
  const safeBody = (body || '').slice(0, 200);
  const parsed = safeJsonParse(body) || {};
  const naverCode = parsed.errorCode || parsed.code || '';
  const naverMsg = parsed.errorMessage || parsed.message || '';

  if (status === 401) {
    return {
      title: '네이버 인증 실패',
      cause: 'NAVER_CLIENT_ID 또는 NAVER_CLIENT_SECRET가 정확하지 않거나 OpenAPI 콘솔에서 데이터랩 API 사용이 켜져있지 않을 수 있습니다',
      action: 'Naver Developers 콘솔에서 데이터랩 API 사용 권한을 확인해 주세요',
      naverCode, naverMsg,
    };
  }
  if (status === 403) {
    return {
      title: '네이버 데이터랩 권한 부족',
      cause: '데이터랩 쇼핑인사이트 API 사용이 활성화되지 않았습니다',
      action: 'Naver Developers 애플리케이션 설정에서 데이터랩(쇼핑인사이트) 사용 항목을 추가해 주세요',
      naverCode, naverMsg,
    };
  }
  if (status === 429) {
    return {
      title: '네이버 API 호출 제한',
      cause: '단시간에 호출이 많았습니다',
      action: '잠시 후 자동 재시도됩니다',
      autoRetry: true,
      naverCode, naverMsg,
    };
  }
  if (status === 400) {
    return {
      title: '네이버 데이터랩 요청 형식 오류',
      cause: '카테고리 코드·날짜 범위·키워드 중 일부가 잘못되었습니다',
      action: '관리자에게 문의 (코드 점검 필요)',
      naverCode, naverMsg,
      // 디버깅용 일부 본문 (시크릿 없음)
      bodyPreview: safeBody,
    };
  }
  return {
    title: `네이버 데이터랩 오류 (${status})`,
    cause: '일시적 오류일 수 있습니다',
    action: '잠시 후 다시 시도해 주세요',
    naverCode, naverMsg,
  };
}

// ─────────────────────────────────────────────
// 코어 호출 — 단일 진입점 (모든 9 엔드포인트가 사용)
// ─────────────────────────────────────────────
async function callDatalab(path, payload) {
  const { clientId, clientSecret } = ensureCredentials();

  const result = await rateLimited(() => _httpClient(path, {
    'X-Naver-Client-Id': clientId,
    'X-Naver-Client-Secret': clientSecret,
  }, payload));

  if (result.status !== 200) {
    const friendly = translateNaverError(result.status, result.body);
    const err = new Error(friendly.title);
    err.code = 'NAVER_API_ERROR';
    err.status = result.status;
    err.friendly = friendly;
    // ⚠️ 절대 시크릿/헤더 로그 금지
    console.error(`[naver-shopping-insight] ${path} status=${result.status} naverCode=${friendly.naverCode || 'n/a'}`);
    throw err;
  }

  const json = safeJsonParse(result.body);
  if (!json) {
    const err = new Error('네이버 데이터랩 응답 파싱 실패');
    err.code = 'PARSE_ERROR';
    throw err;
  }
  return json;
}

// ─────────────────────────────────────────────
// 공통 페이로드 빌더
// ─────────────────────────────────────────────
function defaultPeriod() {
  const today = new Date();
  const endDate = today.toISOString().slice(0, 10);
  const startDate = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { startDate, endDate };
}

/**
 * 페이로드 빌더
 * 네이버 데이터랩 쇼핑 엔드포인트별 형식 차이:
 *   - /shopping/categories: category 는 [{name,param}] 배열
 *   - /shopping/category/{device,gender,age}: category 는 문자열 (코드 직접)
 *   - /shopping/category/keywords: category 는 문자열 + keyword 배열
 *   - /shopping/category/keyword/{device,gender,age}: category 문자열 + keyword 문자열
 *
 * @param shape 'categoryArray' | 'categoryScalar' | 'categoryWithKeywordArray' | 'categoryWithKeywordScalar'
 */
function buildBasePayload({ startDate, endDate, timeUnit = 'date', categoryCode, keyword, keywords, shape = 'categoryArray', options = {} }) {
  ensureCategoryCode(categoryCode);
  const { startDate: dStart, endDate: dEnd } = defaultPeriod();
  const payload = {
    startDate: startDate || dStart,
    endDate: endDate || dEnd,
    timeUnit, // date | week | month
  };

  if (shape === 'categoryArray') {
    payload.category = [{ name: options.categoryName || categoryCode, param: [categoryCode] }];
  } else if (shape === 'categoryScalar') {
    payload.category = categoryCode;
  } else if (shape === 'categoryWithKeywordArray') {
    payload.category = categoryCode;
    if (!Array.isArray(keywords) || keywords.length === 0) {
      const err = new Error('keywords 배열이 비어있을 수 없습니다');
      err.code = 'INVALID_KEYWORDS';
      throw err;
    }
    payload.keyword = keywords.map(kw => ({ name: kw, param: [kw] }));
  } else if (shape === 'categoryWithKeywordScalar') {
    ensureKeyword(keyword);
    payload.category = categoryCode;
    payload.keyword = keyword;
  }

  if (options.device) payload.device = options.device;
  if (options.gender) payload.gender = options.gender;
  if (options.ages) payload.ages = options.ages;
  return payload;
}

// ─────────────────────────────────────────────
// B 그룹: 쇼핑 분야별 (분야만)
// ─────────────────────────────────────────────

/**
 * 쇼핑 분야별 클릭 추이
 * @param {{categoryCode:string, startDate?:string, endDate?:string, timeUnit?:string, categoryName?:string}} params
 */
async function fetchCategoryTrend(params) {
  const payload = buildBasePayload({
    startDate: params.startDate,
    endDate: params.endDate,
    timeUnit: params.timeUnit || 'date',
    categoryCode: params.categoryCode,
    shape: 'categoryArray',
    options: { categoryName: params.categoryName },
  });
  const json = await callDatalab('/v1/datalab/shopping/categories', payload);
  return {
    metricType: 'category_overall',
    startDate: payload.startDate,
    endDate: payload.endDate,
    timeUnit: payload.timeUnit,
    results: normalizeResults(json.results),
  };
}

/**
 * 분야 × 기기 (PC vs 모바일)
 */
async function fetchCategoryByDevice(params) {
  const payload = buildBasePayload({
    startDate: params.startDate,
    endDate: params.endDate,
    timeUnit: params.timeUnit || 'date',
    categoryCode: params.categoryCode,
    shape: 'categoryScalar',
    options: { categoryName: params.categoryName },
  });
  const json = await callDatalab('/v1/datalab/shopping/category/device', payload);
  return {
    metricType: 'category_device',
    startDate: payload.startDate,
    endDate: payload.endDate,
    timeUnit: payload.timeUnit,
    results: normalizeResults(json.results),
  };
}

/**
 * 분야 × 성별
 */
async function fetchCategoryByGender(params) {
  const payload = buildBasePayload({
    startDate: params.startDate,
    endDate: params.endDate,
    timeUnit: params.timeUnit || 'date',
    categoryCode: params.categoryCode,
    shape: 'categoryScalar',
    options: { categoryName: params.categoryName },
  });
  const json = await callDatalab('/v1/datalab/shopping/category/gender', payload);
  return {
    metricType: 'category_gender',
    startDate: payload.startDate,
    endDate: payload.endDate,
    timeUnit: payload.timeUnit,
    results: normalizeResults(json.results),
  };
}

/**
 * 분야 × 연령
 */
async function fetchCategoryByAge(params) {
  const payload = buildBasePayload({
    startDate: params.startDate,
    endDate: params.endDate,
    timeUnit: params.timeUnit || 'date',
    categoryCode: params.categoryCode,
    shape: 'categoryScalar',
    options: { categoryName: params.categoryName },
  });
  const json = await callDatalab('/v1/datalab/shopping/category/age', payload);
  return {
    metricType: 'category_age',
    startDate: payload.startDate,
    endDate: payload.endDate,
    timeUnit: payload.timeUnit,
    results: normalizeResults(json.results),
  };
}

// ─────────────────────────────────────────────
// C 그룹: 쇼핑 분야 + 키워드
// ─────────────────────────────────────────────

/**
 * 분야 × 검색 키워드 인기 추이
 * @param {{categoryCode:string, keywords:string[], startDate?, endDate?, timeUnit?, categoryName?}} params
 */
async function fetchCategoryKeywords(params) {
  if (!Array.isArray(params.keywords) || params.keywords.length === 0) {
    const err = new Error('keywords 배열이 비어있을 수 없습니다');
    err.code = 'INVALID_KEYWORDS';
    throw err;
  }
  for (const kw of params.keywords) ensureKeyword(kw);
  const payload = buildBasePayload({
    startDate: params.startDate,
    endDate: params.endDate,
    timeUnit: params.timeUnit || 'date',
    categoryCode: params.categoryCode,
    keywords: params.keywords,
    shape: 'categoryWithKeywordArray',
  });
  const json = await callDatalab('/v1/datalab/shopping/category/keywords', payload);
  return {
    metricType: 'category_keywords',
    startDate: payload.startDate,
    endDate: payload.endDate,
    timeUnit: payload.timeUnit,
    results: normalizeResults(json.results),
  };
}

/**
 * 분야 + 키워드 × 기기
 */
async function fetchCategoryKeywordByDevice(params) {
  const payload = buildBasePayload({
    startDate: params.startDate,
    endDate: params.endDate,
    timeUnit: params.timeUnit || 'date',
    categoryCode: params.categoryCode,
    keyword: params.keyword,
    shape: 'categoryWithKeywordScalar',
  });
  const json = await callDatalab('/v1/datalab/shopping/category/keyword/device', payload);
  return {
    metricType: 'category_keyword_device',
    keyword: params.keyword,
    startDate: payload.startDate,
    endDate: payload.endDate,
    timeUnit: payload.timeUnit,
    results: normalizeResults(json.results),
  };
}

/**
 * 분야 + 키워드 × 성별
 */
async function fetchCategoryKeywordByGender(params) {
  const payload = buildBasePayload({
    startDate: params.startDate,
    endDate: params.endDate,
    timeUnit: params.timeUnit || 'date',
    categoryCode: params.categoryCode,
    keyword: params.keyword,
    shape: 'categoryWithKeywordScalar',
  });
  const json = await callDatalab('/v1/datalab/shopping/category/keyword/gender', payload);
  return {
    metricType: 'category_keyword_gender',
    keyword: params.keyword,
    startDate: payload.startDate,
    endDate: payload.endDate,
    timeUnit: payload.timeUnit,
    results: normalizeResults(json.results),
  };
}

/**
 * 분야 + 키워드 × 연령
 */
async function fetchCategoryKeywordByAge(params) {
  const payload = buildBasePayload({
    startDate: params.startDate,
    endDate: params.endDate,
    timeUnit: params.timeUnit || 'date',
    categoryCode: params.categoryCode,
    keyword: params.keyword,
    shape: 'categoryWithKeywordScalar',
  });
  const json = await callDatalab('/v1/datalab/shopping/category/keyword/age', payload);
  return {
    metricType: 'category_keyword_age',
    keyword: params.keyword,
    startDate: payload.startDate,
    endDate: payload.endDate,
    timeUnit: payload.timeUnit,
    results: normalizeResults(json.results),
  };
}

// ─────────────────────────────────────────────
// 1인 셀러용 분포 요약 (셀러 친화 카피)
// ─────────────────────────────────────────────
function summarizeDistribution(results, kind) {
  // 시계열 ratio 합계로 그룹별 점유율 계산
  if (!Array.isArray(results) || results.length === 0) return null;
  const totals = new Map();
  for (const r of results) {
    let key = r.title || r.group || 'unknown';
    // device/gender/age는 group이 핵심
    let sum = 0;
    for (const d of r.data || []) sum += (d.ratio || 0);
    totals.set(key, (totals.get(key) || 0) + sum);
  }
  const grandTotal = [...totals.values()].reduce((s, v) => s + v, 0);
  if (grandTotal === 0) return null;
  const split = {};
  for (const [k, v] of totals.entries()) {
    split[k] = Math.round((v / grandTotal) * 1000) / 10;  // 소수점 1자리 %
  }
  return { kind, split };
}

// ─────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────
module.exports = {
  // 카테고리 매핑
  NAVER_CATEGORY_ROOT,
  LUMI_INDUSTRY_CATEGORIES,
  LUMI_TO_NAVER_CATEGORY,  // 옛 export 명 (호환)
  // B 그룹
  fetchCategoryTrend,
  fetchCategoryByDevice,
  fetchCategoryByGender,
  fetchCategoryByAge,
  // C 그룹
  fetchCategoryKeywords,
  fetchCategoryKeywordByDevice,
  fetchCategoryKeywordByGender,
  fetchCategoryKeywordByAge,
  // 유틸 & 내부
  normalizeResults,
  summarizeDistribution,
  translateNaverError,
  ensureCategoryCode,
  ensureKeyword,
  // 테스트 훅 (모킹)
  _setHttpClient,
  _resetHttpClient,
};
