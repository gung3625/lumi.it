// haptic.js — lumi 프레스 햅틱 (토스 실측 기준)
//
// 토스 모션 원칙 (toss.tech 1차 확인): 햅틱은 "모든 버튼"이 아니라
// 완료·확정·주요 CTA 같은 "의미 있는 확정 순간"에만 점적으로 쓴다.
// → 탐색 탭·칩·일반 버튼엔 진동 X (절제). 주요 행동(가입·연동·게시·다음단계)에만.
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

  // 햅틱 대상 — 완료·확정·주요 CTA 만 (토스 절제 원칙).
  // 탐색 탭(.tab/.major-tab/.cat-tab)·칩(.chip)·일반 button 은 제외 — 진동 남발 방지.
  // closest() 로 자식(아이콘 svg 등) 클릭도 커버.
  var HAPTIC_SELECTOR = [
    '.cta',              // 주요 CTA (가입·시작)
    '.cta-button',
    '.cta-primary',
    '.cta-secondary',
    'a.beta__kakao-cta', // 카카오 가입 (확정)
    '.oauth-button',     // 인스타·쓰레드 연동 (확정)
    '[data-ig-connect]', // 인스타 연동
    '[data-threads-connect]',
    '[data-go-dashboard]', // 가입 완료
    '[data-next]'        // 가입 단계 진행 (확정)
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
