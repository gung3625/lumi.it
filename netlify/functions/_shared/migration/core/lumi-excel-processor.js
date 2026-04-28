// Lumi Excel Processor — Sprint 3.5 마이그레이션 메인 진입점
// busboy(multipart) → 인코딩 감지 → SheetJS → 솔루션 추론 → 4단 매핑 → Lumi 표준 스키마
//
// 사용처: /api/migration-upload (Netlify Function)
//
// 4단 매핑 파이프라인:
//   Phase 1 — 코드 lookup (사방넷 표준 → 100%)
//   Phase 2 — AI 매핑 보강 (변칙 컬럼, gpt-4o-mini)
//   Phase 3 — AI Cross-validation (메모리 단언, 현재 mock)
//   Phase 4 — 코드 룰 검증 + 셀러 검수 (validateRow)

const xlsx = (() => {
  try { return require('xlsx'); } catch { return null; }
})();

const { detectEncoding, toCodepage } = require('./encoding-detector');
const { identifySolution } = require('./solution-identifier');
const { mapHeaders } = require('./header-mapper');
const { parseSabangSheet } = require('../parsers/sabang-parser');
const { parseCurrency, parseStock } = require('../transformers/currency-parser');
const { parseOptionString, aggregateRowOptions } = require('../transformers/option-parser');
const { validateUrlFormat, parseImageUrlCsv } = require('../transformers/image-validator');
const { checkProducts } = require('../transformers/policy-word-checker');

const FILE_SIZE_LIMIT = 50 * 1024 * 1024; // 50MB
const ROW_LIMIT_INLINE = 10_000;          // 1만+ → 백그라운드 워커 권장

/**
 * @typedef {Object} MigrationResult
 * @property {boolean} success
 * @property {string} solution - 'sabangnet'|'shoplinker'|...
 * @property {number} solutionConfidence
 * @property {Array} headerMapping - [{ original, mapped, confidence, source }]
 * @property {Array} products - Lumi 표준 형식
 * @property {Array} previews - 첫 5개 (Aha Moment 카드)
 * @property {Object} stats - { total, valid, invalid, redFlagCount, policyViolations }
 * @property {string[]} warnings
 * @property {string} migrationId - 추적용 UUID
 */

/**
 * 엑셀 버퍼 → Lumi 표준 마이그레이션 결과.
 * @param {Buffer} buffer - 엑셀 파일 바이너리
 * @param {{ filename?: string, mockAi?: boolean }} options
 * @returns {Promise<MigrationResult>}
 */
async function processExcelBuffer(buffer, options = {}) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    return failResult('파일 버퍼가 비었습니다.');
  }
  if (buffer.length > FILE_SIZE_LIMIT) {
    return failResult(`파일 크기 한도 초과 (${Math.floor(buffer.length / 1024 / 1024)}MB > 50MB)`);
  }
  if (!xlsx) {
    return failResult('xlsx 라이브러리 미설치 (npm install xlsx 필요)');
  }

  const warnings = [];
  let workbook;
  try {
    const encoding = detectEncoding(buffer);
    const codepage = toCodepage(encoding);
    workbook = xlsx.read(buffer, {
      type: 'buffer',
      codepage,
      cellDates: false,
      cellNF: false,
    });
  } catch (e) {
    return failResult(`엑셀 파싱 실패: ${e.message}`);
  }

  const sheetName = workbook.SheetNames?.[0];
  if (!sheetName) return failResult('엑셀에 시트가 없습니다.');

  const sheet = workbook.Sheets[sheetName];
  const rawRows = xlsx.utils.sheet_to_json(sheet, { defval: null, raw: false });
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    return failResult('엑셀이 비었거나 헤더만 있습니다.');
  }

  if (rawRows.length > ROW_LIMIT_INLINE) {
    warnings.push(`${rawRows.length.toLocaleString()}개 상품 — 백그라운드 처리로 전환됩니다.`);
  }

  // 헤더 추출
  const headers = Object.keys(rawRows[0] || {});
  if (headers.length === 0) return failResult('헤더를 추출하지 못했습니다.');

  // 솔루션 자동 감지
  const detected = identifySolution(headers);

  // 4단 파이프라인 Phase 1+2: 헤더 매핑
  const headerMapping = await mapHeaders(headers, {
    solution: detected.solution,
    mockAi: options.mockAi,
  });

  // Phase 4 (셀러 검수 진입 전 자동 검증)
  const mappedRows = applyHeaderMapping(rawRows, headerMapping);

  // 사방넷 옵션 모드 자동 감지
  let products = [];
  let optionMode = 'none';
  if (detected.solution === 'sabangnet') {
    const sabang = parseSabangSheet(rawRows, { headers });
    optionMode = sabang.optionMode;
    if (sabang.warnings.length) warnings.push(...sabang.warnings);
    products = sabang.products.map((p) => normalizeProduct(p.master, p.options, headerMapping));
  } else {
    // 그 외 솔루션은 단일 행 정규화 (옵션은 결합형 가정)
    products = mappedRows.map((row) => normalizeProduct(row, [], headerMapping));
  }

  // Phase 4: 검증
  const validated = products.map((p) => {
    const errors = validateRow(p);
    return { ...p, _errors: errors, _valid: errors.length === 0 };
  });

  const valid = validated.filter((p) => p._valid).length;
  const invalid = validated.length - valid;
  const redFlagCount = validated.filter((p) => p._errors.length > 0).length;

  // 정책 위반 단어 사전 검사 (마이그레이션 시점, 표시만)
  const policyResult = checkProducts(validated.map((p) => ({ product_name: p.title, sku_code: p.sku_code })));

  const previews = validated.slice(0, 5).map((p, i) => ({
    index: i,
    sku_code: p.sku_code,
    title: p.title,
    price: p.price,
    stock: p.stock,
    image_urls: p.image_urls,
    options: p.options,
    valid: p._valid,
    errors: p._errors,
    aha: buildAhaCopy(p),
  }));

  return {
    success: true,
    solution: detected.solution,
    solutionConfidence: detected.confidence,
    headerMapping,
    optionMode,
    products: validated,
    previews,
    stats: {
      total: validated.length,
      valid,
      invalid,
      redFlagCount,
      policyViolations: policyResult.violatingCount,
    },
    policyWarnings: policyResult.warnings,
    warnings,
    migrationId: generateMigrationId(),
  };
}

function failResult(message) {
  return {
    success: false,
    error: message,
    products: [],
    previews: [],
    stats: { total: 0, valid: 0, invalid: 0, redFlagCount: 0, policyViolations: 0 },
    warnings: [],
  };
}

/**
 * 헤더 매핑 적용 — 원본 행을 Lumi 키로 변환.
 * @param {Array<Object>} rows
 * @param {Array<{ original: string, mapped: string|null }>} mapping
 */
function applyHeaderMapping(rows, mapping) {
  const lookup = new Map();
  for (const m of mapping) {
    if (m.mapped) lookup.set(m.original, m.mapped);
  }
  return rows.map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      const lumiKey = lookup.get(k);
      if (lumiKey) {
        // 같은 키에 여러 원본이 매핑되면 덮어쓰기 (일반적으로 1:1)
        if (out[lumiKey] == null) out[lumiKey] = v;
      }
    }
    out._raw = row;
    return out;
  });
}

/**
 * 단일 행 → Lumi 표준 상품 객체.
 * @param {Object} row - applyHeaderMapping 결과 또는 raw row
 * @param {Array<{name:string, value:string}>} optionRows - 행 분리형 옵션
 * @param {Array} headerMapping
 */
function normalizeProduct(row, optionRows, headerMapping) {
  // row가 raw일 수도 있어서 헤더 매핑 lookup 한 번 더
  const lumi = {};
  if (row._raw) Object.assign(lumi, row);
  else {
    const lookup = new Map();
    for (const m of headerMapping) if (m.mapped) lookup.set(m.original, m.mapped);
    for (const [k, v] of Object.entries(row)) {
      const lk = lookup.get(k);
      if (lk && lumi[lk] == null) lumi[lk] = v;
    }
  }

  const priceParsed = parseCurrency(lumi.price);
  const stockParsed = parseStock(lumi.stock);

  // 옵션: 행 분리형 우선, 결합형 폴백
  let options = [];
  if (Array.isArray(optionRows) && optionRows.length > 0) {
    options = aggregateRowOptions(optionRows);
  } else if (lumi.option_value) {
    options = parseOptionString(String(lumi.option_value));
  } else if (lumi.option_name && lumi.option_value) {
    options = [{ name: String(lumi.option_name), values: [String(lumi.option_value)] }];
  }

  const imageUrls = parseImageUrlCsv(String(lumi.image_url || ''));

  return {
    sku_code: String(lumi.sku_code || '').trim().slice(0, 80) || null,
    title: String(lumi.product_name || '').trim().slice(0, 100) || null,
    price: priceParsed.value,
    msrp: lumi.msrp ? parseCurrency(lumi.msrp).value : null,
    stock: stockParsed.value,
    options,
    category_id: lumi.category_id ? String(lumi.category_id).trim() : null,
    image_urls: imageUrls,
    tax_type: normalizeTaxType(lumi.tax_type),
    flags: priceParsed.flags || [],
    _warnings: [
      ...(priceParsed.warning ? [priceParsed.warning] : []),
      ...(stockParsed.warning ? [stockParsed.warning] : []),
    ],
  };
}

function normalizeTaxType(value) {
  if (!value) return '과세'; // 기본값
  const s = String(value).trim();
  if (['과세', '면세', '영세'].includes(s)) return s;
  if (/면세|tax-free|exempt/i.test(s)) return '면세';
  if (/영세|zero-rate/i.test(s)) return '영세';
  return '과세';
}

/**
 * Lumi 표준 행 검증 (memory `lumi-product-schema.md` validateRow).
 * @param {Object} p - normalizeProduct 결과
 * @returns {string[]} - 에러 메시지 배열
 */
function validateRow(p) {
  const errors = [];
  if (!p.sku_code) errors.push('상품코드 누락');
  else if (p.sku_code.length > 80) errors.push('상품코드 80자 초과');
  if (!p.title) errors.push('상품명 누락');
  if (!Number.isInteger(p.price) || p.price <= 0) errors.push('판매가 형식 오류');
  if (!Number.isInteger(p.stock) || p.stock < 0) errors.push('재고 형식 오류');
  if (!p.image_urls || p.image_urls.length === 0) errors.push('대표이미지 누락');
  return errors;
}

/**
 * Aha Moment 카피 — 5개 미리보기 카드의 결제 트리거.
 * @param {Object} product
 * @returns {{ tagline: string, hint: string }}
 */
function buildAhaCopy(product) {
  const hints = [];
  if (product.options && product.options.length > 0) {
    hints.push(`옵션 ${product.options.length}종 자동 인식`);
  }
  if (product.image_urls && product.image_urls.length > 1) {
    hints.push(`이미지 ${product.image_urls.length}장 그대로`);
  }
  if (product.price > 0) {
    hints.push(`판매가 ${product.price.toLocaleString()}원 정리됨`);
  }
  return {
    tagline: product._valid ? '바로 등록 가능해요' : '검토 후 등록',
    hint: hints.join(' · ') || '기본 정보 정리됨',
  };
}

function generateMigrationId() {
  return 'mig_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

module.exports = {
  processExcelBuffer,
  applyHeaderMapping,
  normalizeProduct,
  validateRow,
  buildAhaCopy,
  FILE_SIZE_LIMIT,
  ROW_LIMIT_INLINE,
};
