// Threads 연동 상태 조회 — settings 페이지의 쓰레드 카드용.
// disconnect-ig.js 패턴 1:1 (Bearer 검증 → admin client → ig_accounts 조회).
//
// 응답: { threadsConnected: boolean, tokenExpired: boolean }
//   - threadsConnected: ig_accounts.threads_user_id 가 NOT NULL
//   - tokenExpired:     threads_token_invalid_at 이 NOT NULL (즉시 재연동 유도)

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { verifySellerToken } = require('./_shared/seller-jwt');

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') {
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
    const { data, error } = await admin
      .from('ig_accounts')
      .select('threads_user_id, threads_token_invalid_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      console.error('[threads-status] select error:', error.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: '상태 조회 실패' }) };
    }
    const threadsConnected = !!(data && data.threads_user_id);
    const tokenExpired     = threadsConnected && !!data.threads_token_invalid_at;
    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadsConnected, tokenExpired }),
    };
  } catch (err) {
    console.error('[threads-status] unexpected:', err && err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
