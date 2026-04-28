// 가격 텍스트 → 정수 파서 — Sprint 3.5 마이그레이션
// "15,000원(품절)" → { value: 15000, flags: ['out_of_stock'] }
//
// 설계 원칙 (project_migration_export_structure.md):
// - 쉼표·"원"·공백·괄호 등 텍스트 제거 → Integer 강제 형변환
// - 부가 정보(품절·할인 등)는 flags 배열로 별도 추출
// - 음수·NaN·null은 0으로 (단, warning 반환)

const FLAGS_MAP = {
  '품절': 'out_of_stock',
  'soldout': 'out_of_stock',
  'sold out': 'out_of_stock',
  '재고없음': 'out_of_stock',
  '할인': 'discounted',
  'sale': 'discounted',
  '단종': 'discontinued',
};

/**
 * 가격 문자열·숫자 → 정수 + 플래그.
 * @param {string|number|null} input
 * @returns {{ value: number, flags: string[], warning?: string }}
 */
function parseCurrency(input) {
  if (input == null || input === '') {
    return { value: 0, flags: [], warning: '가격 누락' };
  }

  if (typeof input === 'number') {
    if (Number.isFinite(input) && input >= 0) return { value: Math.round(input), flags: [] };
    return { value: 0, flags: [], warning: `숫자 형식 오류: ${input}` };
  }

  const raw = String(input).trim();
  if (!raw) return { value: 0, flags: [], warning: '가격 빈 값' };

  const flags = [];
  for (const [keyword, flag] of Object.entries(FLAGS_MAP)) {
    if (raw.toLowerCase().includes(keyword.toLowerCase())) {
      if (!flags.includes(flag)) flags.push(flag);
    }
  }

  // 숫자만 추출 (소수점·음수 부호 보존, 1차 클렌징)
  const cleaned = raw.replace(/[^\d.\-]/g, '');
  if (!cleaned) return { value: 0, flags, warning: `가격 추출 실패: "${raw}"` };

  const num = parseFloat(cleaned);
  if (!Number.isFinite(num)) return { value: 0, flags, warning: `숫자 변환 실패: "${raw}"` };
  if (num < 0) return { value: 0, flags, warning: `음수 가격: "${raw}"` };

  return { value: Math.round(num), flags };
}

/**
 * 재고 수량 파서 — 음수·텍스트 등 정리.
 * @param {string|number|null} input
 * @returns {{ value: number, warning?: string }}
 */
function parseStock(input) {
  if (input == null || input === '') return { value: 0, warning: '재고 누락' };

  if (typeof input === 'number') {
    if (Number.isFinite(input) && input >= 0) return { value: Math.floor(input) };
    return { value: 0, warning: `재고 형식 오류: ${input}` };
  }

  const cleaned = String(input).replace(/[^\d.\-]/g, '');
  if (!cleaned) return { value: 0, warning: `재고 추출 실패: "${input}"` };

  const num = parseInt(cleaned, 10);
  if (!Number.isFinite(num)) return { value: 0, warning: `재고 변환 실패: "${input}"` };
  if (num < 0) return { value: 0, warning: `음수 재고: "${input}"` };

  return { value: num };
}

module.exports = {
  parseCurrency,
  parseStock,
};
