// command-history.js — 좌측 사이드바 명령 히스토리 조회·핀
//
// GET /api/command-history          → 그룹별 (오늘/어제/7일/30일)
// PATCH /api/command-history?id=X   → { is_pinned: true/false }
// DELETE /api/command-history?id=X  → 삭제

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

function bucketByDate(rows) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const day7 = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const day30 = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

  const buckets = { pinned: [], today: [], yesterday: [], last7: [], last30: [], older: [] };
  for (const r of rows) {
    if (r.is_pinned) {
      buckets.pinned.push(r);
      continue;
    }
    const created = new Date(r.created_at);
    const dateStr = created.toISOString().slice(0, 10);
    if (dateStr === todayStr) buckets.today.push(r);
    else if (dateStr === yesterday) buckets.yesterday.push(r);
    else if (created >= day7) buckets.last7.push(r);
    else if (created >= day30) buckets.last30.push(r);
    else buckets.older.push(r);
  }
  return buckets;
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), {
    'Access-Control-Allow-Methods': 'GET, PATCH, DELETE, OPTIONS',
  });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const token = extractBearerToken(event);
  const { payload: jwt, error: jwtErr } = verifySellerToken(token);
  if (jwtErr) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요해요' }) };
  }
  const sellerId = jwt.seller_id;

  let admin;
  try { admin = getAdminClient(); } catch (_) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'DB 초기화 실패' }) };
  }

  // GET — 목록
  if (event.httpMethod === 'GET') {
    try {
      // pinned 먼저 + 최근 50건
      const { data, error } = await admin
        .from('command_history')
        .select('id, input, intent, ability_level, cost_tier, summary, status, blocked_reason, is_pinned, result_payload, created_at')
        .eq('seller_id', sellerId)
        .neq('status', 'blocked')   // 차단 명령은 사이드바에 안 보임
        .order('created_at', { ascending: false })
        .limit(80);

      if (error) throw error;
      const buckets = bucketByDate(data || []);
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ ok: true, buckets, total: (data || []).length }),
      };
    } catch (e) {
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: '히스토리를 불러오지 못했어요' }),
      };
    }
  }

  // PATCH — 핀 토글
  if (event.httpMethod === 'PATCH') {
    const id = (event.queryStringParameters || {}).id;
    if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id 필요' }) };

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청' }) };
    }
    const isPinned = !!body.is_pinned;
    try {
      const { error } = await admin
        .from('command_history')
        .update({ is_pinned: isPinned })
        .eq('id', id)
        .eq('seller_id', sellerId);
      if (error) throw error;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    } catch (e) {
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: '핀 변경 실패' }),
      };
    }
  }

  // DELETE
  if (event.httpMethod === 'DELETE') {
    const id = (event.queryStringParameters || {}).id;
    if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id 필요' }) };
    try {
      const { error } = await admin
        .from('command_history')
        .delete()
        .eq('id', id)
        .eq('seller_id', sellerId);
      if (error) throw error;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    } catch (e) {
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: '삭제 실패' }),
      };
    }
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
