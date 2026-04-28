// sync-status.js Function — Sprint 4 마켓 동기화 헬스 카드
// GET /api/sync-status — 셀러의 모든 마켓 sync 헬스
// POST /api/sync-status { action: 'reset_24h' } — 카운터 리셋 (cron)

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { fetchSyncStatus, buildHealthMessage, resetDaily24hCounters } = require('./_shared/sync-status');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Lumi-Secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const MARKET_LABELS = { coupang: '쿠팡', naver: '네이버', toss: '토스쇼핑' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase 초기화 실패' }) };
  }

  // POST — cron 24h 리셋
  if (event.httpMethod === 'POST') {
    const cronSecret = (event.headers['x-lumi-secret'] || event.headers['X-Lumi-Secret'] || '').trim();
    if (process.env.CRON_SECRET && cronSecret === process.env.CRON_SECRET) {
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch (_) { body = {}; }
      if (body.action === 'reset_24h') {
        const r = await resetDaily24hCounters(admin);
        return { statusCode: 200, headers: CORS, body: JSON.stringify(r) };
      }
    }
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'cron secret 필요' }) };
  }

  // GET — 셀러 sync 헬스
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error: jwtErr } = verifySellerToken(token);
  if (jwtErr) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: jwtErr }) };
  }
  const sellerId = payload.seller_id;

  const r = await fetchSyncStatus(admin, sellerId);
  if (!r.ok) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: r.error || 'sync 조회 실패' }) };
  }

  // 셀러 marketplace_credentials 조회 (등록된 마켓만 표시)
  let registeredMarkets = new Set();
  try {
    const { data: creds } = await admin
      .from('market_credentials')
      .select('market')
      .eq('seller_id', sellerId);
    for (const c of creds || []) registeredMarkets.add(c.market);
  } catch (_) {}

  // 각 마켓별 health 카드 빌드 (DB row 있으면 row, 없으면 unknown)
  const cards = [];
  const allMarkets = registeredMarkets.size > 0
    ? Array.from(registeredMarkets)
    : Array.from(new Set([...r.statuses.map(s => s.market), 'coupang', 'naver']));

  for (const market of allMarkets) {
    const status = r.statuses.find(s => s.market === market) || {
      market,
      health_status: 'unknown',
      last_synced_at: null,
      consecutive_failures: 0,
      orders_synced_24h: 0,
      cs_synced_24h: 0,
    };
    const msg = buildHealthMessage(status);
    cards.push({
      market,
      market_label: MARKET_LABELS[market] || market,
      health_status: status.health_status,
      last_synced_at: status.last_synced_at,
      consecutive_failures: status.consecutive_failures || 0,
      orders_synced_24h: status.orders_synced_24h || 0,
      cs_synced_24h: status.cs_synced_24h || 0,
      tone: msg.tone,
      message: msg.text,
      last_error: status.last_error_message || null,
      registered: registeredMarkets.has(market),
    });
  }

  // 전체 헬스 요약
  const failingCount = cards.filter(c => c.health_status === 'failing').length;
  const degradedCount = cards.filter(c => c.health_status === 'degraded').length;
  let headline = '모든 마켓 정상 운영 중';
  let overallTone = 'ok';
  if (failingCount > 0) {
    headline = `${failingCount}개 마켓 연결 점검이 필요해요`;
    overallTone = 'error';
  } else if (degradedCount > 0) {
    headline = `${degradedCount}개 마켓 일시 불안정 — 자동 재시도 중`;
    overallTone = 'warn';
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      headline,
      overall_tone: overallTone,
      cards,
      updatedAt: new Date().toISOString(),
    }),
  };
};
