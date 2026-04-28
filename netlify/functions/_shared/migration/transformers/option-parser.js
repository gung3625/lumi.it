// 옵션 텍스트 파서 — Sprint 3.5 마이그레이션
// "색상:블랙|사이즈:XL" → [{ name: '색상', values: ['블랙'] }, { name: '사이즈', values: ['XL'] }]
//
// 설계 원칙 (project_migration_export_structure.md):
// - 솔루션별 구분자 다양 (`|`, `/`, `,`, `;`) → 자동 감지
// - 행 분리형 (사방넷) vs 결합형 (샵링커) 둘 다 지원
// - key:value 누락 시 value-only 옵션으로 폴백 (예: "S/M/L")

const SEPARATORS_PRIMARY = ['|', ';', '\n']; // 옵션 그룹 구분
const SEPARATORS_SECONDARY = ['/', ','];     // 값 리스트 구분
const KV_DELIMITERS = [':', '=', '-'];

/**
 * 옵션 결합 문자열 → 옵션 객체 배열.
 * @param {string} input - 예: "색상:블랙|사이즈:XL", "S/M/L", "색상-블랙,화이트;사이즈-M,L"
 * @returns {Array<{ name: string, values: string[] }>}
 */
function parseOptionString(input) {
  if (!input || typeof input !== 'string') return [];
  const trimmed = input.trim();
  if (!trimmed) return [];

  // 1. primary separator 감지
  const primarySep = SEPARATORS_PRIMARY.find((s) => trimmed.includes(s));
  const groups = primarySep ? trimmed.split(primarySep) : [trimmed];

  const options = [];
  for (const group of groups) {
    const g = group.trim();
    if (!g) continue;

    // 2. KV 구분자 감지
    let name = null;
    let valuePart = g;
    for (const delim of KV_DELIMITERS) {
      const idx = g.indexOf(delim);
      if (idx > 0 && idx < g.length - 1) {
        name = g.slice(0, idx).trim();
        valuePart = g.slice(idx + 1).trim();
        break;
      }
    }

    // 3. value 리스트 분리
    const secondarySep = SEPARATORS_SECONDARY.find((s) => valuePart.includes(s));
    const values = secondarySep
      ? valuePart.split(secondarySep).map((v) => v.trim()).filter(Boolean)
      : [valuePart];

    if (!name) {
      // value-only 폴백: "S/M/L" → name="옵션", values=["S","M","L"]
      name = options.length === 0 ? '옵션' : `옵션${options.length + 1}`;
    }

    options.push({ name: name.slice(0, 30), values: values.slice(0, 50).map((v) => String(v).slice(0, 50)) });
  }

  return options;
}

/**
 * 행 분리형 옵션 배열 → Lumi 옵션 객체 (name별 그룹핑)
 * @param {Array<{ name: string, value: string }>} rows
 * @returns {Array<{ name: string, values: string[] }>}
 */
function aggregateRowOptions(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const grouped = new Map();
  for (const r of rows) {
    if (!r || !r.name || !r.value) continue;
    const key = String(r.name).trim();
    if (!grouped.has(key)) grouped.set(key, new Set());
    grouped.get(key).add(String(r.value).trim());
  }

  return Array.from(grouped.entries()).map(([name, values]) => ({
    name: name.slice(0, 30),
    values: Array.from(values).filter(Boolean).slice(0, 50),
  }));
}

module.exports = {
  parseOptionString,
  aggregateRowOptions,
};
