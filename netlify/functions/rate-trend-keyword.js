// rate-trend-keyword.js — 트렌드 키워드 👍/👎 피드백 저장
// POST /api/rate-trend-keyword
// Body: { keyword, category, rating: 1 | -1 }
// Header: Authorization Bearer <Supabase access_token>

const { getAdminClient } = require('./_shared/supabase-admin');
const { corsHeaders, getOrigin } = require('./_shared/auth');

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST 전용' }) };
  }

  try {
    // Supabase JWT에서 user_id 추출
    const auth = (event.headers.authorization || '').replace('Bearer ', '');
    if (!auth) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 필요' }) };
    }

    const supa = getAdminClient();
    const { data: userData, error: userErr } = await supa.auth.getUser(auth);
    if (userErr || !userData?.user?.id) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: '유효하지 않은 세션' }) };
    }

    const userId = userData.user.id;
    const body = JSON.parse(event.body || '{}');
    const keyword = (body.keyword || '').trim();
    const category = (body.category || '').trim();
    const rating = parseInt(body.rating, 10);

    if (!keyword || !category) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'keyword·category 필수' }) };
    }
    if (rating !== 1 && rating !== -1) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'rating은 1 또는 -1' }) };
    }

    // upsert (한 사용자는 키워드당 1표)
    const { error } = await supa
      .from('user_trend_feedback')
      .upsert(
        { user_id: userId, keyword, category, rating, rated_at: new Date().toISOString() },
        { onConflict: 'user_id,keyword,category' }
      );

    if (error) {
      console.error('[rate-trend-keyword] upsert 실패:', error.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: '저장 실패' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  } catch(e) {
    console.error('[rate-trend-keyword] exception:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
