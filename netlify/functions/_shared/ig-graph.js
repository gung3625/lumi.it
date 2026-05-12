// Instagram Graph API 공통 헬퍼 (B3/B4/B5 인사이트 함수 공용)
// - getIgTokenForSeller(sellerId, supabase): ig_accounts_decrypted 뷰에서 토큰 조회
// - igGraphRequest(token, path, params): fetch wrapper, 에러 표준화, rate limit 헤더 로그
//
// 보안 원칙:
//   - access_token / page_access_token 은 절대 로그·응답에 출력하지 않는다.
//   - 토큰은 호출 직전에만 메모리에 두고 즉시 폐기한다.
//   - 본 helper 는 service_role 클라이언트(getAdminClient)에서만 호출돼야 한다.

const GRAPH_API_VERSION = 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

class IgGraphError extends Error {
  constructor(message, { status, code, type, fbtrace_id } = {}) {
    super(message);
    this.name = 'IgGraphError';
    this.status = status || null;
    this.code = code || null;       // FB 에러 코드 (190 = 토큰 만료)
    this.type = type || null;
    this.fbtrace_id = fbtrace_id || null;
  }
  isTokenExpired() {
    // OAuth 만료/무효 토큰 코드: 190(invalid token), 102(session expired), 200(permission)
    if (this.status === 401) return true;
    if (this.code === 190) return true;
    return false;
  }
}

/**
 * 셀러의 IG 토큰·계정 정보 조회.
 * sellers.id = auth.users.id = public.users.id 인 점을 활용해
 * ig_accounts.user_id = sellerId 로 매칭한다.
 *
 * @param {string} sellerId - sellers.id (uuid)
 * @param {object} supabase - getAdminClient() 결과 (service_role)
 * @returns {Promise<{ igUserId: string, accessToken: string, igUsername: string|null, tokenExpiresAt: string|null }|null>}
 *          IG 미연동 시 null. 토큰이 비어 있으면 null.
 */
async function getIgTokenForSeller(sellerId, supabase) {
  if (!sellerId || !supabase) return null;
  try {
    const { data, error } = await supabase
      .from('ig_accounts_decrypted')
      .select('ig_user_id, ig_username, access_token, page_access_token, token_expires_at')
      .eq('user_id', sellerId)
      .maybeSingle();
    if (error) {
      console.warn('[ig-graph] ig_accounts_decrypted 조회 경고:', error.message);
      return null;
    }
    if (!data || !data.ig_user_id) return null;
    const token = data.page_access_token || data.access_token || null;
    if (!token) return null;
    return {
      igUserId: data.ig_user_id,
      accessToken: token,
      igUsername: data.ig_username || null,
      tokenExpiresAt: data.token_expires_at || null,
    };
  } catch (e) {
    console.warn('[ig-graph] getIgTokenForSeller 예외:', e && e.message);
    return null;
  }
}

/**
 * IG Graph API 호출 wrapper.
 * - access_token 은 query string 으로 전달 (FB 표준)
 * - 에러 응답이면 IgGraphError 던짐
 * - x-business-use-case-usage / x-app-usage 헤더는 토큰 내용이 없으므로 디버그 로그
 *
 * @param {string} token
 * @param {string} path  - "/{ig-user-id}/insights" 등 (앞에 슬래시 권장)
 * @param {object} params - query string 파라미터 (access_token 자동 추가)
 * @param {object} opts  - { timeoutMs }
 * @returns {Promise<object>} parsed JSON
 */
async function igGraphRequest(token, path, params = {}, opts = {}) {
  if (!token) throw new IgGraphError('access_token 누락', { status: 401, code: 190 });
  const safePath = path.startsWith('/') ? path : `/${path}`;
  const method = (opts.method || 'GET').toUpperCase();

  // GET 은 params 를 query string 으로. POST/DELETE 는 body 로 보내고 access_token 만 query.
  const qs = new URLSearchParams();
  let bodyForm = null;
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null) continue;
      qs.set(k, String(v));
    }
    qs.set('access_token', token);
  } else {
    bodyForm = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null) continue;
      bodyForm.set(k, String(v));
    }
    qs.set('access_token', token);
  }
  const url = `${GRAPH_BASE}${safePath}?${qs.toString()}`;

  const timeoutMs = opts.timeoutMs || 8000;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    const fetchOpts = { signal: ctrl.signal, method };
    if (bodyForm) {
      fetchOpts.body = bodyForm;
      fetchOpts.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    }
    res = await fetch(url, fetchOpts);
  } catch (e) {
    clearTimeout(tid);
    throw new IgGraphError(`fetch 실패: ${e.message || 'unknown'}`, { status: 0 });
  }
  clearTimeout(tid);

  // rate-limit / usage 헤더 로그 (토큰 미포함이라 안전)
  const usage = res.headers.get('x-business-use-case-usage') || res.headers.get('x-app-usage');
  if (usage) {
    // 길이 제한 — 1024자 이상 잘라냄
    const truncated = usage.length > 1024 ? usage.slice(0, 1024) + '…' : usage;
    console.log(`[ig-graph] usage ${safePath} ${truncated}`);
  }

  let data;
  try {
    data = await res.json();
  } catch (_) {
    throw new IgGraphError(`응답 JSON 파싱 실패 (status=${res.status})`, { status: res.status });
  }

  if (!res.ok || (data && data.error)) {
    const e = (data && data.error) || {};
    throw new IgGraphError(e.message || `Graph API 오류 (status=${res.status})`, {
      status: res.status,
      code: e.code || null,
      type: e.type || null,
      fbtrace_id: e.fbtrace_id || null,
    });
  }
  return data;
}

/**
 * ig_accounts.token_invalid_at 마킹 헬퍼.
 *
 * Graph API 호출에서 IgGraphError.isTokenExpired() 가 true 면 모든 호출자가
 * 이 함수를 호출해 사장님 row 를 즉시 무효 마킹해야 함:
 *   - 대시보드 / settings / comments / insights 의 재연동 배너 노출
 *   - 다음 cron · 사용자 요청들의 사전 차단 (rate limit 절약)
 *
 * 누락되면 토큰 만료 발견 후에도 같은 사장님의 후속 호출이 계속 401 받아
 * Meta rate limit 소진. PR #158 에서 select-and-post 만 마킹하던 걸 본
 * 헬퍼로 일원화 (PR #161+).
 *
 * @param {object} admin - getAdminClient() 결과 (service_role)
 * @param {string} userId - ig_accounts.user_id (= sellerId)
 * @param {string} [context] - 로그용 호출 함수 이름. 누락 시 'ig-graph'.
 * @returns {Promise<void>} — 실패해도 throw 하지 않음 (best-effort)
 */
async function markIgTokenInvalid(admin, userId, context = 'ig-graph') {
  if (!admin || !userId) return;
  try {
    await admin
      .from('ig_accounts')
      .update({ token_invalid_at: new Date().toISOString() })
      .eq('user_id', userId);
    console.log(`[${context}] token_invalid_at 마킹: user=${String(userId).slice(0, 8)}`);
  } catch (e) {
    console.warn(`[${context}] token_invalid_at 마킹 실패:`, e && e.message);
  }
}

module.exports = {
  getIgTokenForSeller,
  igGraphRequest,
  markIgTokenInvalid,
  IgGraphError,
  GRAPH_API_VERSION,
  GRAPH_BASE,
};
