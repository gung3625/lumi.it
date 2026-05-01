// 매핑 삭제 — DELETE /api/delete-mapping
// Body: { id: string }
// 본인 매핑만 삭제 (seller_id 검증)
// 인증: verifySellerToken

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'DELETE, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'DELETE') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error } = verifySellerToken(token);
  if (error || !payload) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요해요.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '요청 형식이 잘못됐어요.' }) };
  }

  const { id } = body;
  if (!id || typeof id !== 'string') {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '삭제할 매핑 id가 필요해요.' }) };
  }

  let admin;
  try { admin = getAdminClient(); } catch {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
  }

  try {
    // seller_id 조건으로 본인 소유 검증 + 삭제 동시 수행
    const { data, error: delErr } = await admin
      .from('order_mappings')
      .delete()
      .eq('id', id)
      .eq('seller_id', payload.seller_id)
      .select('id')
      .single();

    if (delErr || !data) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '매핑을 찾을 수 없거나 권한이 없어요.' }) };
    }

    console.log(`[delete-mapping] seller=${payload.seller_id.slice(0, 8)} deleted id=${id.slice(0, 8)}`);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, deleted_id: data.id }) };
  } catch (err) {
    console.error('[delete-mapping] unexpected error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류예요.' }) };
  }
};
