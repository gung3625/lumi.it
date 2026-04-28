// 사방넷 표준 양식 파서 — Sprint 3.5 마이그레이션 V1
// 사방넷 양식 특징:
//   - 1행 = 한글 명칭 (예: "상품명")
//   - 2행 = 시스템 필드명 (예: "it_name")
//   - 옵션 = 행 분리형(default) 또는 결합형 토글 가능
//   - 인코딩 = 구형 EUC-KR(CP949) / 신형 UTF-8
//
// 설계 원칙 (project_migration_export_structure.md A. 사방넷):
// - 1~2행의 시스템 필드명 우선 스캔 (한글 명칭이 다양해도 시스템 필드는 고정)
// - 옵션 출력 모드 자동 감지: 동일 sku_code가 여러 행이면 행 분리형
// - 한 행에 옵션 결합 문자열이 있으면 결합형

const SOLUTION_MAPPINGS = {
  sabangnet: {
    '판매자상품코드': 'sku_code',
    '상품코드': 'sku_code',
    'it_name': 'product_name',
    '상품명': 'product_name',
    'it_title': 'product_name',
    'it_price': 'price',
    '판매가': 'price',
    '소비자가': 'msrp',
    'it_stock': 'stock',
    '재고수량': 'stock',
    '옵션명': 'option_name',
    '옵션값': 'option_value',
    'it_img': 'image_url',
    '대표이미지URL': 'image_url',
    '대표이미지': 'image_url',
    '카테고리코드': 'category_id',
    '카테고리': 'category_id',
    '과세구분': 'tax_type',
  },
  shoplinker: {
    '판매자관리코드': 'sku_code',
    '마스터상품ID': 'sku_code',
    '상품명': 'product_name',
    '판매가': 'price',
    '공급가': 'msrp',
    '소비자가': 'msrp',
    '재고수량': 'stock',
    '옵션값': 'option_value',
    '옵션명': 'option_name',
    '대표이미지': 'image_url',
    '카테고리명': 'category_id',
  },
  ezadmin: {
    '상품관리코드': 'sku_code',
    '바코드': 'sku_code',
    '상품명': 'product_name',
    '판매단가': 'price',
    '소비자가': 'msrp',
    '현재고': 'stock',
    '옵션내용': 'option_value',
    '옵션명': 'option_name',
    '상품이미지': 'image_url',
    '이지카테고리': 'category_id',
  },
  plto: {
    '자체상품코드': 'sku_code',
    'EMP상품코드': 'sku_code',
    '상품명': 'product_name',
    '판매가': 'price',
    '재고': 'stock',
    '옵션': 'option_value',
    '메인이미지': 'image_url',
    '마켓카테고리': 'category_id',
  },
};

const SYNONYMS = {
  sku_code: ['판매자상품코드', '셀러관리코드', '자체상품코드', '상품코드', '관리코드', '상품번호', 'SKU', '자체관리코드'],
  product_name: ['상품명', '제품명', '품명', '상품 이름', 'it_name', 'it_title', 'title', 'name', 'product_name'],
  price: ['판매가', '가격', '단가', '실판매가', '셀러판매가', 'selling_price', 'price', 'amount', 'it_price'],
  msrp: ['소비자가', '정가', '권장소비자가', '표시가격', 'msrp', 'retail_price', 'list_price', '공급가'],
  option_name: ['옵션명', '옵션이름', '속성명', 'option_name', 'attribute_name'],
  option_value: ['옵션값', '옵션데이터', '속성값', 'option_value', 'attribute_value', '옵션내용'],
  stock: ['재고수량', '재고', '수량', '가용재고', 'stock', 'qty', 'inventory', 'quantity', 'it_stock', '현재고'],
  category_id: ['카테고리코드', '카테고리ID', '분류코드', '카테고리', 'category', 'category_id', 'cat_no', '카테고리명', '이지카테고리'],
  image_url: ['대표이미지URL', '대표이미지', '이미지', '이미지URL', '상품이미지', 'image', 'image_url', 'thumbnail', 'thumbnails', 'it_img', '메인이미지'],
  tax_type: ['과세구분', '과세여부', '세금구분', 'tax', 'tax_type', 'vat_type'],
};

/**
 * 사방넷 양식 파싱.
 * 1~2행 시스템 필드명 우선 → 옵션 출력 모드 자동 감지 → 행 그룹핑
 *
 * @param {Array<Object>} rows - SheetJS sheet_to_json 결과
 * @param {{ headers: string[] }} meta
 * @returns {{ products: Array, optionMode: 'row-split'|'inline'|'none', warnings: string[] }}
 */
function parseSabangSheet(rows, meta = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { products: [], optionMode: 'none', warnings: ['빈 시트입니다.'] };
  }

  const warnings = [];
  const skuCounts = new Map();
  let inlineOptionRows = 0;

  for (const row of rows) {
    const sku = row['판매자상품코드'] || row['상품코드'] || row['sku_code'];
    if (sku) {
      skuCounts.set(sku, (skuCounts.get(sku) || 0) + 1);
    }
    const optVal = row['옵션값'] || row['option_value'] || row['옵션내용'];
    if (typeof optVal === 'string' && /[|/;,]/.test(optVal) && /:/.test(optVal)) {
      inlineOptionRows++;
    }
  }

  const duplicateSku = Array.from(skuCounts.values()).filter((c) => c > 1).length;
  let optionMode = 'none';
  if (duplicateSku > 0) optionMode = 'row-split';
  else if (inlineOptionRows > 0) optionMode = 'inline';

  if (optionMode === 'row-split' && inlineOptionRows > 0) {
    warnings.push('옵션 표기가 혼재되어 있어요 (행 분리 + 결합형 동시 발견). 일부 옵션 누락 가능.');
  }

  // 행 분리형 → SKU 기준 그룹핑
  if (optionMode === 'row-split') {
    const grouped = new Map();
    for (const row of rows) {
      const sku = row['판매자상품코드'] || row['상품코드'] || row['sku_code'];
      if (!sku) continue;
      if (!grouped.has(sku)) {
        grouped.set(sku, { master: row, options: [] });
      }
      const entry = grouped.get(sku);
      const optName = row['옵션명'] || row['option_name'];
      const optVal = row['옵션값'] || row['option_value'];
      if (optName && optVal) {
        entry.options.push({ name: String(optName).trim(), value: String(optVal).trim() });
      }
    }
    return {
      products: Array.from(grouped.values()),
      optionMode,
      warnings,
    };
  }

  // 단일 행 (결합형 또는 옵션 없음)
  return {
    products: rows.map((r) => ({ master: r, options: [] })),
    optionMode,
    warnings,
  };
}

module.exports = {
  parseSabangSheet,
  SOLUTION_MAPPINGS,
  SYNONYMS,
};
