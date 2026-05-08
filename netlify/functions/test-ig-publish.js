// ⚠️ 일회성 디버그 함수
// query param으로 secret 받는 건 보안상 임시 허용 (sandbox WebFetch 검증용).
// 검증 끝나면 이 함수 자체를 즉시 삭제할 것.
//
// 인증 (둘 중 하나):
//   Authorization: Bearer ${LUMI_SECRET}   (운영자 호출용)
//   ?token=${LUMI_SECRET}                  (sandbox WebFetch 검증용 — header 못 보냄)
//
// 사용:
//   GET /api/test-ig-publish?token=...                       — 토큰 검증만
//   GET /api/test-ig-publish?token=...&publish=true          — 첫 valid 계정에 1장 실 게시
//   GET /api/test-ig-publish?token=...&accountId=<ig_user>   — 특정 계정만 검사
//
// 토큰/시크릿 값은 절대 응답·로그에 노출하지 않는다.
const { corsHeaders, getOrigin, verifyLumiSecret } = require('./_shared/auth');
const { getAdminClient } = require('./_shared/supabase-admin');

const GRAPH = 'https://graph.facebook.com/v25.0';

async function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(tid);
  }
}

async function verifyToken(igUserId, accessToken) {
  // /me 호출은 토큰 컨텍스트에 따라 IG/페이지/유저 객체로 응답.
  // ig_user_id 명시 호출이 가장 명확.
  const target = igUserId || 'me';
  const url = `${GRAPH}/${target}?fields=id,username,account_type,name&access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetchWithTimeout(url, { method: 'GET' }, 30_000);
  let data;
  try { data = await res.json(); } catch (_) { data = {}; }
  if (data.error) {
    return {
      ok: false,
      status: res.status,
      errorCode: data.error.code,
      errorSubcode: data.error.error_subcode,
      errorType: data.error.type,
      errorMessage: data.error.message,
    };
  }
  return {
    ok: true,
    id: data.id,
    username: data.username || null,
    name: data.name || null,
    account_type: data.account_type || null,
  };
}

async function tryPublish(igUserId, accessToken) {
  const ts = new Date().toISOString();
  const imageUrl = `https://picsum.photos/seed/lumi-test-${Date.now()}/1080/1080`;
  const caption = `[루미 테스트] 인스타 자동 게시 검증 - ${ts}\n곧 자동 삭제됩니다.`;

  // 1) 컨테이너 생성
  const cParams = new URLSearchParams({ image_url: imageUrl, caption, access_token: accessToken });
  const cRes = await fetchWithTimeout(`${GRAPH}/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: cParams,
  }, 30_000);
  let cData;
  try { cData = await cRes.json(); } catch (_) { cData = {}; }
  if (cData.error || !cData.id) {
    return {
      success: false,
      stage: 'container',
      errorCode: cData.error?.code,
      errorSubcode: cData.error?.error_subcode,
      errorMessage: cData.error?.message || `HTTP ${cRes.status}`,
    };
  }
  const creationId = cData.id;

  // 2) publish
  const pRes = await fetchWithTimeout(`${GRAPH}/${igUserId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ creation_id: creationId, access_token: accessToken }),
  }, 30_000);
  let pData;
  try { pData = await pRes.json(); } catch (_) { pData = {}; }
  if (pData.error || !pData.id) {
    return {
      success: false,
      stage: 'publish',
      creationId,
      errorCode: pData.error?.code,
      errorSubcode: pData.error?.error_subcode,
      errorMessage: pData.error?.message || `HTTP ${pRes.status}`,
    };
  }
  const mediaId = pData.id;

  // 3) permalink 조회 (옵션, 실패해도 무시)
  let permalink = null;
  try {
    const lRes = await fetchWithTimeout(
      `${GRAPH}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(accessToken)}`,
      { method: 'GET' },
      10_000
    );
    const lData = await lRes.json();
    if (!lData.error) permalink = lData.permalink || null;
  } catch (_) { /* noop */ }

  return {
    success: true,
    creationId,
    mediaId,
    permalink,
    imageUrl,
    caption,
    note: 'Function timeout 우려로 자동 삭제는 시도하지 않음. 필요 시 수동 삭제하거나 별도 호출로 DELETE /{media_id}',
  };
}

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'method_not_allowed' }) };
  }

  // query/body 파싱
  const qs = event.queryStringParameters || {};

  // 인증 — header 우선, 없으면 ?token= query param 폴백.
  // sandbox WebFetch는 custom header 못 보내서 query param도 임시 허용.
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const tokenFromHeader = String(authHeader || '').replace(/^Bearer\s+/i, '');
  const tokenFromQuery = qs.token || '';
  const providedToken = tokenFromHeader || tokenFromQuery;
  if (!verifyLumiSecret(providedToken)) {
    return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };
  }
  let body = {};
  if (event.httpMethod === 'POST' && event.body) {
    try { body = JSON.parse(event.body); } catch (_) { body = {}; }
  }
  const publishFlag = String(qs.publish ?? body.publish ?? '').toLowerCase() === 'true';
  const filterAccountId = qs.accountId || body.accountId || null;

  try {
    const supabase = getAdminClient();

    // 1) ig_accounts_decrypted 뷰에서 토큰 가져오기
    let query = supabase
      .from('ig_accounts_decrypted')
      .select('user_id, ig_user_id, username, access_token, page_access_token, token_expires_at, updated_at');
    if (filterAccountId) query = query.eq('ig_user_id', filterAccountId);

    const { data: rows, error: dbErr } = await query;
    if (dbErr) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          ok: false,
          error: 'db_query_failed',
          detail: dbErr.message,
          hint: 'ig_accounts_decrypted 뷰가 없거나 service_role 권한 부족 가능성',
        }),
      };
    }
    const accounts = Array.isArray(rows) ? rows : [];

    const result = {
      ok: true,
      timestamp: new Date().toISOString(),
      summary: {
        totalAccounts: accounts.length,
        validTokens: 0,
        invalidTokens: 0,
        publishAttempted: false,
        publishSucceeded: false,
      },
      accounts: [],
      errors: [],
    };

    if (!accounts.length) {
      result.errors.push(filterAccountId
        ? `ig_user_id=${filterAccountId} 계정을 찾을 수 없음`
        : 'ig_accounts_decrypted 뷰에 행이 0개');
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // 2) 각 계정 토큰 검증
    let firstValidIdx = -1;
    for (let i = 0; i < accounts.length; i++) {
      const row = accounts[i];
      const tokenForRead = row.page_access_token || row.access_token;
      const accountInfo = {
        ig_user_id: row.ig_user_id,
        username_db: row.username || null,
        user_id: row.user_id,
        has_access_token: !!row.access_token,
        has_page_access_token: !!row.page_access_token,
        token_expires_at: row.token_expires_at || null,
        updated_at: row.updated_at || null,
      };

      if (!tokenForRead || !row.ig_user_id) {
        accountInfo.tokenValid = false;
        accountInfo.error = 'missing_token_or_ig_user_id';
        result.summary.invalidTokens += 1;
        result.accounts.push(accountInfo);
        continue;
      }

      const verify = await verifyToken(row.ig_user_id, tokenForRead);
      if (verify.ok) {
        accountInfo.tokenValid = true;
        accountInfo.username = verify.username;
        accountInfo.account_type = verify.account_type;
        accountInfo.ig_id_echo = verify.id;
        result.summary.validTokens += 1;
        if (firstValidIdx === -1) firstValidIdx = i;
      } else {
        accountInfo.tokenValid = false;
        accountInfo.errorCode = verify.errorCode;
        accountInfo.errorSubcode = verify.errorSubcode;
        accountInfo.errorType = verify.errorType;
        accountInfo.errorMessage = verify.errorMessage;
        // Meta 흔한 에러 힌트
        if (verify.errorCode === 190) accountInfo.hint = '토큰 만료/무효 — 재연동 필요';
        else if (verify.errorCode === 10 || verify.errorCode === 200) accountInfo.hint = 'App Review 미통과 또는 권한 부족 (Tester 미등록 일반 사용자)';
        else if (verify.errorCode === 4 || verify.errorCode === 17) accountInfo.hint = 'Rate limit';
        result.summary.invalidTokens += 1;
      }

      result.accounts.push(accountInfo);
    }

    // 3) publish 시도 — 첫 valid 계정 1개에만
    if (publishFlag) {
      result.summary.publishAttempted = true;
      if (firstValidIdx === -1) {
        result.errors.push('publish=true 지정됐으나 valid 토큰을 가진 계정이 없음');
      } else {
        const row = accounts[firstValidIdx];
        const tokenForPublish = row.page_access_token || row.access_token;
        try {
          const pub = await tryPublish(row.ig_user_id, tokenForPublish);
          result.accounts[firstValidIdx].publishAttempt = pub;
          if (pub.success) result.summary.publishSucceeded = true;
          else if (pub.errorCode === 10 || pub.errorCode === 200) {
            result.accounts[firstValidIdx].publishHint = 'App Review 미통과 / Tester 미등록 / instagram_content_publish 권한 부재';
          }
        } catch (e) {
          result.accounts[firstValidIdx].publishAttempt = {
            success: false,
            stage: 'exception',
            errorMessage: e.message || String(e),
          };
        }
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify(result, null, 2) };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        ok: false,
        error: 'internal_error',
        detail: err.message || String(err),
      }),
    };
  }
};
