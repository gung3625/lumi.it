// 링크트리 slug 자동 생성 헬퍼.
// 우선순위: ig_username 정규화 → fallback `lumi-{6자 base36}`.
// 충돌 시 -2, -3 ... suffix 부여.
const RESERVED = new Set([
  'admin', 'api', 'dashboard', 'settings', 'terms', 'privacy', 'refund',
  'support', 'history', 'trends', 'insights', 'comments', 'signup', 'login',
  'r', 'register', 'register-product', 'me', 'help', 'static', 'assets',
  'css', 'js', 'data-deletion-status', 'linktree',
]);
const SLUG_RE = /^[a-z0-9-]{3,30}$/;

function normalizeIgHandle(handle) {
  if (!handle) return null;
  let s = String(handle).toLowerCase();
  s = s.replace(/[^a-z0-9]/g, '-');
  s = s.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length === 0) return null;
  if (s.length < 3) s = `${s}-shop`;
  if (s.length > 30) s = s.slice(0, 30).replace(/-+$/, '');
  if (!SLUG_RE.test(s)) return null;
  if (RESERVED.has(s)) return null;
  return s;
}

function randomBase36(len) {
  let s = '';
  while (s.length < len) {
    s += Math.random().toString(36).slice(2);
  }
  return s.slice(0, len);
}

function fallbackSlug() {
  return `lumi-${randomBase36(6)}`;
}

/**
 * 후보 slug 가 sellers 테이블에 이미 있으면 -2, -3 ... 시도.
 * @param {SupabaseClient} admin — service_role client
 * @param {string} candidate — 정규화된 후보
 * @param {string} sellerId — 본인 row 제외
 * @returns {Promise<string>} 충돌 없는 최종 slug
 */
async function resolveUniqueSlug(admin, candidate, sellerId) {
  let base = candidate || fallbackSlug();
  for (let i = 0; i < 30; i += 1) {
    const trySlug = i === 0 ? base : `${base}-${i + 1}`;
    if (trySlug.length > 30) {
      base = base.slice(0, 27);
      continue;
    }
    const { data: dup } = await admin
      .from('sellers')
      .select('id')
      .eq('linktree_slug', trySlug)
      .neq('id', sellerId)
      .maybeSingle();
    if (!dup) return trySlug;
  }
  // 30번 충돌 — 거의 불가능. 안전망 fallback.
  return fallbackSlug();
}

/**
 * sellers row 가 linktree_slug 없으면 자동 부여 + DB update.
 * 이미 있으면 그대로 반환.
 * @param {SupabaseClient} admin
 * @param {string} sellerId
 * @returns {Promise<string|null>}
 */
async function ensureSlugForSeller(admin, sellerId) {
  const { data: seller, error } = await admin
    .from('sellers')
    .select('linktree_slug')
    .eq('id', sellerId)
    .maybeSingle();
  if (error || !seller) return null;
  if (seller.linktree_slug) return seller.linktree_slug;

  // 1순위: ig_username
  let candidate = null;
  const { data: igAcc } = await admin
    .from('ig_accounts')
    .select('ig_username')
    .eq('seller_id', sellerId)
    .maybeSingle();
  if (igAcc && igAcc.ig_username) {
    candidate = normalizeIgHandle(igAcc.ig_username);
  }
  // 2순위: fallback
  if (!candidate) candidate = fallbackSlug();

  const finalSlug = await resolveUniqueSlug(admin, candidate, sellerId);
  const { error: updErr } = await admin
    .from('sellers')
    .update({ linktree_slug: finalSlug })
    .eq('id', sellerId);
  if (updErr) {
    console.error('[linktree-slug] slug 저장 실패:', updErr.message);
    return null;
  }
  return finalSlug;
}

module.exports = { ensureSlugForSeller, normalizeIgHandle, fallbackSlug, resolveUniqueSlug, SLUG_RE, RESERVED };
