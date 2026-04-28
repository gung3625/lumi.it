// live-events.js — Sprint 4 실시간 이벤트 피드 발행
// Supabase Realtime 채널 (live_events 테이블 INSERT) → 셀러 모바일/PC에 push
// 메모리 project_proactive_ux_paradigm.md 시나리오 (선제 제안 패러다임)

const SEVERITY_BY_TYPE = {
  new_order: 'success',
  order_paid: 'success',
  order_shipped: 'info',
  order_delivered: 'info',
  stock_low: 'warning',
  stock_zero: 'critical',
  cs_received: 'info',
  cs_responded: 'success',
  return_requested: 'warning',
  return_completed: 'info',
  kill_switch_activated: 'critical',
  kill_switch_resumed: 'success',
  sync_failed: 'warning',
  sync_recovered: 'success',
  profit_milestone: 'success',
  trend_alert: 'info',
};

const ICON_BY_TYPE = {
  new_order: 'shopping-bag',
  order_paid: 'check-circle',
  order_shipped: 'truck',
  order_delivered: 'package-check',
  stock_low: 'alert-triangle',
  stock_zero: 'alert-octagon',
  cs_received: 'message-circle',
  cs_responded: 'message-square',
  return_requested: 'rotate-ccw',
  return_completed: 'check',
  kill_switch_activated: 'octagon',
  kill_switch_resumed: 'play-circle',
  sync_failed: 'wifi-off',
  sync_recovered: 'wifi',
  profit_milestone: 'trending-up',
  trend_alert: 'flame',
};

const COPY_TEMPLATES = {
  new_order: (m) => ({
    title: '새 주문 도착',
    message: m.product_title ? `${m.market} · ${m.product_title}` : `${m.market} 신규 주문`,
  }),
  order_paid: (m) => ({
    title: '결제 완료',
    message: `${m.market} 주문 ${m.market_order_id} 결제됐어요`,
  }),
  order_shipped: (m) => ({
    title: '송장 입력 완료',
    message: `${m.market} ${m.tracking_number || ''} 발송`,
  }),
  order_delivered: (m) => ({
    title: '배송 완료',
    message: `${m.product_title || '주문'} 고객에게 도착했어요`,
  }),
  stock_low: (m) => ({
    title: '재고 부족',
    message: `${m.product_title || '상품'} 재고 ${m.remaining || 0}개 남았어요`,
  }),
  stock_zero: (m) => ({
    title: '품절',
    message: `${m.product_title || '상품'} 재고가 모두 소진됐어요. 추가 발주를 도와드릴까요?`,
  }),
  cs_received: (m) => ({
    title: '새 문의',
    message: m.preview_text ? `"${m.preview_text.slice(0, 30)}..."` : `${m.market} 신규 문의`,
  }),
  cs_responded: (m) => ({
    title: '답변 전송됨',
    message: `${m.market} 문의에 답변했어요`,
  }),
  return_requested: (m) => ({
    title: '반품 요청',
    message: `${m.product_title || '주문'} 반품 처리가 필요해요`,
  }),
  return_completed: (m) => ({
    title: '반품 처리 완료',
    message: `재고 +${m.quantity || 1} 자동 가산했어요`,
  }),
  kill_switch_activated: (m) => ({
    title: '판매 즉시 중지',
    message: `${m.scope || '전체'} 판매가 멈췄어요`,
  }),
  kill_switch_resumed: (m) => ({
    title: '판매 재개',
    message: `${m.scope || '전체'} 판매가 다시 시작됐어요`,
  }),
  sync_failed: (m) => ({
    title: '동기화 실패',
    message: `${m.market} 연결이 잠시 불안정해요. 잠시 후 자동 재시도해요`,
  }),
  sync_recovered: (m) => ({
    title: '동기화 복구',
    message: `${m.market} 연결이 정상으로 돌아왔어요`,
  }),
  profit_milestone: (m) => ({
    title: '수익 이정표',
    message: `이번 ${m.period || '주'} 통장에 ₩${(m.amount || 0).toLocaleString('ko-KR')} 들어왔어요`,
  }),
  trend_alert: (m) => ({
    title: '트렌드 알림',
    message: `${m.keyword || '키워드'} +${m.velocity_pct || 0}% 급상승`,
  }),
};

/**
 * Live Event 발행 (Supabase에 INSERT)
 * @param {Object} admin — Supabase admin client
 * @param {string} sellerId
 * @param {string} eventType
 * @param {Object} metadata — 이벤트 컨텍스트
 * @param {Object} opts — { referenceType, referenceId, market }
 */
async function publishEvent(admin, sellerId, eventType, metadata = {}, opts = {}) {
  if (!admin || !sellerId || !eventType) {
    return { ok: false, error: 'admin/sellerId/eventType required' };
  }

  const tmpl = COPY_TEMPLATES[eventType];
  if (!tmpl) {
    return { ok: false, error: `Unknown event_type: ${eventType}` };
  }

  const copy = tmpl(metadata || {});
  const severity = SEVERITY_BY_TYPE[eventType] || 'info';
  const icon = ICON_BY_TYPE[eventType] || 'bell';

  const row = {
    seller_id: sellerId,
    event_type: eventType,
    title: copy.title,
    message: copy.message,
    icon,
    severity,
    reference_type: opts.referenceType || null,
    reference_id: opts.referenceId || null,
    market: opts.market || metadata.market || null,
    metadata: metadata || {},
  };

  try {
    const { data, error } = await admin
      .from('live_events')
      .insert(row)
      .select()
      .single();
    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true, event: data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Bulk publish — 여러 이벤트 한 번에 발행 (cron·일괄 작업용)
 */
async function publishBulkEvents(admin, sellerId, events) {
  if (!admin || !sellerId || !Array.isArray(events) || events.length === 0) {
    return { ok: false, error: 'admin/sellerId/events required' };
  }

  const rows = events.map(ev => {
    const tmpl = COPY_TEMPLATES[ev.event_type];
    const copy = tmpl ? tmpl(ev.metadata || {}) : { title: ev.event_type, message: '' };
    return {
      seller_id: sellerId,
      event_type: ev.event_type,
      title: ev.title || copy.title,
      message: ev.message || copy.message,
      icon: ICON_BY_TYPE[ev.event_type] || 'bell',
      severity: SEVERITY_BY_TYPE[ev.event_type] || 'info',
      reference_type: ev.reference_type || null,
      reference_id: ev.reference_id || null,
      market: ev.market || (ev.metadata && ev.metadata.market) || null,
      metadata: ev.metadata || {},
    };
  });

  try {
    const { data, error } = await admin.from('live_events').insert(rows).select();
    if (error) return { ok: false, error: error.message };
    return { ok: true, events: data, count: data.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 최근 N개 이벤트 조회 (대시보드 Live Stream Feed용)
 */
async function fetchRecentEvents(admin, sellerId, opts = {}) {
  const limit = opts.limit || 20;
  const onlyUnread = opts.onlyUnread === true;

  try {
    let q = admin
      .from('live_events')
      .select('*')
      .eq('seller_id', sellerId)
      .eq('archived', false)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (onlyUnread) q = q.is('read_at', null);

    const { data, error } = await q;
    if (error) return { ok: false, error: error.message, events: [] };
    return { ok: true, events: data || [] };
  } catch (e) {
    return { ok: false, error: e.message, events: [] };
  }
}

/**
 * 이벤트 읽음 처리
 */
async function markEventsRead(admin, sellerId, eventIds) {
  if (!Array.isArray(eventIds) || eventIds.length === 0) {
    return { ok: false, error: 'eventIds required' };
  }
  try {
    const { error } = await admin
      .from('live_events')
      .update({ read_at: new Date().toISOString() })
      .eq('seller_id', sellerId)
      .in('id', eventIds);
    if (error) return { ok: false, error: error.message };
    return { ok: true, updated: eventIds.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  publishEvent,
  publishBulkEvents,
  fetchRecentEvents,
  markEventsRead,
  SEVERITY_BY_TYPE,
  ICON_BY_TYPE,
};
