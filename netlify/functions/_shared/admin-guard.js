// Admin auth guard — Bearer 토큰 → users.is_admin = true 검증.
// brand-stats / brand-retrain / brand-settings 등 관리자 전용 endpoint 공용.
//
// 인증 흐름:
//   1) Supabase JWT 우선 (admin.auth.getUser) — OAuth 사용자
//   2) 환경변수/하드코딩 폴백 admin id 매칭 (네트워크 실패 대비)
//   3) public.users.is_admin = true 확인 (Service role)
//
// 반환:
//   { ok: true,  user: { id, email } }                              — 관리자
//   { ok: false, status: 401, error: '...' }                         — 미인증
//   { ok: false, status: 403, error: '관리자 권한이 없습니다.' }     — 비관리자
//   { ok: false, status: 500, error: '...' }                         — 서버 오류
//
// caller 측에서 status 그대로 응답하면 됨.

const { extractBearerToken } = require('./supabase-auth');
const { isAdminEmail, isAdminUserId } = require('./admin');

/**
 * Bearer 토큰 검증 후 관리자 여부 확인.
 * @param {object} event   Netlify event
 * @param {object} admin   getAdminClient() 결과 (Service role Supabase client)
 * @returns {Promise<{ok:true, user:{id,email}} | {ok:false,status:number,error:string}>}
 */
async function requireAdmin(event, admin) {
  const token = extractBearerToken(event);
  if (!token) {
    return { ok: false, status: 401, error: '인증이 필요합니다.' };
  }

  let supaUser = null;
  try {
    const { data, error } = await admin.auth.getUser(token);
    if (error) {
      console.warn('[admin-guard] supabase getUser 오류:', error.message);
    } else if (data && data.user) {
      supaUser = data.user;
    }
  } catch (e) {
    console.warn('[admin-guard] supabase getUser 예외:', e && e.message);
  }

  if (!supaUser) {
    return { ok: false, status: 401, error: '인증이 만료되었습니다. 다시 로그인해주세요.' };
  }

  const userId = String(supaUser.id || '');
  const userEmail = String(supaUser.email || '').toLowerCase();

  // 1) 환경변수/하드코딩 폴백 — DB 조회 전에 통과시켜 운영 장애 시에도 admin 접근 보장
  if (isAdminUserId(userId) || isAdminEmail(userEmail)) {
    return { ok: true, user: { id: userId, email: userEmail } };
  }

  // 2) users.is_admin 조회 (Service role — RLS 우회)
  try {
    const { data: row, error: dbErr } = await admin
      .from('users')
      .select('is_admin')
      .eq('id', userId)
      .maybeSingle();

    if (dbErr) {
      console.error('[admin-guard] users select 오류:', dbErr.message);
      return { ok: false, status: 500, error: '관리자 권한 조회 실패' };
    }

    if (!row || row.is_admin !== true) {
      return { ok: false, status: 403, error: '관리자 권한이 없습니다.' };
    }

    return { ok: true, user: { id: userId, email: userEmail } };
  } catch (e) {
    console.error('[admin-guard] 예외:', e && e.message);
    return { ok: false, status: 500, error: '서버 오류' };
  }
}

module.exports = { requireAdmin };
