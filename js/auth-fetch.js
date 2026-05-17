// auth-fetch.js — seller-jwt access token 자동 갱신 wrapper (audit #2)
//
// 동작:
//   1) 모든 fetch 호출 가로채기 (window.fetch override).
//   2) /api/ path + Authorization 헤더 있는 요청 의 응답이 401 이면:
//      - localStorage 의 lumi_refresh 로 /api/auth-refresh 호출
//      - 성공 시 새 access + refresh 저장 → 원본 요청 재시도 (Authorization 만 갱신)
//      - 실패 시 401 그대로 통과 (페이지가 알아서 / redirect)
//   3) refresh 호출 자체는 중복 in-flight 차단 (동시 401 여러 개 → 한 번만 refresh).
//
// 사장님 결정 2026-05-17: 14일 access 만료 시 사장님 카카오 재로그인 불편 → 30일 refresh
//   토큰 도입. 한 달 이내 사용 시 끊김 없는 경험.
//
// 호환:
//   - 기존 user (lumi_refresh 없음): tryRefresh 실패 즉시 통과 → 기존 401 동작 그대로.
//   - 신규 user (lumi_refresh 있음): 401 시 자동 갱신 + 재요청 → 사장님 인지 X.

(function () {
  if (window.__lumiAuthFetchInstalled) return;
  window.__lumiAuthFetchInstalled = true;

  var origFetch = window.fetch.bind(window);
  var refreshInFlight = null;

  function getAccess() {
    try {
      return localStorage.getItem('lumi-auth')
        || localStorage.getItem('lumi_auth')
        || localStorage.getItem('seller_jwt')
        || '';
    } catch (_) { return ''; }
  }
  function getRefresh() {
    try { return localStorage.getItem('lumi_refresh') || ''; } catch (_) { return ''; }
  }
  function setAccess(access, refresh) {
    try {
      if (access) {
        localStorage.setItem('lumi-auth', access);
        localStorage.setItem('lumi_auth', access);
        localStorage.setItem('seller_jwt', access);
      }
      if (refresh) localStorage.setItem('lumi_refresh', refresh);
    } catch (_) {}
  }
  function clearAuth() {
    try {
      ['lumi-auth', 'lumi_auth', 'seller_jwt', 'lumi_refresh'].forEach(function (k) {
        localStorage.removeItem(k);
      });
    } catch (_) {}
  }

  function isApi(url) {
    if (!url) return false;
    if (url.indexOf('/api/') === 0) return true;
    if (url.indexOf('/api/') !== -1 && url.indexOf('://') !== -1 && url.indexOf('lumi.it.kr') !== -1) return true;
    if (url.indexOf('/.netlify/functions/') !== -1) return true;
    return false;
  }
  function isAuthRefresh(url) {
    return url && url.indexOf('/auth-refresh') !== -1;
  }

  async function tryRefresh() {
    var refresh = getRefresh();
    if (!refresh) return false;
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async function () {
      try {
        var r = await origFetch('/api/auth-refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: refresh }),
        });
        if (!r.ok) {
          // 401 / 410 등 — refresh 무효. 전체 auth clear.
          if (r.status === 401 || r.status === 410) clearAuth();
          return false;
        }
        var data = await r.json();
        if (data && data.access) {
          setAccess(data.access, data.refresh || null);
          return true;
        }
        return false;
      } catch (_) {
        return false;
      }
    })();
    var result;
    try { result = await refreshInFlight; }
    finally { refreshInFlight = null; }
    return result;
  }

  function buildHeadersWithAuth(initHeaders, accessToken) {
    var bearer = 'Bearer ' + accessToken;
    if (initHeaders instanceof Headers) {
      var copy = new Headers(initHeaders);
      copy.set('Authorization', bearer);
      return copy;
    }
    if (Array.isArray(initHeaders)) {
      var arr = initHeaders.filter(function (kv) { return kv[0].toLowerCase() !== 'authorization'; });
      arr.push(['Authorization', bearer]);
      return arr;
    }
    var obj = Object.assign({}, initHeaders || {});
    var authKey = Object.keys(obj).find(function (k) { return k.toLowerCase() === 'authorization'; });
    if (authKey) delete obj[authKey];
    obj['Authorization'] = bearer;
    return obj;
  }

  window.fetch = async function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!isApi(url) || isAuthRefresh(url)) {
      return origFetch(input, init);
    }
    var res = await origFetch(input, init);
    if (res.status !== 401) return res;

    var ok = await tryRefresh();
    if (!ok) return res;

    var newAccess = getAccess();
    if (!newAccess) return res;
    var newInit = Object.assign({}, init || {});
    newInit.headers = buildHeadersWithAuth(newInit.headers, newAccess);
    return origFetch(input, newInit);
  };
})();
