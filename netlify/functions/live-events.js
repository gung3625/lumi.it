// live-events.js Function — Sprint 4 실시간 이벤트 피드
// GET /api/live-events  — 최근 N개 이벤트 (대시보드 Live Stream Feed용)
// POST /api/live-events { eventIds: [...] } — 읽음 처리 (action=read)
// POST /api/live-events { event_type, metadata } — 수동 발행 (테스트·관리자)
//
// Realtime 푸시는 Supabase Realtime channel ('live_events' 테이블 INSERT 구독)
// 클라이언트 측 sprint4-live.js가 channel.subscribe('postgres_changes', ...)로 받음

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { fetchRecentEvents, markEventsRead, publishEvent } = require('./_shared/live-events');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const token = extractBearerToken(event);
  const { payload, error: jwtErr } = verifySellerToken(token);
  if (jwtErr) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: jwtErr }) };
  }
  const sellerId = payload.seller_id;

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase 초기화 실패' }) };
  }

  // GET — 이벤트 피드 조회
  if (event.httpMethod === 'GET') {
    const params = new URLSearchParams(event.rawQuery || '');
    const limit = Math.min(50, Math.max(1, parseInt(params.get('limit') || '20', 10)));
    const onlyUnread = params.get('unread') === 'true';

    const result = await fetchRecentEvents(admin, sellerId, { limit, onlyUnread });

    if (!result.ok) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: result.error }) };
    }

    // 친절한 헤더 메시지
    const unreadCount = result.events.filter(e => !e.read_at).length;
    const headline = unreadCount === 0
      ? '새 알림이 없어요'
      : unreadCount === 1
      ? '새 알림 1건이 도착했어요'
      : `새 알림 ${unreadCount}건이 도착했어요`;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        headline,
        events: result.events,
        unread_count: unreadCount,
        updatedAt: new Date().toISOString(),
      }),
    };
  }

  // POST — 읽음 처리 또는 수동 발행
  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (_) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '요청 형식 오류' }) };
    }

    if (body.action === 'read') {
      if (!Array.isArray(body.eventIds) || body.eventIds.length === 0) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'eventIds 필요' }) };
      }
      const r = await markEventsRead(admin, sellerId, body.eventIds);
      if (!r.ok) {
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: r.error }) };
      }
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ ok: true, updated: r.updated, message: '읽음 처리됐어요' }),
      };
    }

    if (body.action === 'publish' && body.event_type) {
      const r = await publishEvent(
        admin,
        sellerId,
        body.event_type,
        body.metadata || {},
        body.opts || {}
      );
      if (!r.ok) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: r.error }) };
      }
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, event: r.event }) };
    }

    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: 'action(read|publish)을 지정해주세요' }),
    };
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
