// 반품·교환·부분환불 풀 사이클 처리 — 사장님 승인 게이트
// POST /api/return-process
// Body: {
//   orderId,                          // 또는 requestId (기존 요청 처리)
//   requestId?,
//   requestType: 'refund'|'exchange'|'partial_refund',
//   reason?,
//   reasonCategory?,                  // 'change_of_mind' / 'defect' / ...
//   action: 'approve'|'reject'|'pending',
//   amount?,                          // partial_refund 금액
//   exchangeProductId?,               // exchange 시
//   note?,                            // 셀러 메모
//   confirm?: true                    // false면 preview만 (실제 마켓 호출 X)
// }
//
// 동작:
// 1. JWT 검증 + 주문/요청 조회 (소유자 확인)
// 2. action='reject' → status=rejected + 알림
// 3. action='approve' + confirm!=true → preview 응답 (위험 임계값 표기)
// 4. action='approve' + confirm=true:
//    a. status=approved → processing 전이
//    b. 마켓 어댑터 processReturn 호출
//    c. 성공 시: 재고 복원 (refund/exchange) + history 기록 + 알림
//    d. 실패 시: status=failed + retry_queue 적재
// 5. 모든 단계 audit_logs + return_status_transitions 기록

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { recordAudit } = require('./_shared/onboarding-utils');
const { translateMarketError } = require('./_shared/market-errors');
const { tryAcquire } = require('./_shared/throttle');
const retryEngine = require('./_shared/retry-engine');
const { restoreStockForReturn } = require('./_shared/inventory-engine');
const coupangOrders = require('./_shared/market-adapters/coupang-orders-adapter');
const naverOrders = require('./_shared/market-adapters/naver-orders-adapter');
const tossOrders = require('./_shared/market-adapters/toss-orders-adapter');
const {
  VALID_REQUEST_TYPES,
  VALID_ACTIONS,
  VALID_REASON_CATEGORIES,
  evaluateRisk,
  recordTransition,
  recordReturnLog,
  enqueueNotification,
  recordHistory,
  buildPreviewResponse,
} = require('./_shared/return-workflow');

const ADAPTERS = { coupang: coupangOrders, naver: naverOrders, toss: tossOrders };

function adapterMockEnabled() {
  return (process.env.COUPANG_VERIFY_MOCK || 'true').toLowerCase() !== 'false'
    || (process.env.NAVER_VERIFY_MOCK || 'true').toLowerCase() !== 'false'
    || (process.env.TOSS_VERIFY_MOCK || 'true').toLowerCase() !== 'false';
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error: authErr } = verifySellerToken(token);
  if (authErr || !payload) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요해요.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청 형식이에요.' }) };
  }

  const orderId = String(body.orderId || body.order_id || '').trim();
  const requestId = String(body.requestId || body.request_id || '').trim();
  if (!orderId && !requestId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '주문 ID 또는 요청 ID가 필요해요.' }) };
  }
  const requestType = VALID_REQUEST_TYPES.has(body.requestType) ? body.requestType : 'refund';
  const reasonCategory = VALID_REASON_CATEGORIES.has(body.reasonCategory) ? body.reasonCategory : null;
  const reason = String(body.reason || '').trim().slice(0, 500);
  const action = VALID_ACTIONS.has(body.action) ? body.action : 'pending';
  const amount = Number.isFinite(body.amount) ? Math.trunc(body.amount) : null;
  const exchangeProductId = body.exchangeProductId || body.exchange_product_id || null;
  const note = String(body.note || '').trim().slice(0, 1000);
  const confirm = body.confirm === true;

  if (requestType === 'partial_refund' && (amount === null || amount <= 0)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '부분환불 금액은 0원 초과여야 해요.' }) };
  }

  const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
  const mock = adapterMockEnabled();
  let admin = null;
  try { admin = getAdminClient(); } catch {
    if (!isSignupMock) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
    }
  }

  // 요청 또는 주문 조회
  let request = null;
  let order = null;

  if (admin) {
    if (requestId) {
      const { data, error: rErr } = await admin
        .from('return_requests')
        .select('id, seller_id, order_id, marketplace, request_type, reason, reason_category, partial_amount, exchange_product_id, status, is_high_risk, risk_reason, requested_at, approved_at')
        .eq('id', requestId)
        .eq('seller_id', payload.seller_id)
        .single();
      if (rErr || !data) {
        return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '요청을 찾을 수 없어요.' }) };
      }
      request = data;
    }

    const lookupOrderId = orderId || request?.order_id;
    if (lookupOrderId) {
      const { data: o, error: oErr } = await admin
        .from('marketplace_orders')
        .select('id, seller_id, market, market_order_id, product_id, product_title, quantity, total_price, status, stock_restored, return_requested_at, return_reason')
        .eq('id', lookupOrderId)
        .eq('seller_id', payload.seller_id)
        .single();
      if (oErr || !o) {
        return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '주문을 찾을 수 없어요.' }) };
      }
      order = o;
    }
  } else {
    // 모킹
    order = {
      id: orderId || 'mock-order-1',
      seller_id: payload.seller_id,
      market: 'coupang',
      market_order_id: `CP_MOCK_${orderId || '1'}`,
      product_id: null,
      product_title: '모킹 상품',
      quantity: 1,
      total_price: 39000,
      status: 'paid',
      stock_restored: false,
    };
  }

  if (!order) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '주문 정보가 없어요.' }) };
  }
  if (!ADAPTERS[order.market]) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '지원하지 않는 마켓이에요.' }) };
  }

  // 위험 임계값 평가
  const { isHighRisk, riskReason } = evaluateRisk({
    requestType,
    totalPrice: order.total_price,
    partialAmount: amount,
  });

  // ===========================================================================
  // 분기 1: 거절
  // ===========================================================================
  if (action === 'reject') {
    if (!confirm) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify(buildPreviewResponse({ order, request, type: requestType, action, reason, amount, isHighRisk, riskReason })),
      };
    }
    if (admin) {
      let rejectId = request?.id;
      if (!rejectId) {
        // 요청 자체가 없으면 새로 만들고 즉시 reject
        const { data: created } = await admin
          .from('return_requests')
          .insert({
            seller_id: payload.seller_id,
            order_id: order.id,
            marketplace: order.market,
            request_type: requestType,
            reason: reason || null,
            reason_category: reasonCategory,
            partial_amount: amount,
            exchange_product_id: exchangeProductId,
            is_high_risk: isHighRisk,
            risk_reason: riskReason,
            status: 'rejected',
            rejected_at: new Date().toISOString(),
            processed_by: payload.seller_id,
            seller_note: note || null,
          })
          .select('id, requested_at')
          .single();
        rejectId = created?.id;
        request = created || null;
      } else {
        await admin
          .from('return_requests')
          .update({
            status: 'rejected',
            rejected_at: new Date().toISOString(),
            processed_by: payload.seller_id,
            seller_note: note || null,
          })
          .eq('id', rejectId);
      }

      const tr = await recordTransition(admin, {
        request_id: rejectId,
        seller_id: payload.seller_id,
        from_status: request?.status || 'pending',
        to_status: 'rejected',
        transition_reason: '셀러 거절',
        actor_type: 'seller',
        actor_id: payload.seller_id,
        metadata: { note: note || null },
      });

      await recordHistory(admin, {
        request_id: rejectId,
        order_id: order.id,
        seller_id: payload.seller_id,
        marketplace: order.market,
        type: requestType,
        reason,
        status: 'rejected',
        amount: requestType === 'partial_refund' ? amount : null,
        requested_at: request?.requested_at || new Date().toISOString(),
        processed_by: payload.seller_id,
        notes: note,
        audit_trail: [tr.entry],
      });

      await enqueueNotification(admin, {
        request_id: rejectId,
        seller_id: payload.seller_id,
        channel: 'buyer_alarm',
        template_key: 'return_rejected',
        payload: { reason: note || reason },
      });

      await recordAudit(admin, {
        actor_id: payload.seller_id,
        actor_type: 'seller',
        action: 'return_reject',
        resource_type: 'return_requests',
        resource_id: rejectId,
        metadata: { market: order.market, type: requestType, order_id: order.id },
        event,
      });
    }

    console.log(`[return-process] seller=${payload.seller_id.slice(0,8)} order=${order.id.slice(0,8)} action=reject type=${requestType}`);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        action: 'reject',
        requestId: request?.id || null,
        orderId: order.id,
        message: '요청을 거절했어요. 구매자에게 거절 알림이 전송돼요.',
      }),
    };
  }

  // ===========================================================================
  // 분기 2: pending → 큐 등록만 (실 처리는 사장님 별도 승인)
  // ===========================================================================
  if (action === 'pending') {
    if (!admin) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, action: 'pending', mocked: true, requestId: 'mock-pending-1' }) };
    }
    const { data: created, error: insErr } = await admin
      .from('return_requests')
      .insert({
        seller_id: payload.seller_id,
        order_id: order.id,
        marketplace: order.market,
        request_type: requestType,
        reason: reason || null,
        reason_category: reasonCategory,
        partial_amount: requestType === 'partial_refund' ? amount : null,
        exchange_product_id: exchangeProductId,
        is_high_risk: isHighRisk,
        risk_reason: riskReason,
        status: 'pending',
        seller_note: note || null,
      })
      .select('id, requested_at')
      .single();
    if (insErr) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '요청 등록 실패' }) };
    }
    await recordTransition(admin, {
      request_id: created.id,
      seller_id: payload.seller_id,
      from_status: null,
      to_status: 'pending',
      transition_reason: '요청 큐 등록',
      actor_type: 'seller',
      actor_id: payload.seller_id,
    });
    await recordAudit(admin, {
      actor_id: payload.seller_id,
      actor_type: 'seller',
      action: 'return_request_create',
      resource_type: 'return_requests',
      resource_id: created.id,
      metadata: { market: order.market, type: requestType, is_high_risk: isHighRisk, order_id: order.id },
      event,
    });
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        action: 'pending',
        requestId: created.id,
        orderId: order.id,
        isHighRisk,
        riskReason,
        message: '요청이 우선순위 큐에 등록됐어요. 검토 후 승인해주세요.',
      }),
    };
  }

  // ===========================================================================
  // 분기 3: 승인 — preview / 실 처리
  // ===========================================================================
  // confirm=false면 preview만
  if (!confirm) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify(buildPreviewResponse({ order, request, type: requestType, action: 'approve', reason, amount, isHighRisk, riskReason })),
    };
  }

  // 위험 임계값인데 confirm=true지만 force=true가 아닐 경우, 추가 안내 (1탭 더)
  if (isHighRisk && body.acknowledgeRisk !== true) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: false,
        confirmRequired: true,
        isHighRisk: true,
        riskReason,
        message: `${riskReason}. 진행하려면 acknowledgeRisk=true 와 confirm=true 모두 보내주세요.`,
      }),
    };
  }

  // 이미 완료된 주문 가드
  if (order.status === 'returned' && order.stock_restored) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        alreadyProcessed: true,
        message: '이미 처리된 환불이에요.',
        orderId: order.id,
      }),
    };
  }

  // 요청 row 보장 (없으면 생성, 있으면 approved 전이)
  let workingRequestId = request?.id;
  let priorStatus = request?.status || null;
  let requestedAt = request?.requested_at || new Date().toISOString();

  if (admin) {
    if (!workingRequestId) {
      const { data: created } = await admin
        .from('return_requests')
        .insert({
          seller_id: payload.seller_id,
          order_id: order.id,
          marketplace: order.market,
          request_type: requestType,
          reason: reason || null,
          reason_category: reasonCategory,
          partial_amount: requestType === 'partial_refund' ? amount : null,
          exchange_product_id: exchangeProductId,
          is_high_risk: isHighRisk,
          risk_reason: riskReason,
          status: 'approved',
          approved_at: new Date().toISOString(),
          processed_by: payload.seller_id,
          seller_note: note || null,
        })
        .select('id, requested_at')
        .single();
      workingRequestId = created?.id;
      requestedAt = created?.requested_at || requestedAt;
    } else {
      await admin
        .from('return_requests')
        .update({
          status: 'approved',
          approved_at: new Date().toISOString(),
          processed_by: payload.seller_id,
          seller_note: note || null,
        })
        .eq('id', workingRequestId);
    }
  }

  const auditTrail = [];
  if (admin && workingRequestId) {
    const tr = await recordTransition(admin, {
      request_id: workingRequestId,
      seller_id: payload.seller_id,
      from_status: priorStatus || null,
      to_status: 'approved',
      transition_reason: '셀러 승인',
      actor_type: 'seller',
      actor_id: payload.seller_id,
    });
    auditTrail.push(tr.entry);
  }

  // 자격증명 조회
  let creds = null;
  if (admin) {
    const { data } = await admin
      .from('market_credentials')
      .select('credentials_encrypted, access_token_encrypted, token_expires_at, market_seller_id')
      .eq('seller_id', payload.seller_id)
      .eq('market', order.market)
      .single();
    creds = data || null;
  }

  // throttle
  const throttle = tryAcquire(order.market, creds?.market_seller_id);
  if (!throttle.allowed) {
    return {
      statusCode: 429,
      headers: CORS,
      body: JSON.stringify({ error: '잠시 후 다시 시도해주세요.', retryAfterMs: throttle.retryAfterMs }),
    };
  }

  // processing 전이
  if (admin && workingRequestId) {
    await admin.from('return_requests').update({ status: 'processing' }).eq('id', workingRequestId);
    const tr = await recordTransition(admin, {
      request_id: workingRequestId,
      seller_id: payload.seller_id,
      from_status: 'approved',
      to_status: 'processing',
      transition_reason: '마켓 호출 시작',
      actor_type: 'system',
    });
    auditTrail.push(tr.entry);
  }

  // 마켓 어댑터 호출
  const adapter = ADAPTERS[order.market];
  const startedAt = Date.now();
  const apiResult = await adapter.processReturn({
    market_order_id: order.market_order_id,
    reason,
    type: requestType,
    amount: requestType === 'partial_refund' ? amount : undefined,
    exchange_product_id: exchangeProductId,
    credentials: creds?.credentials_encrypted,
    access_token_encrypted: creds?.access_token_encrypted,
    token_expires_at: creds?.token_expires_at,
    market_seller_id: creds?.market_seller_id,
    mock,
  });
  const durationMs = Date.now() - startedAt;

  if (admin) {
    await recordReturnLog(admin, {
      request_id: workingRequestId,
      seller_id: payload.seller_id,
      marketplace: order.market,
      operation: 'process_return',
      request_payload: { type: requestType, reason, amount, exchange_product_id: exchangeProductId },
      response_status: apiResult.status || (apiResult.ok ? 200 : 500),
      response_body: apiResult.raw || { error: apiResult.error },
      duration_ms: durationMs,
      ok: !!apiResult.ok,
      error_message: apiResult.error || null,
      retryable: !!apiResult.retryable,
    });
  }

  // 재고 복원 (refund/exchange 성공 시 — partial_refund는 재고 변동 없음)
  let stockResult = null;
  if (admin && apiResult.ok && (requestType === 'refund' || requestType === 'exchange') && order.product_id) {
    stockResult = await restoreStockForReturn(admin, {
      id: order.id,
      seller_id: order.seller_id,
      product_id: order.product_id,
      market: order.market,
      quantity: order.quantity,
    });
  }

  // 주문 상태 갱신
  if (admin && apiResult.ok) {
    const update = {
      return_reason: reason || '셀러 처리',
      return_requested_at: order.return_requested_at || new Date().toISOString(),
    };
    if (requestType === 'refund') {
      update.status = 'returned';
      update.return_completed_at = new Date().toISOString();
    } else if (requestType === 'exchange') {
      update.status = 'exchanged';
      update.exchange_completed_at = new Date().toISOString();
      update.exchange_requested_at = order.return_requested_at || new Date().toISOString();
    }
    // partial_refund는 status 변경 안 함 (delivered/paid 그대로)
    if (Object.keys(update).length > 0) {
      await admin.from('marketplace_orders').update(update).eq('id', order.id);
    }
  }

  // 요청 status 최종 전이 + history
  if (admin && workingRequestId) {
    const finalStatus = apiResult.ok ? 'completed' : 'failed';
    const updateRow = { status: finalStatus };
    if (apiResult.ok) {
      updateRow.completed_at = new Date().toISOString();
      updateRow.market_response = apiResult.raw || { mocked: !!apiResult.mocked, refund_id: apiResult.refund_id };
    } else {
      updateRow.market_response = { error: apiResult.error, retryable: apiResult.retryable };
    }
    updateRow.processed_at = new Date().toISOString();

    await admin.from('return_requests').update(updateRow).eq('id', workingRequestId);
    const tr = await recordTransition(admin, {
      request_id: workingRequestId,
      seller_id: payload.seller_id,
      from_status: 'processing',
      to_status: finalStatus,
      transition_reason: apiResult.ok ? '마켓 호출 성공' : '마켓 호출 실패',
      actor_type: 'system',
      metadata: { refund_id: apiResult.refund_id || null, error: apiResult.error || null },
    });
    auditTrail.push(tr.entry);

    await recordHistory(admin, {
      request_id: workingRequestId,
      order_id: order.id,
      seller_id: payload.seller_id,
      marketplace: order.market,
      type: requestType,
      reason,
      status: finalStatus,
      amount: requestType === 'partial_refund' ? amount : (order.total_price || null),
      requested_at: requestedAt,
      processed_by: payload.seller_id,
      notes: note,
      audit_trail: auditTrail,
    });

    await enqueueNotification(admin, {
      request_id: workingRequestId,
      seller_id: payload.seller_id,
      channel: 'buyer_alarm',
      template_key: apiResult.ok ? 'return_completed' : 'return_failed',
      payload: { type: requestType, refund_id: apiResult.refund_id || null },
    });
  }

  // 실패 + retryable 시 retry queue 적재
  if (admin && !apiResult.ok && apiResult.retryable) {
    await retryEngine.enqueue(admin, {
      seller_id: payload.seller_id,
      task_type: 'return_process',
      market: order.market,
      payload: {
        request_id: workingRequestId,
        order_id: order.id,
        market_order_id: order.market_order_id,
        type: requestType,
        reason,
        amount,
        exchange_product_id: exchangeProductId,
      },
      last_error: { message: apiResult.error, status: apiResult.status },
    });
  }

  // Audit Log
  if (admin) {
    await recordAudit(admin, {
      actor_id: payload.seller_id,
      actor_type: 'seller',
      action: 'return_process',
      resource_type: 'return_requests',
      resource_id: workingRequestId || order.id,
      metadata: {
        market: order.market,
        type: requestType,
        reason: reason ? '제공됨' : '미제공',
        api_ok: !!apiResult.ok,
        stock_restored: !!(stockResult && stockResult.ok),
        amount: requestType === 'partial_refund' ? amount : order.total_price,
        is_high_risk: isHighRisk,
      },
      event,
    });
  }

  console.log(`[return-process] seller=${payload.seller_id.slice(0,8)} order=${order.id.slice(0,8)} type=${requestType} api_ok=${apiResult.ok} risk=${isHighRisk}`);

  const friendly = apiResult.ok ? null : translateMarketError(order.market, apiResult.status || 500, apiResult.error);

  return {
    statusCode: apiResult.ok ? 200 : (apiResult.status || 500),
    headers: CORS,
    body: JSON.stringify({
      success: !!apiResult.ok,
      requestId: workingRequestId,
      orderId: order.id,
      type: requestType,
      market: order.market,
      refund_id: apiResult.refund_id || null,
      stock_restored: !!(stockResult && stockResult.ok),
      isHighRisk,
      mocked: !!apiResult.mocked,
      error: friendly,
      retryable: !!apiResult.retryable,
    }),
  };
};
