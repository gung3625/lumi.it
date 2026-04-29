// OAuth 재방문 시 seller-jwt 복원 헬퍼
// 사용법: <script src="/js/_shared/restore-seller-jwt.js"></script>
// 메인 JS 로드 전 실행 — DOMContentLoaded 이전에도 동작
(function () {
  'use strict';

  /**
   * seller-jwt가 없으면 Supabase 세션 토큰으로 /api/me를 호출해서 복원.
   * @returns {Promise<void>}
   */
  window.ensureSellerJwt = async function ensureSellerJwt() {
    try {
      if (localStorage.getItem('lumi_seller_jwt')) return;
    } catch (_) { return; }

    // Supabase 세션 토큰 획득
    let supaToken = null;
    try {
      const client = window.lumiSupa || null;
      if (client) {
        const { data } = await client.auth.getSession();
        supaToken = data && data.session && data.session.access_token;
      }
      // lumiSupa 없으면 localStorage에서 Supabase 세션 키 탐색
      if (!supaToken) {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith('sb-') && k.endsWith('-auth-token')) {
            try {
              const parsed = JSON.parse(localStorage.getItem(k));
              if (parsed && parsed.access_token) { supaToken = parsed.access_token; break; }
            } catch (_) {}
          }
        }
      }
    } catch (_) {}

    if (!supaToken) return;

    try {
      const res = await fetch('/api/me', {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + supaToken },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.success && data.sellerToken) {
        try {
          localStorage.setItem('lumi_seller_jwt', data.sellerToken);
          localStorage.setItem('lumi_seller_token', data.sellerToken);
          localStorage.setItem('lumi_token', data.sellerToken);
        } catch (_) {}
      }
    } catch (_) {}
  };

  // 페이지 로드 시 자동 실행
  window.ensureSellerJwt();
})();
