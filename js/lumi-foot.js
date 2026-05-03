/**
 * ============================================================
 * lumi-foot.js — 단일 정본 푸터 + 빠른 페이지 전환
 * ============================================================
 * 16개 페이지에 한 줄로 적용:
 *   <script src="/js/lumi-foot.js" defer></script>
 *
 * 자동 처리:
 *   1. /css/lumi-tokens.css + /css/lumi-foot.css 로드 (idempotent)
 *   2. 기존 <footer class="lumi-footer"> 또는 .lumi-foot 제거 후 새 마크업 삽입
 *   3. Speculation Rules API — 호버 시 다음 페이지 prerender (Chrome)
 *   4. View Transitions은 lumi-tokens.css 에서 자동 활성
 *
 * Meta 심사 영구 유지: 사업자정보·법적링크·데이터삭제·플랫폼정책 모두 포함.
 * 마크업 변경 시 /components/foot.html 도 동기 업데이트.
 * ============================================================
 */
(() => {
  'use strict';

  const TOKENS_HREF   = '/css/lumi-tokens.css';
  const FOOT_CSS_HREF = '/css/lumi-foot.css';

  /** 푸터 마크업 (정본은 /components/foot.html) */
  const FOOTER_HTML = `
<footer class="lumi-foot" role="contentinfo" data-lumi-foot>
  <div class="lumi-foot__bg" aria-hidden="true"></div>
  <div class="lumi-foot__inner">
    <div class="lumi-foot__brand">
      <a href="/" class="lumi-foot__logo" aria-label="lumi 홈"><span class="lumi-foot__logo-text">lumi</span></a>
      <p class="lumi-foot__tagline">사장님의 첫 AI 직원</p>
      <ul class="lumi-foot__contact" aria-label="연락처">
        <li><a href="tel:01064246284">010-6424-6284</a></li>
        <li><a href="mailto:gung3625@gmail.com">gung3625@gmail.com</a></li>
      </ul>
    </div>
    <nav class="lumi-foot__nav" aria-label="법적 정보">
      <ul class="lumi-foot__links">
        <li><a href="/terms">이용약관</a></li>
        <li><a href="/privacy">개인정보처리방침</a></li>
        <li><a href="/privacy#data-deletion">데이터 삭제 안내</a></li>
        <li><a href="/refund.html">환불정책</a></li>
        <li><a href="/support">고객지원</a></li>
      </ul>
    </nav>
    <div class="lumi-foot__biz" aria-label="사업자 정보">
      <dl class="lumi-foot__biz-list">
        <div><dt>대표</dt><dd>김현</dd></div>
        <div><dt>사업자등록번호</dt><dd>404-09-66416</dd></div>
        <div><dt>통신판매업</dt><dd>제2024-서울용산-1166호</dd></div>
        <div><dt>주소</dt><dd>서울특별시 용산구 회나무로 32-7 (이태원동) 04345</dd></div>
      </dl>
    </div>
    <div class="lumi-foot__bottom">
      <p class="lumi-foot__copy">© 2026 lumi. All rights reserved.</p>
      <p class="lumi-foot__notice">본 서비스는 <strong>Meta Platform Terms</strong> 및 <strong>Developer Policies</strong>를 준수합니다.</p>
    </div>
  </div>
</footer>`.trim();

  /** Speculation Rules — 호버 시 prerender, 보이는 링크 prefetch */
  const SPECULATION_RULES = {
    prerender: [{
      where: { and: [
        { href_matches: '/*' },
        { not: { href_matches: '/api/*' } },
        { not: { href_matches: '/.netlify/*' } },
        { not: { href_matches: '/*\\?logout' } }
      ] },
      eagerness: 'moderate'
    }],
    prefetch: [{
      where: { and: [
        { href_matches: '/*' },
        { not: { href_matches: '/api/*' } }
      ] },
      eagerness: 'eager'
    }]
  };

  function ensureCss(href, id) {
    if (document.getElementById(id)) return;
    if (document.querySelector(`link[rel="stylesheet"][href="${href}"]`)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }

  function ensureSpeculationRules() {
    if (document.querySelector('script[type="speculationrules"][data-lumi]')) return;
    try {
      if (HTMLScriptElement.supports && !HTMLScriptElement.supports('speculationrules')) {
        return; // 미지원 브라우저
      }
      const s = document.createElement('script');
      s.type = 'speculationrules';
      s.dataset.lumi = '1';
      s.textContent = JSON.stringify(SPECULATION_RULES);
      document.head.appendChild(s);
    } catch (e) { /* noop */ }
  }

  function injectFooter() {
    document
      .querySelectorAll('footer.lumi-footer, footer.lumi-foot, footer[data-lumi-foot]')
      .forEach(el => el.remove());

    const tpl = document.createElement('template');
    tpl.innerHTML = FOOTER_HTML;
    document.body.appendChild(tpl.content.firstChild);
  }

  function init() {
    ensureCss(TOKENS_HREF, 'lumi-tokens-css');
    ensureCss(FOOT_CSS_HREF, 'lumi-foot-css');
    ensureSpeculationRules();
    injectFooter();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
