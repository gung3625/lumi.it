// dismiss-trend.js Function — Sprint 4 트렌드 카드 거절 학습
// POST /api/dismiss-trend { keyword, category, reason }
// 메모리 project_proactive_ux_paradigm.md 6번 원칙 (학습형 — 거절 패턴 기억)

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const VALID_REASONS = ['not_interested', 'wrong_category', 'price_unsuitable', 'season_off', 'other'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error: jwtErr } = verifySellerToken(token);
  if (jwtErr) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: jwtErr }) };
  }
  const sellerId = payload.seller_id;

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (_) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '요청 형식 오류' }) };
  }

  const keyword = (body.keyword || '').trim();
  const category = (body.category || '').trim();
  const reason = VALID_REASONS.includes(body.reason) ? body.reason : 'other';

  if (!keyword) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'keyword 필요' }) };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase 초기화 실패' }) };
  }

  try {
    // 거절 기록
    await admin.from('trend_dismissals').insert({
      seller_id: sellerId,
      trend_keyword: keyword,
      trend_category: category || null,
      dismissal_reason: reason,
    });

    // seller_trend_matches에서도 dismissed_at 갱신
    try {
      await admin
        .from('seller_trend_matches')
        .update({ dismissed_at: new Date().toISOString() })
        .eq('seller_id', sellerId)
        .eq('trend_keyword', keyword)
        .is('dismissed_at', null);
    } catch (_) {}

    // 누적 거절 횟수 확인
    let totalCount = 1;
    try {
      const { count } = await admin
        .from('trend_dismissals')
        .select('id', { count: 'exact', head: true })
        .eq('seller_id', sellerId)
        .eq('trend_keyword', keyword);
      totalCount = count || 1;
    } catch (_) {}

    const message = totalCount >= 3
      ? '앞으로 이 키워드는 추천하지 않을게요.'
      : '알겠어요. 다른 키워드를 보여드릴게요.';

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        message,
        dismissed_count: totalCount,
        muted: totalCount >= 3,
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
