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

  // GET / DELETE 는 params 를 query string 으로 (body 없음).
  // POST/PUT 등은 params 를 form-encoded body, access_token 만 query.
  const qs = new URLSearchParams();
  let bodyForm = null;
  if (method === 'GET' || method === 'DELETE') {
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

/**
 * IG 게시물 삭제 — DELETE /{ig-media-id}.
 *
 * Meta 정책 (developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media):
 *   - 권한: instagram_basic + instagram_manage_contents (ig-oauth SCOPES 에 추가됨)
 *   - 본인 미디어만 (사장님 IG Business 계정 본인 게시물)
 *   - 지원: 비광고 post / story / reels / 전체 carousel album (개별 carousel item 은 X)
 *   - Facebook Login 흐름에서만 (Instagram Login 아님 — lumi 는 Facebook Login)
 *
 * @param {string} token - igAccessToken (page_access_token 우선)
 * @param {string} mediaId
 * @returns {Promise<{success: boolean}>}
 */
async function deleteIgMedia(token, mediaId, opts = {}) {
  if (!mediaId) throw new IgGraphError('mediaId 누락', { status: 400 });
  return igGraphRequest(token, `/${mediaId}`, {}, { method: 'DELETE', ...opts });
}

/**
 * 단일 셀러 IG 토큰을 즉시 갱신 (force-refresh).
 *
 * 용도: 발행 함수 (select-and-post, retry-channel-post) 가 401/code 190 받은
 * 즉시 호출 → 다음 fetch 가 새 토큰으로 1회 재시도 (Important D, 2026-05-20).
 *
 * 배경: scheduled-ig-token-refresh-background 가 매일 06:00 KST 만 돈다.
 * 갱신 cron 사이 24h 윈도우 안에 토큰 expire 되면 발행 stuck. 매시간 watchdog
 * 이 stuck-scheduled-overdue 잡지만 사장님은 hours 단위 발행 지연 경험.
 *
 * Meta refresh_access_token endpoint 조건:
 *   - 토큰이 24시간 이상 경과 + 만료 전이어야 함
 *   - 이 조건 만족 안 하면 (예: 갓 발급 토큰이 invalid) 갱신 실패 — null 반환
 *
 * @param {string} sellerId - sellers.id (= ig_accounts.user_id)
 * @param {object} supabase - getAdminClient() 결과 (service_role)
 * @returns {Promise<{accessToken: string, expiresAt: string}|null>}
 *          성공 시 새 토큰 정보. 실패 (만료/invalid/Vault 에러) 시 null.
 */
async function refreshIgTokenForSeller(sellerId, supabase) {
  if (!sellerId || !supabase) return null;
  try {
    // 현재 plaintext 토큰 조회 (ig_accounts_decrypted view)
    const { data: dec, error: decErr } = await supabase
      .from('ig_accounts_decrypted')
      .select('ig_user_id, access_token')
      .eq('user_id', sellerId)
      .maybeSingle();
    if (decErr || !dec || !dec.access_token) {
      console.warn('[ig-graph] refresh: 현재 토큰 조회 실패:', decErr?.message || 'no token');
      return null;
    }
    const igUserId = dec.ig_user_id;
    const oldToken = dec.access_token;

    // Meta refresh endpoint 호출 — transient 실패 대비 3회 재시도 (exponential backoff).
    // 2026-05-20 prevention #3: 1회 시도로 끝내면 일시 네트워크 글리치에 사장님 수동 재연동
    // 강요. 500ms → 1.5s → 4.5s 백오프 후 포기. invalid_grant 같은 4xx 는 즉시 포기 (재시도 의미 X).
    const refreshUrl = `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(oldToken)}`;
    let result = null;
    let lastErr = '';
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 30_000);
      let res;
      try {
        res = await fetch(refreshUrl, { signal: ctrl.signal });
      } catch (fetchErr) {
        lastErr = `network: ${fetchErr.message || 'unknown'}`;
        clearTimeout(tid);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 500 * Math.pow(3, attempt - 1)));
          continue;
        }
        console.warn(`[ig-graph] refresh: ${MAX_RETRIES}회 시도 후 포기 — ${lastErr}`);
        return null;
      }
      clearTimeout(tid);

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        lastErr = `HTTP ${res.status} — ${errBody.slice(0, 200)}`;
        // 4xx (invalid token/grant 등) 는 재시도 의미 없음 — 즉시 포기.
        // 5xx (Meta 서버 일시 장애) 만 retry.
        if (res.status >= 400 && res.status < 500) {
          console.warn(`[ig-graph] refresh: 4xx 즉시 포기 — ${lastErr}`);
          return null;
        }
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 500 * Math.pow(3, attempt - 1)));
          continue;
        }
        console.warn(`[ig-graph] refresh: ${MAX_RETRIES}회 시도 후 포기 — ${lastErr}`);
        return null;
      }

      result = await res.json().catch(() => null);
      if (result && result.access_token && result.expires_in) break;
      lastErr = '응답 파싱 실패';
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 500 * Math.pow(3, attempt - 1)));
        continue;
      }
      console.warn(`[ig-graph] refresh: ${MAX_RETRIES}회 시도 후 포기 — ${lastErr}`);
      return null;
    }

    const newToken = result.access_token;
    const expiresIn = result.expires_in;
    const newExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const refreshedAt = new Date().toISOString();

    // Vault 에 새 토큰 저장 (access_token_secret_id 는 ig_accounts 에서 조회)
    const { data: accRow } = await supabase
      .from('ig_accounts')
      .select('access_token_secret_id')
      .eq('ig_user_id', igUserId)
      .maybeSingle();
    const { error: vaultErr } = await supabase.rpc('set_ig_access_token', {
      p_ig_user_id: igUserId,
      p_existing_secret: accRow?.access_token_secret_id ?? null,
      p_access_token: newToken,
    });
    if (vaultErr) {
      console.warn('[ig-graph] refresh: Vault 저장 실패:', vaultErr.message);
      return null;
    }

    // ig_accounts 만료/갱신 시각 업데이트 + token_invalid_at 해제
    await supabase
      .from('ig_accounts')
      .update({
        token_expires_at: newExpiresAt,
        last_refreshed_at: refreshedAt,
        updated_at: refreshedAt,
        token_invalid_at: null,  // 갱신 성공이니 invalid 마킹 해제
      })
      .eq('ig_user_id', igUserId);

    console.log(`[ig-graph] refresh: ${String(sellerId).slice(0, 8)} 토큰 갱신 완료 (만료=${newExpiresAt})`);
    return { accessToken: newToken, expiresAt: newExpiresAt };
  } catch (e) {
    console.warn('[ig-graph] refresh: 예외:', e && e.message);
    return null;
  }
}

module.exports = {
  getIgTokenForSeller,
  refreshIgTokenForSeller,
  igGraphRequest,
  deleteIgMedia,
  markIgTokenInvalid,
  IgGraphError,
  GRAPH_API_VERSION,
  GRAPH_BASE,
};
