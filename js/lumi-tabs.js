/**
 * lumi-tabs.js — 모바일 하단 5탭 자동 삽입 + 활성 탭 감지
 * <script src="/js/lumi-tabs.js" defer></script> 한 줄로 끝.
 *
 * 자동 처리:
 *   1. /css/lumi-tabs.css 로드 (idempotent)
 *   2. 5탭 마크업 body 끝에 삽입 (idempotent)
 *   3. location.pathname 기반 활성 탭 자동 감지
 *   4. 등록 탭은 항상 시그니처 강조 (활성 여부 무관)
 *   5. 768px+ 숨김은 CSS가 처리
 */
(() => {
  'use strict';

  const TABS_CSS_HREF = '/css/lumi-tabs.css';

  const TABS_HTML = `
<nav class="lumi-tabs" data-lumi-tabs aria-label="메인 네비">

  <a href="/dashboard" class="lumi-tabs__item" data-tab="home">
    <svg class="lumi-tabs__icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
    <span class="lumi-tabs__label">홈</span>
  </a>

  <a href="/trends" class="lumi-tabs__item" data-tab="trends">
    <svg class="lumi-tabs__icon" viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
      <polyline points="17 6 23 6 23 12"/>
    </svg>
    <span class="lumi-tabs__label">트렌드</span>
  </a>

  <a href="/register-product" class="lumi-tabs__item lumi-tabs__item--cta" data-tab="register">
    <span class="lumi-tabs__cta-circle">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    </span>
    <span class="lumi-tabs__label">등록</span>
  </a>

  <a href="/reservations" class="lumi-tabs__item" data-tab="reservations">
    <svg class="lumi-tabs__icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/>
      <line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
    <span class="lumi-tabs__label">캘린더</span>
  </a>

  <a href="/settings" class="lumi-tabs__item" data-tab="settings">
    <svg class="lumi-tabs__icon" viewBox="0 0 24 24" aria-hidden="true">
      <line x1="3" y1="6" x2="21" y2="6"/>
      <line x1="3" y1="12" x2="21" y2="12"/>
      <line x1="3" y1="18" x2="21" y2="18"/>
    </svg>
    <span class="lumi-tabs__label">더보기</span>
  </a>

</nav>`.trim();

  /** 경로 → 탭 매핑 */
  const PATH_MAP = [
    { tab: 'home',         pattern: /^\/dashboard(\/|$)/ },
    { tab: 'trends',       pattern: /^\/trends(\/|$)/ },
    { tab: 'register',     pattern: /^\/register-product(\/|$)/ },
    { tab: 'reservations', pattern: /^\/reservations(\/|$)/ },
    { tab: 'settings',     pattern: /^\/settings(\/|$)/ },
  ];

  function ensureCss(href, id) {
    if (document.getElementById(id)) return;
    if (document.querySelector(`link[rel="stylesheet"][href="${href}"]`)) return;
    const link = document.createElement('link');
    link.id   = id;
    link.rel  = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }

  function injectTabs() {
    // idempotent: 이미 있으면 제거 후 재삽입
    document.querySelectorAll('[data-lumi-tabs]').forEach(el => el.remove());

    const tpl = document.createElement('template');
    tpl.innerHTML = TABS_HTML;
    document.body.appendChild(tpl.content);
  }

  function setActiveTab() {
    const path = location.pathname;
    const match = PATH_MAP.find(m => m.pattern.test(path));
    if (!match) return;

    const nav = document.querySelector('[data-lumi-tabs]');
    if (!nav) return;

    nav.querySelectorAll('.lumi-tabs__item').forEach(item => {
      if (item.dataset.tab === match.tab) {
        item.dataset.active = 'true';
        item.setAttribute('aria-current', 'page');
      }
    });
  }

  function init() {
    ensureCss(TABS_CSS_HREF, 'lumi-tabs-css');
    injectTabs();
    setActiveTab();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
