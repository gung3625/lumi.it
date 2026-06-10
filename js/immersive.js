// js/immersive.js — 몰입 레이어 R1 (2026-06-10, 사장님 지시 "몰입형 UI/UX + 마이크로 인터랙션")
//
// 1) 스크롤 리빌: 스크롤로 만나는 섹션·카드가 떠오르며 등장 (.rv → .rv-in, motion.css).
//    그리드([role=list]·*-grid·*-bignums 등)는 자식 카드 단위 스태거.
// 2) 카운트업: index 증명 숫자가 보이는 순간 0 → 실제 값으로 차오름.
//
// 안전 원칙:
//  - reduced-motion / IntersectionObserver 미지원 → 즉시 종료 (.rv 미부여 = 항상 보임).
//  - 인라인 style 속성 미사용 — 클래스 + CSSOM(setProperty)만 (CSP unsafe-inline 금지 준수).
//  - 첫 화면(히어로)은 각 페이지 자체 입장 안무가 있어 제외 — 스크롤 영역만.
//  - transform/opacity 만 사용, 리빌 후 unobserve (배터리).
(function () {
  'use strict';
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!('IntersectionObserver' in window)) return;

  var STAGGER_MS = 70;       // 그룹 내 카드 간 지연
  var STAGGER_MAX_MS = 420;  // 지연 상한 (긴 목록 끝 카드가 너무 늦지 않게)

  // ── 스크롤 리빌 ──────────────────────────────
  var io = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e.isIntersecting) continue;
      e.target.classList.add('rv-in');
      io.unobserve(e.target);
    }
  }, { threshold: 0.08, rootMargin: '0px 0px -6% 0px' });

  function arm(el, delayMs) {
    if (!el || el.classList.contains('rv')) return false;
    // 이미 뷰포트 안(첫 화면)에 있는 요소는 건드리지 않음 — 진입 페인트 지연 방지.
    var r = el.getBoundingClientRect();
    if (r.top < window.innerHeight * 0.9) return false;
    // 자체 CSS 애니메이션 보유 컴포넌트(벤토 bento-rise/breathe 등)는 제외 —
    // 이중 안무 + transform 충돌(애니메이션이 transition transform 을 항상 이김) 방지.
    if (getComputedStyle(el).animationName !== 'none') return false;
    el.classList.add('rv');
    if (delayMs) el.style.setProperty('--rv-delay', Math.min(delayMs, STAGGER_MAX_MS) + 'ms');
    io.observe(el);
    return true;
  }

  // 그룹(그리드) 판별 — 자식 단위 스태거 대상
  function isStaggerGroup(el) {
    if (el.getAttribute && el.getAttribute('role') === 'list') return true;
    var c = ' ' + (el.className || '') + ' ';
    return /-grid\s|-bignums\s|-cards\s|-chips\s/.test(c);
  }

  function armSection(section) {
    var kids = section.children;
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i];
      if (kid.tagName === 'SCRIPT' || kid.tagName === 'STYLE') continue;
      if (isStaggerGroup(kid)) {
        var cards = kid.children;
        for (var j = 0; j < cards.length; j++) {
          // hover-lift 도 arm 성공(=자체 애니메이션 없음) 카드만 — transform 충돌 방지.
          if (arm(cards[j], j * STAGGER_MS) &&
              (cards[j].tagName === 'ARTICLE' || cards[j].tagName === 'DIV')) {
            cards[j].classList.add('hover-lift');
          }
        }
      } else {
        arm(kid, Math.min(i, 2) * 60);
      }
    }
  }

  function init() {
    // 마케팅·일반 페이지: main 안 섹션 (히어로 제외).
    // dashboard 처럼 <a> 로 감싼 섹션도 포함 (R2 — 앵커 래핑 누락 수정).
    var sections = document.querySelectorAll('main > section:not(.hero), main > a > section');
    for (var i = 0; i < sections.length; i++) armSection(sections[i]);

    // 앱 페이지: 섹션 제목 + 정적 카드 (동적 렌더 목록은 제외 — 각자 패턴 유지)
    var appBits = document.querySelectorAll('.section-title, .card, .ig-card, .tone-card, .lt-intro, .lt-edit');
    for (var k = 0; k < appBits.length; k++) arm(appBits[k], 0);

    initCountUp();
  }

  // ── 카운트업 (index 증명 숫자) ───────────────
  // "1,247" / "+12" / "30분" / "0건" 형태 — 숫자부만 차오르고 접두/접미는 유지.
  function initCountUp() {
    var els = document.querySelectorAll('.dashpv-bignum__num, .dashpv-stat__val');
    if (!els.length) return;
    var cio = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e.isIntersecting) continue;
        cio.unobserve(e.target);
        runCountUp(e.target);
      }
    }, { threshold: 0.5 });
    for (var i = 0; i < els.length; i++) cio.observe(els[i]);
  }

  function runCountUp(el) {
    var raw = (el.textContent || '').trim();
    var m = raw.match(/^([^0-9]*?)([\d,]+)(.*)$/);
    if (!m) return;
    var prefix = m[1];
    var target = parseInt(m[2].replace(/,/g, ''), 10);
    var suffix = m[3];
    var useComma = m[2].indexOf(',') !== -1;
    if (!isFinite(target) || target <= 0) return;

    // 카운트 중 폭 줄어듦으로 인한 레이아웃 흔들림 방지
    el.style.setProperty('min-width', el.offsetWidth + 'px');
    var DURATION = 900;
    var start = null;
    function frame(ts) {
      if (start === null) start = ts;
      var p = Math.min(1, (ts - start) / DURATION);
      var eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      var val = Math.round(target * eased);
      el.textContent = prefix + (useComma ? val.toLocaleString('ko-KR') : String(val)) + suffix;
      if (p < 1) {
        requestAnimationFrame(frame);
      } else {
        el.style.removeProperty('min-width');
      }
    }
    requestAnimationFrame(frame);
  }

  // 동적 숫자 카운트업 — 페이지 스크립트가 값 채운 직후 호출 (dashboard 통계 등).
  // 모션 비활성 환경에선 이 IIFE 자체가 종료돼 미정의 → 호출부는 존재 체크 후 사용.
  window.lumiCountUp = runCountUp;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
