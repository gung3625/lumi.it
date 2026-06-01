// haptic.js — lumi 전역 프레스 햅틱 (토스급 마이크로 인터랙션)
//
// 목적: 버튼·탭·CTA·링크 탭 시 아주 짧은 진동(8ms)으로 "눌렀다"는 물리 보상감.
//       토스처럼 손끝에서 즉각 반응하는 느낌.
//
// 방식: document 레벨 단일 pointerdown 리스너 (이벤트 위임 — 동적 요소도 자동 커버).
//       클릭이 아니라 pointerdown 으로 눌리는 "순간" 진동 (체감 지연 최소).
//
// 가드:
//   - prefers-reduced-motion: reduce → 진동 안 함 (접근성/멀미 존중).
//   - navigator.vibrate 미지원 (iOS Safari) → try-catch 로 조용히 무시.
//   - 비활성(disabled / aria-disabled) 요소는 진동 안 함.
//
// 의존: 없음 (순수 JS, 외부 라이브러리 0). CSP script-src 'self' 통과.

(function () {
  'use strict';

  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') {
    return; // vibrate 미지원 (iOS Safari 등) — graceful no-op
  }

  // reduce 선호 시 진동 off. matchMedia 가 라이브로 바뀔 수 있어 매번 확인.
  var reduceMQ = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');

  // 햅틱 대상 — 주요 인터랙션 요소. closest() 로 자식(아이콘 svg 등) 클릭도 커버.
  var HAPTIC_SELECTOR = [
    'button',
    '.cta',
    '.cta-button',
    '.cta-primary',
    '.cta-secondary',
    '[role="button"]',
    '.tab',
    '.tab-add',
    '.media-tab',
    '.cat-tab',
    '.major-tab',
    '.schedule-card',
    '.story-toggle',
    '.chip',
    '.sheet__chip',
    'a.beta__kakao-cta',
    '.oauth-button',
    '.skip'
  ].join(',');

  function isDisabled(el) {
    if (el.disabled) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    return false;
  }

  function onPointerDown(e) {
    // 주 포인터(왼쪽 버튼/터치)만 — 우클릭·보조 포인터 제외
    if (e.button != null && e.button !== 0) return;
    if (reduceMQ && reduceMQ.matches) return;

    var target = e.target;
    if (!target || typeof target.closest !== 'function') return;
    var el = target.closest(HAPTIC_SELECTOR);
    if (!el || isDisabled(el)) return;

    try {
      navigator.vibrate(8);
    } catch (_) {
      /* 일부 브라우저 정책상 throw — 조용히 무시 */
    }
  }

  // passive: pointerdown 만 듣고 preventDefault 안 하므로 passive 로 스크롤 성능 보존
  document.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true });
})();
