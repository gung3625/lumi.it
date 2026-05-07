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
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    qs.set(k, String(v));
  }
  qs.set('access_token', token);
  const url = `${GRAPH_BASE}${safePath}?${qs.toString()}`;

  const timeoutMs = opts.timeoutMs || 8000;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal });
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

module.exports = {
  getIgTokenForSeller,
  igGraphRequest,
  IgGraphError,
  GRAPH_API_VERSION,
  GRAPH_BASE,
};
