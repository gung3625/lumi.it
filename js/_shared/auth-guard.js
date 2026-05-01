// auth-guard.js — 보호 페이지 공통 인증 + 사업자 인증 완료 가드
// 사용법: <script src="/js/_shared/auth-guard.js"></script>
//   Supabase 클라이언트(window.lumiSupa)가 있는 페이지면 그것을 사용,
//   없는 페이지(orders/cs-inbox/tasks 등)는 localStorage 'lumi-auth' 키를 직접 파싱.
//
// ensureOnboarded() 호출 시:
//   1. 세션 없음 → /?m=1 (로그인 만료 메시지)
//   2. 세션 있지만 onboarded 미완료 → /signup
//   3. 세션 있고 onboarded 완료 → true 반환 (정상 진입)
//
// 성능: sessionStorage 캐시 (5분 TTL). 사업자 인증 완료 시 invalidateOnboardedCache() 호출.

(function () {
  'use strict';

  var CACHE_KEY = 'lumi_onboarded_cache';
  var CACHE_TTL = 5 * 60 * 1000; // 5분

  function isOnboardedMeta(meta) {
    return !!(meta && (meta.onboarded === true || (meta.business_no && meta.consent_terms)));
  }

  function readCache() {
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (Date.now() - obj.ts > CACHE_TTL) {
        sessionStorage.removeItem(CACHE_KEY);
        return null;
      }
      return obj;
    } catch (_) { return null; }
  }

  function writeCache(onboarded) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ onboarded: onboarded, ts: Date.now() }));
    } catch (_) {}
  }

  // 캐시 무효화 — signup 완료 후 호출
  function invalidateOnboardedCache() {
    try { sessionStorage.removeItem(CACHE_KEY); } catch (_) {}
  }

  /**
   * localStorage의 'lumi-auth' 키에서 Supabase 세션을 직접 파싱.
   * window.lumiSupa 없이도 동작 (orders/cs-inbox/tasks 등).
   */
  function parseStoredSession() {
    try {
      var raw = localStorage.getItem('lumi-auth');
      if (!raw) return null;
      var obj = JSON.parse(raw);
      // Supabase v2 storage 포맷: { currentSession: { access_token, user, ... } }
      // 또는 직접 { access_token, user, ... }
      var session = obj && (obj.currentSession || obj);
      if (session && session.access_token && session.user) return session;
      return null;
    } catch (_) { return null; }
  }

  /**
   * Supabase 클라이언트 경유 또는 localStorage 직접 파싱으로 세션 취득.
   * @returns {Promise<object|null>}
   */
  async function getSessionSafe() {
    // 1. lumiSupa 클라이언트 경유 (가장 신뢰도 높음)
    if (window.lumiSupa) {
      try {
        var result = await window.lumiSupa.auth.getSession();
        var session = result && result.data && result.data.session;
        if (session && session.access_token) return session;
      } catch (_) {}
    }
    // 2. localStorage 직접 파싱 폴백 (lumiSupa 없는 페이지)
    return parseStoredSession();
  }

  /**
   * 보호 페이지 진입 시 호출.
   * @returns {Promise<boolean>} true = 정상 진입, false = 리다이렉트 발생 (페이지 초기화 중단 필요)
   */
  async function ensureOnboarded() {
    // 1. localStorage 게이트 (빠른 비로그인 차단, 왕복 없음)
    var hasStoredAuth = false;
    try { hasStoredAuth = !!localStorage.getItem('lumi-auth'); } catch (_) {}
    if (!hasStoredAuth) {
      window.location.replace('/?m=1');
      return false;
    }

    // 2. sessionStorage 캐시 히트 (반복 API 콜 방지)
    var cached = readCache();
    if (cached !== null) {
      if (cached.onboarded) return true;
      window.location.replace('/signup');
      return false;
    }

    // 3. 세션 취득 (lumiSupa or localStorage 파싱)
    var session = await getSessionSafe();

    if (!session || !session.access_token) {
      // grace period — 토큰 처리 지연 가능성 1초 대기 후 재시도
      await new Promise(function (r) { setTimeout(r, 1000); });
      session = await getSessionSafe();
      if (!session || !session.access_token) {
        window.location.replace('/?m=1');
        return false;
      }
    }

    // 4. user_metadata에서 onboarded 체크
    var meta = (session.user && session.user.user_metadata) || {};
    var onboarded = isOnboardedMeta(meta);
    writeCache(onboarded);

    if (!onboarded) {
      window.location.replace('/signup');
      return false;
    }
    return true;
  }

  window.lumiAuthGuard = {
    ensureOnboarded: ensureOnboarded,
    invalidateOnboardedCache: invalidateOnboardedCache,
  };
})();
