// 배송 추적 — Sprint 3
// POST /api/track-shipment
// Body: { order_id }  또는 { courier_code, tracking_number }
//
// 동작: 스마트택배 또는 모킹 호출 → tracking_events insert + orders.tracking_status 갱신

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { trackShipment } = require('./_shared/shipment-tracker');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const cronSecret = (event.headers['x-lumi-secret'] || event.headers['X-Lumi-Secret'] || '').trim();
  let sellerId = null;
  if (cronSecret && cronSecret === (process.env.CRON_SECRET || '')) {
    // cron 모드 (모든 셀러)
  } else {
    const { payload, error } = verifySellerToken(token);
    if (error || !payload) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요해요.' }) };
    }
    sellerId = payload.seller_id;
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

  let admin = null;
  try { admin = getAdminClient(); } catch { /* */ }

  // 시나리오 1 — order_id 지정
  if (body.order_id) {
    if (!sellerId) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'cron에서 order_id 모드는 미지원이에요.' }) };
    }
    if (!admin) {
      const result = await trackShipment({ courier_code: 'CJGLS', tracking_number: '1234567890', mock: true });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: result.ok, ...result, order_id: body.order_id, mocked: true }) };
    }
    const { data: order } = await admin
      .from('marketplace_orders')
      .select('id, seller_id, courier_code, tracking_number, status')
      .eq('id', body.order_id)
      .eq('seller_id', sellerId)
      .single();
    if (!order) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '주문을 찾을 수 없어요.' }) };
    }
    if (!order.tracking_number || !order.courier_code) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '송장이 입력되지 않았어요.' }) };
    }
    const result = await trackShipment({ courier_code: order.courier_code, tracking_number: order.tracking_number });
    if (result.ok && result.events.length > 0) {
      // 기존 events 지우고 새로 (멱등)
      await admin.from('tracking_events').delete().eq('order_id', order.id);
      const rows = result.events.map((e) => ({
        order_id: order.id,
        seller_id: sellerId,
        status: e.status,
        description: e.description,
        location: e.location,
        occurred_at: e.occurred_at,
        source: e.source,
        raw: e.raw || null,
      }));
      await admin.from('tracking_events').insert(rows);

      // orders 갱신
      const update = {
        tracking_status: result.current_status,
        tracking_last_synced_at: new Date().toISOString(),
      };
      if (result.current_status === 'delivered' && order.status !== 'delivered') {
        update.status = 'delivered';
        update.delivered_at = new Date().toISOString();
      } else if (order.status === 'paid') {
        update.status = 'shipping';
      }
      await admin.from('marketplace_orders').update(update).eq('id', order.id);
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: result.ok, ...result, order_id: order.id }) };
  }

  // 시나리오 2 — 직접 송장 조회 (셀러 디버깅)
  if (body.courier_code && body.tracking_number) {
    const result = await trackShipment({ courier_code: body.courier_code, tracking_number: body.tracking_number });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: result.ok, ...result }) };
  }

  // 시나리오 3 — cron 일괄 (모든 진행중 주문)
  if (!sellerId && admin) {
    const { data: orders } = await admin
      .from('marketplace_orders')
      .select('id, seller_id, courier_code, tracking_number, status')
      .eq('status', 'shipping')
      .not('tracking_number', 'is', null)
      .limit(500);
    let synced = 0;
    let delivered = 0;
    for (const order of orders || []) {
      const result = await trackShipment({ courier_code: order.courier_code, tracking_number: order.tracking_number });
      if (result.ok) {
        synced += 1;
        if (result.current_status === 'delivered' && order.status !== 'delivered') {
          delivered += 1;
          await admin.from('marketplace_orders').update({
            status: 'delivered',
            delivered_at: new Date().toISOString(),
            tracking_status: 'delivered',
            tracking_last_synced_at: new Date().toISOString(),
          }).eq('id', order.id);
        } else {
          await admin.from('marketplace_orders').update({
            tracking_status: result.current_status,
            tracking_last_synced_at: new Date().toISOString(),
          }).eq('id', order.id);
        }
      }
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, synced, delivered, total: (orders || []).length }) };
  }

  return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'order_id 또는 courier_code+tracking_number를 보내주세요.' }) };
};
