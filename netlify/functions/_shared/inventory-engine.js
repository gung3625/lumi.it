// 재고 가산·차감 엔진 — Sprint 3 역방향 파이프라인
// inventory_movements 기록 + 마켓 동기화 트리거 (현재는 기록만, sync는 별도)
// 메모리 project_data_pipeline_architecture.md C항 (역방향)

/**
 * 재고 변동 기록
 * @param {Object} admin - Supabase admin client
 * @param {Object} movement
 * @param {string} movement.seller_id
 * @param {string|null} movement.product_id
 * @param {string|null} movement.market
 * @param {'sale'|'return'|'exchange'|'manual'|'sync'} movement.movement_type
 * @param {number} movement.quantity_delta - 음수 차감 / 양수 가산
 * @param {string|null} [movement.reference_type]
 * @param {string|null} [movement.reference_id]
 * @param {string|null} [movement.note]
 * @returns {Promise<{ ok: boolean, id?: string, error?: string }>}
 */
async function recordMovement(admin, movement) {
  if (!admin) return { ok: false, error: 'admin client missing' };
  if (!movement || !movement.seller_id) return { ok: false, error: 'seller_id required' };
  if (!Number.isFinite(movement.quantity_delta) || movement.quantity_delta === 0) {
    return { ok: false, error: 'quantity_delta must be non-zero number' };
  }
  try {
    const { data, error } = await admin
      .from('inventory_movements')
      .insert({
        seller_id: movement.seller_id,
        product_id: movement.product_id || null,
        market: movement.market || null,
        movement_type: movement.movement_type || 'manual',
        quantity_delta: Math.trunc(movement.quantity_delta),
        reference_type: movement.reference_type || null,
        reference_id: movement.reference_id || null,
        note: movement.note || null,
      })
      .select('id')
      .single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: data.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 반품 처리 → 재고 가산 (orders.stock_restored=TRUE 갱신 + inventory_movements 기록)
 * @param {Object} admin
 * @param {Object} order - { id, seller_id, product_id, market, quantity }
 * @returns {Promise<{ ok: boolean, movement_id?: string, error?: string }>}
 */
async function restoreStockForReturn(admin, order) {
  if (!order || !order.id || !order.seller_id) {
    return { ok: false, error: 'order(id, seller_id) required' };
  }
  if (order.stock_restored) {
    return { ok: true, alreadyRestored: true };
  }
  const qty = Math.max(1, Number(order.quantity || 1));
  // 1. inventory_movements 기록
  const mv = await recordMovement(admin, {
    seller_id: order.seller_id,
    product_id: order.product_id || null,
    market: order.market || null,
    movement_type: 'return',
    quantity_delta: qty,  // 양수 가산
    reference_type: 'order',
    reference_id: order.id,
    note: '반품 자동 재고 가산',
  });
  if (!mv.ok) return { ok: false, error: mv.error };

  // 2. orders.stock_restored 갱신
  if (admin && admin.from) {
    const { error } = await admin
      .from('marketplace_orders')
      .update({
        stock_restored: true,
        stock_restored_at: new Date().toISOString(),
        return_completed_at: new Date().toISOString(),
      })
      .eq('id', order.id);
    if (error) return { ok: false, movement_id: mv.id, error: error.message };
  }
  return { ok: true, movement_id: mv.id, quantity_delta: qty };
}

/**
 * 판매 시 재고 차감 (주문 수신 시점)
 * @param {Object} admin
 * @param {Object} order - { id, seller_id, product_id, market, quantity }
 * @returns {Promise<{ ok: boolean, movement_id?: string, error?: string }>}
 */
async function deductStockForSale(admin, order) {
  if (!order || !order.seller_id) return { ok: false, error: 'seller_id required' };
  const qty = Math.max(1, Number(order.quantity || 1));
  return recordMovement(admin, {
    seller_id: order.seller_id,
    product_id: order.product_id || null,
    market: order.market || null,
    movement_type: 'sale',
    quantity_delta: -qty,
    reference_type: 'order',
    reference_id: order.id,
    note: `${order.market || ''} 주문 차감`,
  });
}

module.exports = {
  recordMovement,
  restoreStockForReturn,
  deductStockForSale,
};
