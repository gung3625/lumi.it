// 반품·교환 풀 워크플로우 공용 유틸 — 사장님 승인 게이트 + Audit
//
// 핵심 정책 (메모리 project_ai_capability_boundary.md, feedback_market_integration_principles.md):
// - AI 자동 처리 X. 셀러 [예/아니오] 1탭만 진행
// - ₩100,000+ 또는 partial_refund = is_high_risk=TRUE → 더 강한 확인 UI
// - 모든 단계(요청·승인·처리·완료·실패) audit_trail JSONB에 누적

const HIGH_RISK_AMOUNT_KRW = 100_000;
const VALID_REQUEST_TYPES = new Set(['refund', 'exchange', 'partial_refund']);
const VALID_ACTIONS = new Set(['approve', 'reject', 'pending']);
const VALID_REASON_CATEGORIES = new Set(['change_of_mind', 'defect', 'damaged', 'wrong_item', 'size_issue', 'shipping_delay', 'other']);

/**
 * 위험 임계값 평가
 * @param {Object} input
 * @param {string} input.requestType
 * @param {number} input.totalPrice - 주문 총액
 * @param {number} [input.partialAmount]
 * @returns {{ isHighRisk: boolean, riskReason: string|null }}
 */
function evaluateRisk({ requestType, totalPrice, partialAmount }) {
  if (requestType === 'partial_refund') {
    return { isHighRisk: true, riskReason: '부분환불은 사장님 직접 확인 필수' };
  }
  if (Number.isFinite(totalPrice) && totalPrice >= HIGH_RISK_AMOUNT_KRW) {
    return { isHighRisk: true, riskReason: `₩${totalPrice.toLocaleString()} 거액 환불` };
  }
  if (requestType === 'partial_refund' && Number.isFinite(partialAmount) && partialAmount >= HIGH_RISK_AMOUNT_KRW) {
    return { isHighRisk: true, riskReason: `부분환불 ₩${partialAmount.toLocaleString()}` };
  }
  return { isHighRisk: false, riskReason: null };
}

/**
 * 상태 전이 기록 (return_status_transitions + audit_trail 누적용 entry 반환)
 * @param {Object} admin
 * @param {Object} args
 * @returns {Promise<{ ok: boolean, entry: Object }>}
 */
async function recordTransition(admin, { request_id, seller_id, from_status, to_status, transition_reason, actor_type, actor_id, metadata }) {
  const entry = {
    at: new Date().toISOString(),
    from: from_status || null,
    to: to_status,
    reason: transition_reason || null,
    actor_type: actor_type || 'system',
    actor_id: actor_id || null,
    metadata: metadata || null,
  };
  if (!admin || !request_id) return { ok: false, entry };
  try {
    await admin.from('return_status_transitions').insert({
      request_id,
      seller_id,
      from_status: from_status || null,
      to_status,
      transition_reason: transition_reason || null,
      actor_type: actor_type || 'system',
      actor_id: actor_id || null,
      metadata: metadata || null,
    });
    return { ok: true, entry };
  } catch (e) {
    return { ok: false, entry, error: e.message };
  }
}

/**
 * 마켓 어댑터 호출 로그 기록
 */
async function recordReturnLog(admin, log) {
  if (!admin) return { ok: false };
  try {
    await admin.from('return_logs').insert({
      request_id: log.request_id || null,
      seller_id: log.seller_id,
      marketplace: log.marketplace,
      operation: log.operation || 'process_return',
      request_payload: log.request_payload || null,
      response_status: log.response_status || null,
      response_body: log.response_body || null,
      duration_ms: log.duration_ms || null,
      ok: !!log.ok,
      error_message: log.error_message || null,
      retryable: !!log.retryable,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 알림 큐 적재 (실 발송은 send-notifications cron)
 */
async function enqueueNotification(admin, { request_id, seller_id, channel, template_key, payload }) {
  if (!admin) return { ok: false };
  try {
    await admin.from('return_notifications').insert({
      request_id: request_id || null,
      seller_id,
      channel,
      template_key,
      payload: payload || null,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * return_history 행 생성 (완료·실패 시점에 1회)
 */
async function recordHistory(admin, history) {
  if (!admin) return { ok: false };
  try {
    const { data, error } = await admin
      .from('return_history')
      .insert({
        request_id: history.request_id || null,
        order_id: history.order_id,
        seller_id: history.seller_id,
        marketplace: history.marketplace,
        type: history.type,
        reason: history.reason || null,
        status: history.status,
        amount: Number.isFinite(history.amount) ? history.amount : null,
        requested_at: history.requested_at || new Date().toISOString(),
        processed_at: history.processed_at || new Date().toISOString(),
        processed_by: history.processed_by || null,
        notes: history.notes || null,
        audit_trail: history.audit_trail || [],
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
 * 사장님 승인 게이트 — preview 모드 응답 빌더
 */
function buildPreviewResponse({ order, request, type, action, reason, amount, isHighRisk, riskReason }) {
  const messages = [];
  if (action === 'approve') {
    if (type === 'refund') {
      messages.push(`이 주문을 환불 처리하시겠어요? 환불금 ${(order.total_price || 0).toLocaleString()}원이 구매자에게 반환되고, 재고 ${order.quantity || 1}개가 자동 복원돼요.`);
    } else if (type === 'exchange') {
      messages.push('이 주문을 교환 처리하시겠어요? 새 송장이 필요하고, 기존 재고는 복원돼요.');
    } else {
      messages.push(`부분환불 ${(amount || 0).toLocaleString()}원을 진행하시겠어요? 재고 변동은 없어요.`);
    }
    if (isHighRisk) {
      messages.push(`⚠️ ${riskReason} — 한 번 더 확인해주세요.`);
    }
    messages.push('확인하시려면 confirm=true로 다시 호출해주세요.');
  } else if (action === 'reject') {
    messages.push('이 요청을 거절하시겠어요? 구매자에게 거절 사유 알림이 발송돼요.');
  }

  return {
    success: true,
    preview: true,
    confirmRequired: true,
    requestId: request?.id || null,
    order: order ? {
      id: order.id,
      market: order.market,
      market_order_id: order.market_order_id,
      product_title: order.product_title,
      quantity: order.quantity,
      total_price: order.total_price,
      status: order.status,
    } : null,
    action,
    type,
    reason,
    amount: type === 'partial_refund' ? amount : undefined,
    isHighRisk: !!isHighRisk,
    riskReason: riskReason || null,
    message: messages.join(' '),
  };
}

module.exports = {
  HIGH_RISK_AMOUNT_KRW,
  VALID_REQUEST_TYPES,
  VALID_ACTIONS,
  VALID_REASON_CATEGORIES,
  evaluateRisk,
  recordTransition,
  recordReturnLog,
  enqueueNotification,
  recordHistory,
  buildPreviewResponse,
};
