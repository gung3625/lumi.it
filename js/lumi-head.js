/**
 * lumi-head.js — 단일 정본 헤더 자동 삽입
 * <script src="/js/lumi-head.js" defer></script> 한 줄로 끝.
 * 마크업 변경 시 /components/head.html 동기.
 */
(() => {
  'use strict';

  const TOKENS_HREF   = '/css/lumi-tokens.css';
  const HEAD_CSS_HREF = '/css/lumi-head.css';

  const HEADER_HTML = `
<header class="lumi-head" data-lumi-head>
  <div class="lumi-head__inner">
    <a href="/" class="lumi-head__logo" aria-label="lumi 홈">
      <img src="/assets/logo-wordmark.png" alt="lumi" width="50" height="24" loading="eager" decoding="sync" />
    </a>

    <nav class="lumi-head__nav" aria-label="메인 네비">
      <ul class="lumi-head__links">
        <li><a href="/guide">기능 안내</a></li>
        <li><a href="/pricing">요금제</a></li>
        <li><a href="/support">고객지원</a></li>
      </ul>
    </nav>

    <div class="lumi-head__actions">
      <a href="/signup" class="lumi-head__login">로그인</a>
      <a href="/signup" class="lumi-head__cta">회원가입</a>
      <button type="button" class="lumi-head__burger" aria-label="메뉴 열기" aria-expanded="false" aria-controls="lumi-drawer">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
      </button>
    </div>
  </div>
</header>

<div class="lumi-head__drawer" id="lumi-drawer" data-lumi-drawer aria-hidden="true">
  <div class="lumi-head__drawer-top">
    <span class="lumi-head__logo">
      <img src="/assets/logo-wordmark.png" alt="lumi" width="50" height="24" loading="eager" decoding="sync" />
    </span>
    <button type="button" class="lumi-head__burger" data-lumi-drawer-close aria-label="메뉴 닫기">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6l-12 12"/></svg>
    </button>
  </div>
  <ul class="lumi-head__drawer-list">
    <li><a href="/guide">기능 안내</a></li>
    <li><a href="/pricing">요금제</a></li>
    <li><a href="/support">고객지원</a></li>
    <li><a href="/signup">로그인</a></li>
  </ul>
  <a href="/signup" class="lumi-head__drawer-cta">회원가입</a>
</div>`.trim();

  function ensureCss(href, id) {
    if (document.getElementById(id)) return;
    if (document.querySelector(`link[rel="stylesheet"][href="${href}"]`)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }

  function injectHeader() {
    // 정적 마크업이 이미 있으면 주입 스킵
    if (document.querySelector('[data-lumi-head]')) return;
    // fallback: 동적 주입 (옛 페이지 호환)
    document.querySelectorAll('header[data-lumi-head], .lumi-head, [data-lumi-drawer]')
      .forEach(el => el.remove());
    const tpl = document.createElement('template');
    tpl.innerHTML = HEADER_HTML;
    document.body.insertBefore(tpl.content, document.body.firstChild);
  }

  /**
   * 로그인 여부 감지 — auth-guard.js 의 hasAnyStoredAuth() 와 동일한 패턴.
   * 카카오 가입자는 lumi_token (HS256) 만 있고 Supabase 세션 없으므로 이 키들을 우선 본다.
   */
  function isAuthed() {
    try {
      if (localStorage.getItem('lumi_token')) return true;
      if (localStorage.getItem('lumi_seller_jwt')) return true;
      if (localStorage.getItem('lumi-auth')) return true;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf('sb-') === 0 && k.indexOf('-auth-token') > 0) return true;
      }
    } catch (_) {}
    return false;
  }

  function logout() {
    try {
      localStorage.removeItem('lumi_token');
      localStorage.removeItem('lumi_seller_jwt');
      localStorage.removeItem('lumi_seller_token');
      localStorage.removeItem('lumi-auth');
      sessionStorage.removeItem('lumi_token');
      sessionStorage.removeItem('lumi_onboarded_cache');
      // Supabase v2 sb-*-auth-token 키 정리
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf('sb-') === 0 && k.indexOf('-auth-token') > 0) toRemove.push(k);
      }
      toRemove.forEach((k) => localStorage.removeItem(k));
    } catch (_) {}
    window.location.href = '/';
  }

  /** 로그인 상태면 헤더의 로그인/회원가입 버튼을 대시보드/로그아웃 으로 교체 */
  function applyAuthState() {
    if (!isAuthed()) return;

    // 데스크톱 actions 영역
    const head = document.querySelector('[data-lumi-head]');
    if (head) {
      const login = head.querySelector('.lumi-head__login');
      const cta   = head.querySelector('.lumi-head__cta');
      if (login) {
        login.textContent = '대시보드';
        login.setAttribute('href', '/dashboard');
      }
      if (cta) {
        cta.textContent = '로그아웃';
        cta.setAttribute('href', '#');
        cta.setAttribute('role', 'button');
        cta.addEventListener('click', (e) => { e.preventDefault(); logout(); });
      }
    }

    // 모바일 drawer
    const drawer = document.querySelector('[data-lumi-drawer]');
    if (drawer) {
      const list = drawer.querySelector('.lumi-head__drawer-list');
      if (list) {
        // "로그인" 항목 → "대시보드"
        list.querySelectorAll('a').forEach((a) => {
          if (a.getAttribute('href') === '/signup' && /로그인/.test(a.textContent)) {
            a.textContent = '대시보드';
            a.setAttribute('href', '/dashboard');
          }
        });
      }
      const drawerCta = drawer.querySelector('.lumi-head__drawer-cta');
      if (drawerCta) {
        drawerCta.textContent = '로그아웃';
        drawerCta.setAttribute('href', '#');
        drawerCta.setAttribute('role', 'button');
        drawerCta.addEventListener('click', (e) => { e.preventDefault(); logout(); });
      }
    }
  }

  function bindInteractions() {
    const head = document.querySelector('[data-lumi-head]');
    const drawer = document.querySelector('[data-lumi-drawer]');
    if (!head || !drawer) return;

    const burger = head.querySelector('.lumi-head__burger');
    const closeBtn = drawer.querySelector('[data-lumi-drawer-close]');

    const openDrawer = () => {
      drawer.dataset.open = 'true';
      drawer.setAttribute('aria-hidden', 'false');
      burger?.setAttribute('aria-expanded', 'true');
      document.documentElement.style.overflow = 'hidden';
    };
    const closeDrawer = () => {
      drawer.dataset.open = 'false';
      drawer.setAttribute('aria-hidden', 'true');
      burger?.setAttribute('aria-expanded', 'false');
      document.documentElement.style.overflow = '';
    };

    burger?.addEventListener('click', openDrawer);
    closeBtn?.addEventListener('click', closeDrawer);
    drawer.querySelectorAll('a').forEach(a => a.addEventListener('click', closeDrawer));

    // 스크롤 시 hairline 등장
    let scrolled = false;
    const onScroll = () => {
      const isScrolled = window.scrollY > 8;
      if (isScrolled !== scrolled) {
        scrolled = isScrolled;
        head.classList.toggle('is-scrolled', isScrolled);
      }
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    // ESC 닫기
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && drawer.dataset.open === 'true') closeDrawer();
    });
  }

  function init() {
    ensureCss(TOKENS_HREF, 'lumi-tokens-css');
    ensureCss(HEAD_CSS_HREF, 'lumi-head-css');
    injectHeader();
    bindInteractions();
    applyAuthState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
