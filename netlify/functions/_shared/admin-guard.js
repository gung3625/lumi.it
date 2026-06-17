// Admin auth guard — Bearer 토큰 → 관리자 검증.
//
// lumi 클라이언트는 두 종류 토큰을 쓴다:
//   - Supabase JWT (OAuth 세션)         → admin.auth.getUser 로 검증
//   - seller-jwt (HS256, auth-fetch 갱신) → verifySellerToken 로 검증  ← lumi 기본 토큰
// 따라서 둘 다 받아준다(어느 쪽이든 관리자 신원이 확인되면 통과).
//
// 관리자 판정: isAdminUserId / isAdminEmail (env·하드코딩 폴백) 또는 sellers.is_admin = true.
//
// 반환:
//   { ok: true,  user: { id, email } }                          — 관리자
//   { ok: false, status: 401, error }                            — 토큰 없음/만료
//   { ok: false, status: 403, error: '관리자 권한이 없습니다.' } — 비관리자

const { extractBearerToken } = require('./supabase-auth');
const { verifySellerToken } = require('./seller-jwt');
const { isAdminEmail, isAdminUserId } = require('./admin');

async function checkSellerIsAdmin(admin, id) {
  if (!id) return false;
  try {
    const { data: row, error } = await admin
      .from('sellers')
      .select('is_admin')
      .eq('id', id)
      .maybeSingle();
    if (error) { console.error('[admin-guard] sellers select 오류:', error.message); return false; }
    return !!(row && row.is_admin === true);
  } catch (e) {
    console.error('[admin-guard] checkSellerIsAdmin 예외:', e && e.message);
    return false;
  }
}

/**
 * Bearer 토큰 검증 후 관리자 여부 확인. Supabase JWT + seller-jwt 둘 다 허용.
 * @returns {Promise<{ok:true, user:{id,email}} | {ok:false,status:number,error:string}>}
 */
async function requireAdmin(event, admin) {
  const token = extractBearerToken(event);
  if (!token) {
    return { ok: false, status: 401, error: '인증이 필요합니다.' };
  }

  // 1) Supabase JWT 경로
  let supaUser = null;
  try {
    const { data, error } = await admin.auth.getUser(token);
    if (error) console.warn('[admin-guard] supabase getUser 오류:', error.message);
    else if (data && data.user) supaUser = data.user;
  } catch (e) {
    console.warn('[admin-guard] supabase getUser 예외:', e && e.message);
  }
  if (supaUser) {
    const userId = String(supaUser.id || '');
    const userEmail = String(supaUser.email || '').toLowerCase();
    if (isAdminUserId(userId) || isAdminEmail(userEmail)) {
      return { ok: true, user: { id: userId, email: userEmail } };
    }
    if (await checkSellerIsAdmin(admin, userId)) {
      return { ok: true, user: { id: userId, email: userEmail } };
    }
  }

  // 2) seller-jwt 경로 (lumi 클라이언트 기본 토큰)
  const { payload } = verifySellerToken(token);
  const sid = payload && payload.seller_id ? String(payload.seller_id) : '';
  if (sid) {
    if (isAdminUserId(sid)) {
      return { ok: true, user: { id: sid, email: '' } };
    }
    if (await checkSellerIsAdmin(admin, sid)) {
      return { ok: true, user: { id: sid, email: '' } };
    }
  }

  // 토큰을 둘 다 못 읽음 → 401 (만료/무효), 읽었지만 비관리자 → 403
  if (!supaUser && !sid) {
    return { ok: false, status: 401, error: '인증이 만료되었습니다. 다시 로그인해주세요.' };
  }
  return { ok: false, status: 403, error: '관리자 권한이 없습니다.' };
}

module.exports = { requireAdmin };
