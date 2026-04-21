// get-link-page — GET, 익명 허용
// query: slug=<string>
// 응답: { page: {...}, blocks: [...] } (position 오름차순)
const { getAdminClient } = require('./_shared/supabase-admin');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const slug = String((event.queryStringParameters || {}).slug || '').toLowerCase().trim();
  if (!slug) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'slug가 필요합니다.' }) };
  }

  try {
    const admin = getAdminClient();
    const { data: pageRow, error: pageErr } = await admin
      .from('link_pages')
      .select('user_id, slug, theme, profile_image_url, store_name, headline, bio, updated_at')
      .eq('slug', slug)
      .maybeSingle();
    if (pageErr) {
      console.error('[get-link-page] page select error:', pageErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '조회 실패' }) };
    }
    if (!pageRow) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '페이지를 찾을 수 없어요.' }) };
    }

    const { data: blocks, error: blockErr } = await admin
      .from('link_blocks')
      .select('id, block_type, position, data')
      .eq('page_id', pageRow.user_id)
      .order('position', { ascending: true });
    if (blockErr) {
      console.error('[get-link-page] blocks select error:', blockErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '조회 실패' }) };
    }

    // user_id는 응답에서 제거 (public endpoint)
    const safePage = {
      slug: pageRow.slug,
      theme: pageRow.theme,
      profile_image_url: pageRow.profile_image_url,
      store_name: pageRow.store_name,
      headline: pageRow.headline,
      bio: pageRow.bio,
      updated_at: pageRow.updated_at,
    };

    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'public, max-age=30' },
      body: JSON.stringify({ page: safePage, blocks: blocks || [] }),
    };
  } catch (err) {
    console.error('[get-link-page] unexpected:', err && err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
