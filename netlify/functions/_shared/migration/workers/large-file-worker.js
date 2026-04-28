// 대용량 파일 백그라운드 워커 — Sprint 3.5
// 1만+ 상품 시 메인 핸들러에서 위임 (Priority Queue 또는 -background suffix)
//
// 설계 (project_migration_export_structure.md `대용량 파일 처리`):
// - SheetJS sheet_to_json은 메모리 로드 → 50MB / 1만행에서 위험
// - 행 단위 스트리밍 + 100~500행 배치 INSERT
// - 진행률 = Supabase Realtime 또는 polling endpoint

const { processExcelBuffer } = require('../core/lumi-excel-processor');

/**
 * 대용량 파일 처리 진입점 (현재 구현 = 메모리 1회 처리 + 배치 INSERT 모킹).
 * V2에서 xlsx-stream-reader로 교체.
 *
 * @param {Buffer} buffer
 * @param {{ migrationId: string, sellerId?: string, mockAi?: boolean, batchSize?: number }} options
 * @returns {Promise<{ success: boolean, batches: number, totalRows: number }>}
 */
async function processLargeFile(buffer, options = {}) {
  const batchSize = options.batchSize || 200;
  const result = await processExcelBuffer(buffer, options);

  if (!result.success) return { success: false, batches: 0, totalRows: 0, error: result.error };

  const products = result.products || [];
  const batches = Math.ceil(products.length / batchSize);

  // 배치 분할 (실제 INSERT는 migration-execute에서 호출)
  const chunks = [];
  for (let i = 0; i < products.length; i += batchSize) {
    chunks.push(products.slice(i, i + batchSize));
  }

  return {
    success: true,
    migrationId: result.migrationId,
    solution: result.solution,
    totalRows: products.length,
    batches: chunks.length,
    chunks,
    stats: result.stats,
  };
}

module.exports = {
  processLargeFile,
};
