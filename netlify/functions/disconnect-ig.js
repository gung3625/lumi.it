const { corsHeaders, getOrigin } = require('./_shared/auth');
// IG 연동 해제 — Bearer 검증 + admin client (RLS 우회)
// Supabase JWT (OAuth) 우선, seller-jwt (HS256, 카카오 가입자) fallback.
// invariant: sellers.id = auth.users.id = ig_accounts.user_id (UUID 동일)
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { verifySellerToken } = require('./_shared/seller-jwt');


exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  // 1) Supabase JWT 우선 검증
  let userId = null;
  const { user } = await verifyBearerToken(token);
  if (user && user.id) {
    userId = user.id;
  } else {
    // 2) seller-jwt fallback (카카오 가입자)
    const { payload } = verifySellerToken(token);
    if (payload && payload.seller_id) userId = payload.seller_id;
  }
  if (!userId) {
    return { statusCode: 401, headers: headers, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  try {
    const admin = getAdminClient();

    // 코드 리뷰 #4 — Vault secret 청소: 행 삭제 전에 secret_id 들 확보 후
    // delete_vault_secret RPC 로 vault.secrets 의 평문 토큰 즉시 폐기.
    // 행 삭제 후엔 secret_id 못 찾으니 SELECT → DELETE → RPC 순서.
    const { data: row } = await admin
      .from('ig_accounts')
      .select('access_token_secret_id, page_access_token_secret_id, threads_token_secret_id')
      .eq('user_id', userId)
      .maybeSingle();

    const { error } = await admin
      .from('ig_accounts')
      .delete()
      .eq('user_id', userId);
    if (error) {
      console.error('[disconnect-ig] delete error:', error.message);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: 'IG 연동 해제 실패' }) };
    }

    // Vault 청소 — best-effort (실패해도 IG 연동 해제 자체는 성공)
    if (row) {
      const secretIds = [row.access_token_secret_id, row.page_access_token_secret_id, row.threads_token_secret_id]
        .filter((id) => !!id);
      for (const sid of secretIds) {
        try {
          await admin.rpc('delete_vault_secret', { p_secret_id: sid });
        } catch (e) {
          console.warn('[disconnect-ig] delete_vault_secret 경고 (무시):', e && e.message);
        }
      }
    }

    return { statusCode: 200, headers: headers, body: JSON.stringify({ success: true }) };
  } catch (err) {
    console.error('[disconnect-ig] unexpected:', err && err.message);
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
