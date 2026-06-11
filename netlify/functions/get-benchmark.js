// 벤치마크 탭 데이터 — 계정 목록 + 계정별 최신 리포트
// GET /api/get-benchmark
// 헤더: Authorization: Bearer <jwt>
//
// 응답: { ok, enabled, accounts: [{ id, ig_username, last_scraped_at,
//          latestReport: { id, status, stats, report, error, created_at, finished_at } | null }] }
// enabled=false → APIFY_TOKEN 미설정 (UI는 준비 중 안내)

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken } = require('./_shared/supabase-auth');
const { corsHeaders, getOrigin } = require('./_shared/auth');

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'method_not_allowed' }) };
  }

  const token = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: '인증이 필요합니다.' }) };
  }

  const supa = getAdminClient();
  const { data: accounts, error: accErr } = await supa
    .from('benchmark_accounts')
    .select('id, ig_username, last_scraped_at, created_at')
    .eq('seller_id', user.id)
    .eq('active', true)
    .order('created_at', { ascending: true });
  if (accErr) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: '잠시 후 다시 시도해 주세요.' }) };
  }

  const ids = (accounts || []).map((a) => a.id);
  let reportsByAccount = {};
  if (ids.length) {
    const { data: reports } = await supa
      .from('benchmark_reports')
      .select('id, account_id, status, stats, report, error, created_at, finished_at')
      .eq('seller_id', user.id)
      .in('account_id', ids)
      .order('created_at', { ascending: false })
      .limit(30);
    for (const r of reports || []) {
      if (!reportsByAccount[r.account_id]) reportsByAccount[r.account_id] = r;
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      enabled: Boolean(process.env.APIFY_TOKEN),
      accounts: (accounts || []).map((a) => ({
        ...a,
        latestReport: reportsByAccount[a.id] || null,
      })),
    }),
  };
};
