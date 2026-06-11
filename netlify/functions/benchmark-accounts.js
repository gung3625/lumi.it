// 벤치마크 계정 관리 — POST 추가 / DELETE 제거
// POST   /api/benchmark-accounts  body: { username: "@계정 또는 instagram.com/계정 URL" }
// DELETE /api/benchmark-accounts?id=<uuid>
// 헤더: Authorization: Bearer <jwt>
//
// 정책: 셀러당 활성 3개까지. 공개 데이터만 수집하므로 비공개 계정은 분석 시 에러로 안내.

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken } = require('./_shared/supabase-auth');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const MAX_ACCOUNTS = 3;

// '@이름', 'instagram.com/이름/' 붙여넣기 모두 허용 → 소문자 핸들로 정규화
function parseUsername(raw) {
  let u = String(raw || '').trim();
  const m = u.match(/instagram\.com\/([A-Za-z0-9._]+)/);
  if (m) u = m[1];
  u = u.replace(/^@/, '').toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(u) ? u : null;
}

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };
  if (!['POST', 'DELETE'].includes(event.httpMethod)) {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'method_not_allowed' }) };
  }

  const token = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: '인증이 필요합니다.' }) };
  }

  const supa = getAdminClient();

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
    const username = parseUsername(body.username);
    if (!username) {
      return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: '인스타그램 아이디 형식이 아니에요. @아이디 또는 프로필 주소를 붙여넣어 주세요.' }) };
    }

    const { count, error: cntErr } = await supa
      .from('benchmark_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('seller_id', user.id)
      .eq('active', true);
    if (cntErr) {
      return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: '잠시 후 다시 시도해 주세요.' }) };
    }
    if ((count || 0) >= MAX_ACCOUNTS) {
      return { statusCode: 409, headers, body: JSON.stringify({ ok: false, error: `벤치마크 계정은 ${MAX_ACCOUNTS}개까지 등록할 수 있어요. 기존 계정을 지우고 추가해 주세요.` }) };
    }

    const { data: row, error: insErr } = await supa
      .from('benchmark_accounts')
      .upsert(
        { seller_id: user.id, ig_username: username, active: true },
        { onConflict: 'seller_id,ig_username' }
      )
      .select('id, ig_username, last_scraped_at, created_at')
      .single();
    if (insErr) {
      return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: '등록에 실패했어요. 잠시 후 다시 시도해 주세요.' }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, account: row }) };
  }

  // DELETE
  const id = (event.queryStringParameters || {}).id || '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'id 누락' }) };
  }
  const { error: delErr } = await supa
    .from('benchmark_accounts')
    .delete()
    .eq('id', id)
    .eq('seller_id', user.id);
  if (delErr) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: '삭제에 실패했어요. 잠시 후 다시 시도해 주세요.' }) };
  }
  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
