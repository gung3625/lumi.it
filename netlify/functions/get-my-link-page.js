const { corsHeaders, getOrigin } = require('./_shared/auth');
// get-my-link-page — GET, Bearer 인증
// 현재 로그인 사용자의 링크인바이오 페이지 + 블록 반환.
// 대시보드 카드 미리보기에 사용.
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');


exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    return { statusCode: 401, headers: headers, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  try {
    const admin = getAdminClient();
    const { data: pageRow, error: pageErr } = await admin
      .from('link_pages')
      .select('slug, theme, profile_image_url, store_name, headline, bio, updated_at')
      .eq('user_id', user.id)
      .maybeSingle();
    if (pageErr) {
      console.error('[get-my-link-page] page select error:', pageErr.message);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '조회 실패' }) };
    }
    if (!pageRow) {
      return { statusCode: 200, headers: headers, body: JSON.stringify({ page: null, blocks: [] }) };
    }

    const { data: blocks, error: blockErr } = await admin
      .from('link_blocks')
      .select('block_type, position, data')
      .eq('page_id', user.id)
      .order('position', { ascending: true });
    if (blockErr) {
      console.error('[get-my-link-page] blocks select error:', blockErr.message);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '조회 실패' }) };
    }

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ page: pageRow, blocks: blocks || [] }),
    };
  } catch (err) {
    console.error('[get-my-link-page] unexpected:', err && err.message);
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
