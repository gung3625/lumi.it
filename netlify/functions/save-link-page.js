// save-link-page — POST, Bearer 인증
// body: { page: { slug, theme, profile_image_url, store_name, headline, bio }, blocks: [{block_type, position, data}] }
// 동작: link_pages upsert → 기존 blocks 전체 삭제 → 새 blocks 재삽입
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const ALLOWED_BLOCK_TYPES = new Set([
  'header','social','link','hours','map','menu','notice','kakao','phone','delivery'
]);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$|^[a-z0-9]{2,32}$/;

function ok(data) {
  return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
}
function bad(msg, code = 400) {
  return { statusCode: code, headers: CORS, body: JSON.stringify({ error: msg }) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return bad('Method Not Allowed', 405);

  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) return bad('인증이 필요합니다.', 401);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return bad('Bad JSON'); }

  const page = body.page || {};
  const blocks = Array.isArray(body.blocks) ? body.blocks : [];

  // slug 검증
  const slug = String(page.slug || '').toLowerCase().trim();
  if (!SLUG_RE.test(slug)) {
    return bad('URL 주소는 영문 소문자·숫자·하이픈 2~32자만 가능합니다.');
  }

  const theme = page.theme === 'dark' ? 'dark' : 'light';
  const storeName = typeof page.store_name === 'string' ? page.store_name.slice(0, 80) : '';
  const headline = typeof page.headline === 'string' ? page.headline.slice(0, 120) : '';
  const bio = typeof page.bio === 'string' ? page.bio.slice(0, 500) : '';
  const profileUrl = typeof page.profile_image_url === 'string' ? page.profile_image_url.slice(0, 500) : null;

  try {
    const admin = getAdminClient();

    // 1) slug 중복 확인 (다른 사용자가 이미 쓰는지)
    const { data: dup, error: dupErr } = await admin
      .from('link_pages')
      .select('user_id')
      .eq('slug', slug)
      .neq('user_id', user.id)
      .maybeSingle();
    if (dupErr) {
      console.error('[save-link-page] slug dup check error:', dupErr.message);
      return bad('저장 실패', 500);
    }
    if (dup) return bad('이미 사용 중인 URL이에요. 다른 이름을 써주세요.', 409);

    // 2) link_pages upsert
    const pageRow = {
      user_id: user.id,
      slug,
      theme,
      profile_image_url: profileUrl,
      store_name: storeName,
      headline,
      bio,
    };
    const { error: upErr } = await admin
      .from('link_pages')
      .upsert(pageRow, { onConflict: 'user_id' });
    if (upErr) {
      console.error('[save-link-page] upsert error:', upErr.message);
      return bad('저장 실패', 500);
    }

    // 3) 기존 blocks 전체 삭제 후 재삽입 (간단한 전체 교체 전략)
    const { error: delErr } = await admin
      .from('link_blocks')
      .delete()
      .eq('page_id', user.id);
    if (delErr) {
      console.error('[save-link-page] delete blocks error:', delErr.message);
      return bad('저장 실패', 500);
    }

    if (blocks.length > 0) {
      const rows = [];
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i] || {};
        const type = String(b.block_type || '').toLowerCase();
        if (!ALLOWED_BLOCK_TYPES.has(type)) continue;
        const pos = Number.isFinite(b.position) ? Math.floor(b.position) : i;
        const data = (b.data && typeof b.data === 'object' && !Array.isArray(b.data)) ? b.data : {};
        rows.push({
          page_id: user.id,
          block_type: type,
          position: pos,
          data,
        });
      }
      if (rows.length > 50) {
        return bad('블록은 최대 50개까지 추가할 수 있어요.', 400);
      }
      if (rows.length > 0) {
        const { error: insErr } = await admin.from('link_blocks').insert(rows);
        if (insErr) {
          console.error('[save-link-page] insert blocks error:', insErr.message);
          return bad('저장 실패', 500);
        }
      }
    }

    return ok({ success: true, slug });
  } catch (err) {
    console.error('[save-link-page] unexpected:', err && err.message);
    return bad('서버 오류', 500);
  }
};
