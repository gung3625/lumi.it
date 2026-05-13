// Threads 연동 해제 — settings 페이지의 쓰레드 카드 '해제' 버튼용.
// disconnect-ig.js 패턴 1:1, 단 ig_accounts row 자체는 보존하고
// threads_* 컬럼만 NULL 리셋 (IG 연동은 유지).

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { verifySellerToken } = require('./_shared/seller-jwt');

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  let userId = null;
  const { user } = await verifyBearerToken(token);
  if (user && user.id) {
    userId = user.id;
  } else {
    const { payload } = verifySellerToken(token);
    if (payload && payload.seller_id) userId = payload.seller_id;
  }
  if (!userId) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  try {
    const admin = getAdminClient();

    // 코드 리뷰 #4 — Vault secret 청소: update 전에 threads_token_secret_id
    // 확보 후 delete_vault_secret RPC 로 평문 토큰 즉시 폐기.
    const { data: row } = await admin
      .from('ig_accounts')
      .select('threads_token_secret_id')
      .eq('user_id', userId)
      .maybeSingle();

    const { error } = await admin
      .from('ig_accounts')
      .update({
        threads_user_id:           null,
        threads_username:          null,
        threads_token_secret_id:   null,
        threads_token_expires_at:  null,
        threads_token_invalid_at:  null,
        updated_at:                new Date().toISOString(),
      })
      .eq('user_id', userId);
    if (error) {
      console.error('[disconnect-threads] update error:', error.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: '해제 실패' }) };
    }

    // Vault 청소 — best-effort
    if (row && row.threads_token_secret_id) {
      try {
        await admin.rpc('delete_vault_secret', { p_secret_id: row.threads_token_secret_id });
      } catch (e) {
        console.warn('[disconnect-threads] delete_vault_secret 경고 (무시):', e && e.message);
      }
    }

    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true }),
    };
  } catch (err) {
    console.error('[disconnect-threads] unexpected:', err && err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
