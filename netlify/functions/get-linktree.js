// 공개 링크트리 페이지 데이터
// GET /api/linktree?slug=<slug>
// 인증 없음. slug 로 sellers 조회 + 활성 seller_links + ig_accounts username 응답.
const { getAdminClient } = require('./_shared/supabase-admin');

const SLUG_RE = /^[a-z0-9-]{3,30}$/;

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=60',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const slug = String((event.queryStringParameters && event.queryStringParameters.slug) || '').trim().toLowerCase();
  if (!slug || !SLUG_RE.test(slug)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 slug 입니다.' }) };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[get-linktree] Supabase 클라이언트 초기화 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류입니다.' }) };
  }

  const { data: seller, error: selErr } = await admin
    .from('sellers')
    .select('id, store_name, store_desc, avatar_url, industry, region')
    .eq('linktree_slug', slug)
    .maybeSingle();

  if (selErr) {
    console.error('[get-linktree] sellers select 오류:', selErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류입니다.' }) };
  }
  if (!seller) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '페이지를 찾을 수 없습니다.' }) };
  }

  const { data: links, error: linkErr } = await admin
    .from('seller_links')
    .select('id, label, url, link_type, sort_order')
    .eq('seller_id', seller.id)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (linkErr) {
    console.error('[get-linktree] seller_links select 오류:', linkErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류입니다.' }) };
  }

  const { data: igAcc } = await admin
    .from('ig_accounts')
    .select('ig_username, threads_username')
    .eq('user_id', seller.id)
    .maybeSingle();

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      profile: {
        storeName: seller.store_name || '',
        storeDesc: seller.store_desc || '',
        avatarUrl: seller.avatar_url || null,
        industry: seller.industry || null,
        region: seller.region || null,
        igUsername: (igAcc && igAcc.ig_username) || null,
        threadsUsername: (igAcc && igAcc.threads_username) || null,
      },
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
