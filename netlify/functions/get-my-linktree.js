// 본인 링크트리 데이터 조회 (settings 편집 화면용)
// GET /api/my-linktree
// 헤더: Authorization: Bearer <jwt>
// 응답: { success: true, slug, links: [...] }
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { ensureSlugForSeller } = require('./_shared/linktree-slug');

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

  // me.js 와 동일 인증 패턴: Supabase JWT email 매칭 → 실패 시 seller-jwt fallback.
  // (사장님 카카오 OAuth = Supabase user.email 과 sellers.email 이 다를 수 있어 fallback 필수)
  let sellerId = null;
  let supaAuthData = null;
  try {
    const { data } = await admin.auth.getUser(token);
    supaAuthData = data || null;
  } catch (e) {
    console.log('[get-my-linktree] Supabase JWT 검증 예외 — seller-jwt fallback:', e && e.message);
  }
  if (supaAuthData && supaAuthData.user && supaAuthData.user.email) {
    const { data: byEmail } = await admin
      .from('sellers')
      .select('id')
      .eq('email', supaAuthData.user.email)
      .maybeSingle();
    if (byEmail) sellerId = byEmail.id;
  }
  if (!sellerId) {
    const { payload } = verifySellerToken(token);
    if (payload && payload.seller_id) sellerId = payload.seller_id;
  }
  if (!sellerId) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  // slug 자동 부여 (없는 사장님은 첫 호출 시 자동 생성·저장)
  const slug = await ensureSlugForSeller(admin, sellerId);
  if (!slug) {
    console.error('[get-my-linktree] slug 자동 부여 실패');
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
      slug,
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
