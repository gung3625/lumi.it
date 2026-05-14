// 본인 링크트리 저장 — slug + links 한꺼번에 덮어쓰기
// POST /api/save-linktree
// 헤더: Authorization: Bearer <jwt>
// body: { slug?: 'cafedaily', links: [{ label, url, type, sortOrder }, ...] }
// 응답: { success: true, slug, links }
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const SLUG_RE = /^[a-z0-9-]{3,30}$/;
const RESERVED_SLUGS = new Set([
  'admin', 'api', 'dashboard', 'settings', 'terms', 'privacy', 'refund',
  'support', 'history', 'trends', 'insights', 'comments', 'signup', 'login',
  'r', 'register', 'register-product', 'me', 'help', 'static', 'assets',
  'css', 'js', 'data-deletion-status', 'linktree',
]);
const VALID_LINK_TYPES = new Set([
  'menu', 'reservation', 'delivery', 'map', 'phone', 'kakao', 'website', 'custom',
]);
const URL_PREFIX_RE = /^(https?:\/\/|tel:|mailto:|kakaotalk:)/i;
const MAX_LINKS = 20;

function validateSlug(slug) {
  if (!slug) return null;
  const s = String(slug).trim().toLowerCase();
  if (!SLUG_RE.test(s)) return { error: 'slug 는 영문 소문자·숫자·하이픈 3~30자만 사용 가능합니다.' };
  if (RESERVED_SLUGS.has(s)) return { error: '이미 예약된 slug 입니다. 다른 이름을 사용해주세요.' };
  return { value: s };
}

function validateLinks(links) {
  if (!Array.isArray(links)) return { error: 'links 는 배열이어야 합니다.' };
  if (links.length > MAX_LINKS) return { error: `링크는 최대 ${MAX_LINKS}개까지 추가할 수 있습니다.` };

  const cleaned = [];
  for (let i = 0; i < links.length; i += 1) {
    const raw = links[i] || {};
    const label = String(raw.label || '').trim();
    const url = String(raw.url || '').trim();
    const type = String(raw.type || raw.link_type || 'custom').trim();
    const sortOrder = Number.isFinite(Number(raw.sortOrder ?? raw.sort_order)) ? Number(raw.sortOrder ?? raw.sort_order) : i;

    if (!label || label.length > 60) return { error: `${i + 1}번째 링크의 이름은 1~60자여야 합니다.` };
    if (!url || url.length > 2000) return { error: `${i + 1}번째 링크의 URL 이 비어있거나 너무 깁니다.` };
    if (!URL_PREFIX_RE.test(url)) return { error: `${i + 1}번째 링크의 URL 은 https:// · http:// · tel: · mailto: · kakaotalk: 로 시작해야 합니다.` };
    if (!VALID_LINK_TYPES.has(type)) return { error: `${i + 1}번째 링크의 유형이 올바르지 않습니다.` };

    cleaned.push({ label, url, type, sortOrder });
  }
  return { value: cleaned };
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  if (!token) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (_) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청 본문입니다.' }) };
  }

  // slug · links validate
  const slugInput = body.slug != null ? String(body.slug) : null;
  const slugCheck = slugInput ? validateSlug(slugInput) : { value: null };
  if (slugCheck && slugCheck.error) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: slugCheck.error }) };
  }

  const linksCheck = validateLinks(body.links || []);
  if (linksCheck.error) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: linksCheck.error }) };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[save-linktree] Supabase 클라이언트 초기화 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류입니다.' }) };
  }

  // 인증: Supabase JWT email 매칭 → 실패 시 seller-jwt fallback (get-my-linktree 와 동일)
  let sellerId = null;
  let supaAuthData = null;
  try {
    const { data } = await admin.auth.getUser(token);
    supaAuthData = data || null;
  } catch (e) {
    console.log('[save-linktree] Supabase JWT 검증 예외 — seller-jwt fallback:', e && e.message);
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

  // 1) slug 변경 (있을 때만)
  if (slugCheck.value) {
    // 중복 체크 — 본인 외 다른 sellers 가 같은 slug 쓰는지
    const { data: dup, error: dupErr } = await admin
      .from('sellers')
      .select('id')
      .eq('linktree_slug', slugCheck.value)
      .neq('id', sellerId)
      .maybeSingle();
    if (dupErr) {
      console.error('[save-linktree] slug 중복 체크 오류:', dupErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류입니다.' }) };
    }
    if (dup) {
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: '이미 사용 중인 slug 입니다. 다른 이름을 선택해주세요.' }) };
    }

    const { error: updErr } = await admin
      .from('sellers')
      .update({ linktree_slug: slugCheck.value })
      .eq('id', sellerId);
    if (updErr) {
      console.error('[save-linktree] slug 업데이트 오류:', updErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'slug 저장에 실패했습니다.' }) };
    }
  }

  // 2) 기존 active 링크 soft delete
  const nowIso = new Date().toISOString();
  const { error: softErr } = await admin
    .from('seller_links')
    .update({ deleted_at: nowIso })
    .eq('seller_id', sellerId)
    .is('deleted_at', null);
  if (softErr) {
    console.error('[save-linktree] 기존 링크 soft delete 오류:', softErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '저장에 실패했습니다.' }) };
  }

  // 3) 새 링크 insert (있을 때만)
  let insertedLinks = [];
  if (linksCheck.value.length > 0) {
    const rows = linksCheck.value.map((l, i) => ({
      seller_id: sellerId,
      label: l.label,
      url: l.url,
      link_type: l.type,
      sort_order: l.sortOrder != null ? l.sortOrder : i,
    }));
    const { data: inserted, error: insErr } = await admin
      .from('seller_links')
      .insert(rows)
      .select('id, label, url, link_type, sort_order');
    if (insErr) {
      console.error('[save-linktree] 새 링크 insert 오류:', insErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '저장에 실패했습니다.' }) };
    }
    insertedLinks = inserted || [];
  }

  // 4) 최종 slug + 링크 반환
  const { data: finalSeller } = await admin
    .from('sellers')
    .select('linktree_slug')
    .eq('id', sellerId)
    .maybeSingle();

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      slug: (finalSeller && finalSeller.linktree_slug) || null,
      links: insertedLinks.map((l) => ({
        id: l.id,
        label: l.label,
        url: l.url,
        type: l.link_type,
        sortOrder: l.sort_order,
      })),
    }),
  };
};
