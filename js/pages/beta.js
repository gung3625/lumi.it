// beta.js — 베타 카카오 가입 진입 페이지.
// 약관 동의 체크 → 카카오 가입 버튼 활성화 → /api/auth/kakao/start 로 이동.
// 이전 (관심 표명 폼 + /api/beta-signup) 은 폐기 — 가입 단계로 격상.
(function () {
  const checkbox = document.querySelector('[data-beta-terms]');
  const cta = document.querySelector('[data-beta-kakao]');
  const errorEl = document.querySelector('[data-beta-error]');

  if (!checkbox || !cta) return;

  function clearError() {
    if (errorEl) errorEl.hidden = true;
  }
  function showError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }

  function syncCtaState() {
    if (checkbox.checked) {
      cta.removeAttribute('aria-disabled');
      cta.classList.add('is-active');
    } else {
      cta.setAttribute('aria-disabled', 'true');
      cta.classList.remove('is-active');
    }
  }

  checkbox.addEventListener('change', () => {
    clearError();
    syncCtaState();
  });
  syncCtaState();

  cta.addEventListener('click', (ev) => {
    if (!checkbox.checked) {
      ev.preventDefault();
      showError('이용약관·개인정보처리방침 동의가 필요합니다.');
      checkbox.focus();
      checkbox.closest('.beta__checkbox')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    // 동의됐으면 a href 그대로 따라감 (/api/auth/kakao/start)
  });
})();
