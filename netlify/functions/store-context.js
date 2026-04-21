// 매장 컨텍스트 조회/저장 — Bearer 토큰 인증 필수
// GET: 해당 user_id의 store_context row 반환 (없으면 빈 객체)
// POST: 허용 필드 upsert (updated_at 자동 갱신)
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const ALLOWED_FIELDS = [
  'store_name',
  'address',
  'phone',
  'hours',
  'menu_or_services',
  'parking',
  'reservation_url',
  'directions',
  'tone',
  'custom_notes',
];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  const admin = getAdminClient();

  try {
    if (event.httpMethod === 'GET') {
      const { data, error } = await admin
        .from('store_context')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) {
        console.error('[store-context] select 오류:', error.message);
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '조회 실패' }) };
      }

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ success: true, context: data || {} }),
      };
    }

    // POST: upsert
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
    }

    const update = { updated_at: new Date().toISOString() };
    for (const field of ALLOWED_FIELDS) {
      if (body[field] !== undefined) update[field] = body[field];
    }

    const { data: upserted, error: upsertErr } = await admin
      .from('store_context')
      .upsert({ user_id: user.id, ...update }, { onConflict: 'user_id' })
      .select()
      .single();

    if (upsertErr) {
      console.error('[store-context] upsert 오류:', upsertErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '저장 실패' }) };
    }

    console.log(`[store-context] upsert 완료 user=${user.id}`);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, context: upserted }),
    };
  } catch (err) {
    console.error('[store-context] 예외:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message || '서버 오류' }) };
  }
};
