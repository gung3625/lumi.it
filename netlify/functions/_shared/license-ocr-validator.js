// 사업자등록증 OCR 대조 — Sprint 1.1
// GPT-4o Vision으로 사업자등록증 사진을 분석하고 셀러 입력값과 자동 대조한다.
//
// 정책:
//   - confidence >= AUTO_APPROVE_THRESHOLD(기본 90) + 사업자번호+대표자명 모두 일치 → 'approved'
//   - 그 외 → 'pending' (사람 검토 큐)
//   - AI_OCR_MOCK=true → 실제 API 호출 없이 결정론적 모킹 응답 반환 (베타 시작값)
//   - 추출된 사업자번호·대표자명은 절대 console.log 금지 (마스킹만 허용)
//
// 비용:
//   - GPT-4o Vision 1024x1024 이미지 1회 ≈ ₩50/건 (실연동)
//   - 모킹 시 0원
//
// 의존: openai SDK 사용 안 함 — fetch 직접 호출 (다른 모듈과 일관)
//       (project_supabase_migration_complete: 외부 SDK 최소화 정책)

const OPENAI_BASE = 'https://api.openai.com/v1';
const VISION_MODEL = 'gpt-4o';
const VISION_TIMEOUT_MS = 60_000;

// 자동 승인 임계치 (메모리 결정사항: confidence 90% 이상만 승인)
const AUTO_APPROVE_THRESHOLD = 90;

// OCR 추출 시도하는 필드 — 추가/수정 시 prompt도 동기화
const OCR_FIELDS = [
  'business_number',  // 사업자등록번호 (10자리)
  'business_name',    // 상호 (법인명/개인사업자명)
  'owner_name',       // 대표자명
  'address',          // 주소
  'start_date',       // 개업 연월일 (YYYY-MM-DD)
  'business_type',    // 업종/업태
];

const SYSTEM_PROMPT = `당신은 한국 사업자등록증 사진을 정확하게 읽어내는 OCR 분석가입니다.
다음 필드를 사진에서 정확히 읽어 JSON으로만 응답하세요. 추측·창작 금지, 사진에 적힌 그대로만.

응답 형식 (반드시 이 키만 사용, 추가 키 금지):
{
  "business_number": "1234567890",  // 하이픈 없는 10자리 숫자. 못 찾으면 ""
  "business_name": "...",             // 상호. 못 찾으면 ""
  "owner_name": "...",                // 대표자명. 못 찾으면 ""
  "address": "...",                   // 주소 전체 한 줄. 못 찾으면 ""
  "start_date": "YYYY-MM-DD",         // 개업 연월일. 못 찾으면 ""
  "business_type": "...",              // 업종 또는 업태. 못 찾으면 ""
  "confidence": 95,                    // 0~100 사이 정수. 흐릿/잘림/광반사로 읽기 어려우면 낮춤
  "is_business_license": true,         // 사업자등록증 사진이 맞는지. 다른 문서/사진이면 false
  "notes": ""                          // 어려운 부분 있으면 한 줄. 없으면 ""
}`;

/**
 * GPT-4o Vision API 호출 → OCR 추출 결과 반환
 * @param {Buffer} imageBuffer
 * @param {string} mimeType - image/jpeg | image/png | image/webp 등
 * @returns {Promise<{ ok: boolean, raw?: object, errorReason?: string }>}
 */
async function callVisionApi(imageBuffer, mimeType) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, errorReason: 'config_missing' };
  }

  // PDF는 GPT-4o Vision이 직접 지원 안 함 — caller에서 image로 변환하거나 OCR 스킵
  if (!mimeType || !mimeType.startsWith('image/')) {
    return { ok: false, errorReason: 'unsupported_format' };
  }

  const dataUrl = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;

  const body = {
    model: VISION_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: '이 사업자등록증 사진을 분석해 위 JSON 형식으로만 응답하세요.' },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
        ],
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: 600,
  };

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), VISION_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(tid);
    return { ok: false, errorReason: 'network_error' };
  }
  clearTimeout(tid);

  if (!res.ok) {
    return { ok: false, errorReason: `vision_http_${res.status}` };
  }

  let json;
  try {
    json = await res.json();
  } catch (_) {
    return { ok: false, errorReason: 'vision_parse_error' };
  }
  const content = json && json.choices && json.choices[0] && json.choices[0].message
    && json.choices[0].message.content;
  if (!content) return { ok: false, errorReason: 'vision_empty_response' };

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (_) {
    return { ok: false, errorReason: 'vision_parse_error' };
  }

  return { ok: true, raw: parsed };
}

/**
 * 결정론적 모킹 응답 — AI_OCR_MOCK=true 시 실 API 호출 없이 셀러 입력값 그대로 통과시킴.
 * 베타 운영용 (사진은 받지만 OCR 비용 0원).
 */
function mockExtract({ businessNumber, ownerName, businessName }) {
  return {
    ok: true,
    raw: {
      business_number: (businessNumber || '').replace(/\D/g, '').slice(0, 10),
      business_name: businessName || '',
      owner_name: ownerName || '',
      address: '',
      start_date: '',
      business_type: '',
      confidence: 95,
      is_business_license: true,
      notes: 'mock',
    },
  };
}

/**
 * 한국어 이름 정규화 — 띄어쓰기·법인 한자 표기 차이를 흡수.
 *  - 공백/제로폭 모두 제거
 *  - 괄호 표기 제거 ('홍길동(洪吉童)' → '홍길동')
 *  - NFKC 정규화로 전각/반각 통일
 */
function normalizeName(input) {
  if (!input || typeof input !== 'string') return '';
  return input
    .normalize('NFKC')
    .replace(/[\s\u200B-\u200D\uFEFF]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[\(\)（）]/g, '')
    .toLowerCase();
}

/**
 * 사업자번호 정규화 — 숫자만 10자리.
 */
function normalizeBizNumber(input) {
  if (!input) return '';
  return String(input).replace(/\D/g, '').slice(0, 10);
}

/**
 * OCR 결과 vs 셀러 입력값 자동 대조.
 * 일치 판정:
 *   - 사업자번호: 10자리 완전 일치 (체크섬 외 단순 비교)
 *   - 대표자명: 정규화 후 부분 일치 허용 (입력값이 OCR값에 포함되거나 그 반대)
 *
 * @returns {{
 *   match: boolean,
 *   businessNumberMatch: boolean,
 *   ownerNameMatch: boolean,
 *   confidence: number,
 *   isBusinessLicense: boolean,
 *   reasons: string[],
 * }}
 */
function compareWithInput({ ocr, input }) {
  const reasons = [];
  const ocrBizNum = normalizeBizNumber(ocr && ocr.business_number);
  const inputBizNum = normalizeBizNumber(input && input.businessNumber);
  const businessNumberMatch = Boolean(ocrBizNum && inputBizNum && ocrBizNum === inputBizNum);
  if (!businessNumberMatch) {
    if (!ocrBizNum) reasons.push('ocr_business_number_missing');
    else if (ocrBizNum !== inputBizNum) reasons.push('business_number_mismatch');
  }

  const ocrOwner = normalizeName(ocr && ocr.owner_name);
  const inputOwner = normalizeName(input && input.ownerName);
  let ownerNameMatch = false;
  if (ocrOwner && inputOwner) {
    if (ocrOwner === inputOwner) ownerNameMatch = true;
    // 부분 일치 허용 — '홍길동' vs '홍길동대표'
    else if (ocrOwner.includes(inputOwner) || inputOwner.includes(ocrOwner)) ownerNameMatch = true;
  }
  if (!ownerNameMatch) {
    if (!ocrOwner) reasons.push('ocr_owner_name_missing');
    else reasons.push('owner_name_mismatch');
  }

  const confidenceRaw = Number(ocr && ocr.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(100, Math.round(confidenceRaw)))
    : 0;

  const isBusinessLicense = Boolean(ocr && ocr.is_business_license !== false);
  if (!isBusinessLicense) reasons.push('not_business_license');

  return {
    match: businessNumberMatch && ownerNameMatch && isBusinessLicense,
    businessNumberMatch,
    ownerNameMatch,
    confidence,
    isBusinessLicense,
    reasons,
  };
}

/**
 * confidence·일치 여부로 자동 승인 가능 여부 결정.
 * 정책:
 *   - 모든 필드 일치 + confidence >= AUTO_APPROVE_THRESHOLD → true (즉시 approved)
 *   - 그 외 → false (사람 검토 pending)
 */
function shouldAutoApprove(comparison) {
  if (!comparison) return false;
  return comparison.match && comparison.confidence >= AUTO_APPROVE_THRESHOLD;
}

/**
 * 통합 진입점 — 업로드된 이미지를 OCR로 분석 + 셀러 입력값과 대조.
 * @param {{ imageBuffer: Buffer, mimeType: string, input: { businessNumber: string, ownerName: string, businessName?: string } }} opts
 * @returns {Promise<{
 *   mode: 'real'|'mock'|'skipped',
 *   extracted: object|null,
 *   comparison: object|null,
 *   autoApprove: boolean,
 *   error: string|null,
 * }>}
 */
async function validateLicenseOcr(opts) {
  const { imageBuffer, mimeType, input } = opts || {};
  const isMock = (process.env.AI_OCR_MOCK || 'true').toLowerCase() === 'true';

  // PDF / 형식 미지원은 OCR 스킵 (결과 null, autoApprove=false → pending)
  if (!isMock && (!mimeType || !mimeType.startsWith('image/'))) {
    return {
      mode: 'skipped',
      extracted: null,
      comparison: null,
      autoApprove: false,
      error: 'unsupported_format',
    };
  }

  const apiResult = isMock
    ? mockExtract({
        businessNumber: input && input.businessNumber,
        ownerName: input && input.ownerName,
        businessName: input && input.businessName,
      })
    : await callVisionApi(imageBuffer, mimeType);

  if (!apiResult.ok) {
    return {
      mode: isMock ? 'mock' : 'real',
      extracted: null,
      comparison: null,
      autoApprove: false,
      error: apiResult.errorReason || 'vision_failed',
    };
  }

  const extracted = sanitizeExtracted(apiResult.raw);
  const comparison = compareWithInput({ ocr: extracted, input });
  const autoApprove = shouldAutoApprove(comparison);

  return {
    mode: isMock ? 'mock' : 'real',
    extracted,
    comparison,
    autoApprove,
    error: null,
  };
}

/**
 * Vision raw 응답 → 표준 필드만 추려서 반환 (예상 외 키 차단 + 길이 제한).
 */
function sanitizeExtracted(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  OCR_FIELDS.forEach((key) => {
    const v = raw[key];
    out[key] = typeof v === 'string' ? v.trim().slice(0, 200) : '';
  });
  out.business_number = normalizeBizNumber(out.business_number);
  const cf = Number(raw.confidence);
  out.confidence = Number.isFinite(cf) ? Math.max(0, Math.min(100, Math.round(cf))) : 0;
  out.is_business_license = raw.is_business_license !== false;
  out.notes = typeof raw.notes === 'string' ? raw.notes.slice(0, 200) : '';
  return out;
}

module.exports = {
  validateLicenseOcr,
  compareWithInput,
  shouldAutoApprove,
  normalizeName,
  normalizeBizNumber,
  sanitizeExtracted,
  AUTO_APPROVE_THRESHOLD,
  OCR_FIELDS,
  // 테스트 전용
  _internals: { callVisionApi, mockExtract },
};
