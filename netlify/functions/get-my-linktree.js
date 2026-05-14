// 본인 링크트리 데이터 조회 (settings 편집 화면용)
// GET /api/my-linktree
// 헤더: Authorization: Bearer <jwt>
// 응답: { success: true, slug, links: [...] }
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  if (!token) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[get-my-linktree] Supabase 클라이언트 초기화 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류입니다.' }) };
  }

  // me.js 와 동일 인증 패턴: Supabase JWT 우선 → seller-jwt fallback
  let sellerId = null;
  let supaAuthData = null;
  try {
    const { data } = await admin.auth.getUser(token);
    supaAuthData = data || null;
  } catch (e) {
    console.log('[get-my-linktree] Supabase JWT 검증 예외 — seller-jwt fallback:', e && e.message);
  }
  if (supaAuthData && supaAuthData.user && supaAuthData.user.email) {
    const { data: byEmail, error } = await admin
      .from('sellers')
      .select('id')
      .eq('email', supaAuthData.user.email)
      .maybeSingle();
    if (error || !byEmail) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '셀러 정보를 찾을 수 없습니다.' }) };
    }
    sellerId = byEmail.id;
  } else {
    const { payload, error: authErr } = verifySellerToken(token);
    if (authErr || !payload) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
    }
    sellerId = payload.seller_id;
  }

  const { data: seller, error: selErr } = await admin
    .from('sellers')
    .select('linktree_slug')
    .eq('id', sellerId)
    .maybeSingle();

  if (selErr) {
    console.error('[get-my-linktree] sellers select 오류:', selErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류입니다.' }) };
  }

  const { data: links, error: linkErr } = await admin
    .from('seller_links')
    .select('id, label, url, link_type, sort_order')
    .eq('seller_id', sellerId)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (linkErr) {
    console.error('[get-my-linktree] seller_links select 오류:', linkErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류입니다.' }) };
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      slug: (seller && seller.linktree_slug) || null,
      links: (links || []).map((l) => ({
        id: l.id,
        label: l.label,
        url: l.url,
        type: l.link_type,
        sortOrder: l.sort_order,
      })),
    }),
  };
};
