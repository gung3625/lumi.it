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
    // 다양한 storage 키 시도 — 'lumi-auth' 우선, 없으면 Supabase 기본 키 패턴
    var candidates = [];
    try {
      var v = localStorage.getItem('lumi-auth');
      if (v) candidates.push(v);
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('sb-') === 0 && k.indexOf('-auth-token') > 0) {
          var sv = localStorage.getItem(k);
          if (sv) candidates.push(sv);
        }
      }
    } catch (_) {}

    for (var j = 0; j < candidates.length; j++) {
      try {
        var obj = JSON.parse(candidates[j]);
        // Supabase v2 storage 포맷: { currentSession: { access_token, user, ... } }
        // 또는 직접 { access_token, user, ... }
        var session = obj && (obj.currentSession || obj);
        if (session && session.access_token && session.user) return session;
      } catch (_) { /* 다음 후보 */ }
    }
    return null;
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
  // 다양한 storage 키를 체크 — Supabase 기본 키, 커스텀 'lumi-auth', 'lumi_token' 등
  function hasAnyStoredAuth() {
    try {
      if (localStorage.getItem('lumi-auth')) return true;
      if (localStorage.getItem('lumi_token')) return true;
      // Supabase v2 기본 키 패턴
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && (k.indexOf('sb-') === 0 && k.indexOf('-auth-token') > 0)) return true;
      }
    } catch (_) {}
    return false;
  }

  // URL에 OAuth 콜백 토큰이 있는지 (magic link, recovery, signup 등 hash/query)
  function hasUrlAuthCallback() {
    try {
      var hash = window.location.hash || '';
      var search = window.location.search || '';
      if (hash.indexOf('access_token=') !== -1) return true;
      if (hash.indexOf('refresh_token=') !== -1) return true;
      if (hash.indexOf('type=magiclink') !== -1) return true;
      if (hash.indexOf('type=recovery') !== -1) return true;
      if (hash.indexOf('type=signup') !== -1) return true;
      if (search.indexOf('code=') !== -1 && search.indexOf('state=') !== -1) return true;
    } catch (_) {}
    return false;
  }

  async function ensureOnboarded() {
    // 0. URL에 OAuth 콜백 토큰이 있으면 Supabase 처리 대기 (race condition 방지)
    //    magic link 처리 → localStorage 저장까지 시간 필요
    if (hasUrlAuthCallback()) {
      // Supabase가 처리할 시간 — 최대 3초 폴링
      for (var i = 0; i < 30; i++) {
        if (hasAnyStoredAuth()) break;
        await new Promise(function (r) { setTimeout(r, 100); });
      }
    }

    // 1. localStorage 게이트 (빠른 비로그인 차단, 왕복 없음)
    //    여러 storage 키를 모두 체크 (페이지마다 다른 키 사용 가능성)
    if (!hasAnyStoredAuth()) {
      window.location.replace('/signup');
      return false;
    }

    // 2. sessionStorage 캐시 히트 (반복 API 콜 방지)
    var cached = readCache();
    if (cached !== null) {
      if (cached.onboarded) return true;
      window.location.replace('/signup');
      return false;
    }

    // 3. 토큰 우선 확인 — 카카오 가입자는 lumi_token (HS256) 만 있고 Supabase 세션 없음.
    //    Supabase 세션 강제 요구 시 카카오 사용자가 무조건 /signup 으로 튕김 → 버그.
    //    따라서 lumi_token / lumi_seller_jwt 가 있으면 Supabase 세션 체크를 생략하고
    //    바로 /api/me 검증으로 넘어간다.
    var token = null;
    try {
      token = localStorage.getItem('lumi_token') ||
              localStorage.getItem('lumi_seller_jwt') ||
              sessionStorage.getItem('lumi_token');
    } catch (_) {}

    // 4. lumi_token 이 없을 때만 Supabase 세션 fallback (Google OAuth 등)
    if (!token) {
      var session = await getSessionSafe();
      if (!session || !session.access_token) {
        // grace period — 토큰 처리 지연 가능성 1초 대기 후 재시도
        await new Promise(function (r) { setTimeout(r, 1000); });
        session = await getSessionSafe();
        if (!session || !session.access_token) {
          window.location.replace('/signup');
          return false;
        }
      }

      // user_metadata 에서 onboarded 체크 (Google 가입자 일부 케이스)
      var meta = (session.user && session.user.user_metadata) || {};
      if (isOnboardedMeta(meta)) {
        writeCache(true);
        return true;
      }

      token = session.access_token;
    }

    if (!token) {
      writeCache(false);
      window.location.replace('/signup');
      return false;
    }

    try {
      var r = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) {
        writeCache(false);
        window.location.replace('/signup');
        return false;
      }
      var d = await r.json();
      // 탈퇴 유예 중인 회원도 페이지 진입 허용 + 상단 배너로 복구 옵션 노출
      if (d && d.seller && d.seller.deletionPending) {
        try { showDeletionBanner(d.seller, token); } catch (_) {}
      }
      if (d && d.seller && d.seller.onboarded) {
        writeCache(true);
        return true;
      }
      // 미온보딩
      writeCache(false);
      window.location.replace('/signup');
      return false;
    } catch (_) {
      writeCache(false);
      window.location.replace('/signup');
      return false;
    }
  }

  // ─── 30일 유예 회원 탈퇴 — sticky 복구 배너 ───
  // /api/me 응답 deletionPending=true 면 상단에 배너 자동 삽입.
  // 배너 ID `lumi-deletion-banner` 로 중복 삽입 방지.
  function showDeletionBanner(seller, token) {
    if (document.getElementById('lumi-deletion-banner')) return;
    var scheduledAt = seller && seller.deletionScheduledAt;
    if (!scheduledAt) return;

    var msUntil = new Date(scheduledAt).getTime() - Date.now();
    var daysLeft = Math.max(0, Math.ceil(msUntil / (1000 * 60 * 60 * 24)));

    var banner = document.createElement('div');
    banner.id = 'lumi-deletion-banner';
    banner.setAttribute('role', 'alert');
    banner.style.cssText = [
      'position:sticky',
      'top:0',
      'left:0',
      'right:0',
      'z-index:9999',
      'background:#C8507A',
      'color:#fff',
      'padding:10px 16px',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'gap:12px',
      'flex-wrap:wrap',
      "font-family:'Pretendard',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
      'font-size:14px',
      'font-weight:500',
      'line-height:1.4',
      'box-shadow:0 1px 4px rgba(0,0,0,.12)',
    ].join(';');

    var msg = document.createElement('span');
    msg.textContent = '회원 탈퇴 진행 중 — ' + daysLeft + '일 후 자동 삭제됩니다.';
    msg.style.cssText = 'flex:1 1 auto;min-width:0;text-align:center;';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '복구하기';
    btn.style.cssText = [
      'flex:0 0 auto',
      'padding:6px 16px',
      'background:#fff',
      'color:#C8507A',
      'border:none',
      'border-radius:980px',
      'font-size:13px',
      'font-weight:700',
      'cursor:pointer',
      "font-family:inherit",
    ].join(';');
    btn.addEventListener('click', async function () {
      btn.disabled = true;
      btn.textContent = '복구 중...';
      try {
        var resp = await fetch('/api/account-restore', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token,
          },
        });
        if (!resp.ok) {
          var data = {};
          try { data = await resp.json(); } catch (_) {}
          alert((data && data.error) || '복구에 실패했어요. 잠시 후 다시 시도해주세요.');
          btn.disabled = false;
          btn.textContent = '복구하기';
          return;
        }
        alert('계정이 복구되었어요. 모든 데이터가 그대로 유지됩니다.');
        location.reload();
      } catch (e) {
        alert('네트워크 오류가 발생했어요. 잠시 후 다시 시도해주세요.');
        btn.disabled = false;
        btn.textContent = '복구하기';
      }
    });

    banner.appendChild(msg);
    banner.appendChild(btn);

    if (document.body) {
      document.body.insertBefore(banner, document.body.firstChild);
    } else {
      document.addEventListener('DOMContentLoaded', function () {
        if (!document.getElementById('lumi-deletion-banner')) {
          document.body.insertBefore(banner, document.body.firstChild);
        }
      });
    }
  }

  window.lumiAuthGuard = {
    ensureOnboarded: ensureOnboarded,
    invalidateOnboardedCache: invalidateOnboardedCache,
    showDeletionBanner: showDeletionBanner,
  };
})();
