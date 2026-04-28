// 이미지 URL 검증 — Sprint 3.5 마이그레이션
// HEAD 요청으로 1차 유효성 체크 (깨진 이미지 빨간 표시)
//
// 설계 원칙 (project_migration_export_structure.md):
// - HEAD 요청만 (대용량 다운로드 금지)
// - 타임아웃 3초 (1만 상품 × 3초 = 30000초 → 병렬 + 표본 필요)
// - 표본 검증 (전체 X, 첫 5개 + 무작위 5개만 = ₩무료)
// - 실패 시 셀러에게 "이미지 다시 업로드" 안내 (MobileFallback)

const IMAGE_EXT_RE = /\.(jpg|jpeg|png|gif|webp|bmp|heic|heif)(\?|#|$)/i;

/**
 * URL 형식 검증 (HTTP HEAD 호출 없이 빠른 패턴만)
 * @param {string} url
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateUrlFormat(url) {
  if (!url || typeof url !== 'string') return { valid: false, reason: 'URL 누락' };
  const trimmed = url.trim();
  if (!trimmed) return { valid: false, reason: 'URL 빈 값' };

  // 상대 경로 (플레이오토 자체 스토리지) — 별도 prefix 변환 필요
  if (!/^https?:\/\//i.test(trimmed)) {
    return { valid: false, reason: '절대 URL 아님 (https:// 필요)', isRelative: true };
  }

  // 확장자 검증 (선택)
  if (!IMAGE_EXT_RE.test(trimmed)) {
    return { valid: true, reason: '확장자 미감지 (HEAD 검증 필요)', warnExt: true };
  }

  return { valid: true };
}

/**
 * 이미지 URL CSV → 배열 분리.
 * @param {string} input - "https://a.jpg,https://b.jpg,https://c.jpg"
 * @returns {string[]}
 */
function parseImageUrlCsv(input) {
  if (!input || typeof input !== 'string') return [];
  return input.split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
}

/**
 * HEAD 요청으로 이미지 유효성 검증 (단일 URL).
 * @param {string} url
 * @param {{ timeoutMs?: number, mock?: boolean }} options
 * @returns {Promise<{ ok: boolean, status: number, contentType?: string, error?: string }>}
 */
async function headValidate(url, options = {}) {
  const timeoutMs = options.timeoutMs || 3000;
  const useMock = options.mock || process.env.AI_MIGRATION_MOCK === 'true';

  if (useMock) {
    // 모킹: URL 형식만 보고 결과 시뮬레이션
    const f = validateUrlFormat(url);
    return f.valid
      ? { ok: true, status: 200, contentType: 'image/jpeg', mocked: true }
      : { ok: false, status: 0, error: f.reason, mocked: true };
  }

  const fmt = validateUrlFormat(url);
  if (!fmt.valid) return { ok: false, status: 0, error: fmt.reason };

  let timer;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timer);
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get('content-type') || undefined,
    };
  } catch (e) {
    if (timer) clearTimeout(timer);
    return { ok: false, status: 0, error: e.name === 'AbortError' ? '타임아웃' : e.message };
  }
}

/**
 * 표본 검증 (1만 상품 → 첫 5 + 무작위 5).
 * @param {string[]} urls - 전체 URL 배열
 * @param {{ sampleSize?: number, mock?: boolean }} options
 * @returns {Promise<{ checked: number, brokenUrls: string[], successRate: number }>}
 */
async function sampleValidate(urls, options = {}) {
  if (!Array.isArray(urls) || urls.length === 0) {
    return { checked: 0, brokenUrls: [], successRate: 1 };
  }

  const sampleSize = options.sampleSize || 10;
  const sample = pickSample(urls, sampleSize);

  const results = await Promise.all(sample.map((u) => headValidate(u, options)));
  const broken = sample.filter((_, i) => !results[i].ok);
  const successRate = sample.length > 0 ? (sample.length - broken.length) / sample.length : 1;

  return {
    checked: sample.length,
    brokenUrls: broken,
    successRate: Number(successRate.toFixed(2)),
  };
}

function pickSample(arr, n) {
  if (arr.length <= n) return arr.slice();
  const head = arr.slice(0, Math.min(5, n));
  const remaining = arr.slice(Math.min(5, n));
  const randomCount = n - head.length;
  const random = [];
  const used = new Set();
  while (random.length < randomCount && used.size < remaining.length) {
    const idx = Math.floor(Math.random() * remaining.length);
    if (used.has(idx)) continue;
    used.add(idx);
    random.push(remaining[idx]);
  }
  return [...head, ...random];
}

module.exports = {
  validateUrlFormat,
  parseImageUrlCsv,
  headValidate,
  sampleValidate,
};
