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
    document.querySelectorAll('header[data-lumi-head], .lumi-head, [data-lumi-drawer]')
      .forEach(el => el.remove());

    const tpl = document.createElement('template');
    tpl.innerHTML = HEADER_HTML;
    document.body.insertBefore(tpl.content, document.body.firstChild);
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
