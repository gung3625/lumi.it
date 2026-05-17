// beta.js — 베타 모집 페이지 폼 제출 처리.
// 휴대폰 자동 하이픈, 검증, /api/beta-signup POST, 완료 화면 토글.
(function () {
  const form = document.querySelector('[data-beta-form]');
  if (!form) return;

  const errorEl  = document.querySelector('[data-beta-error]');
  const submitBtn = document.querySelector('[data-beta-submit]');
  const doneEl   = document.querySelector('[data-beta-done]');
  const donePhoneEl = document.querySelector('[data-beta-done-phone]');
  const phoneEl  = document.querySelector('#beta-phone');

  // 휴대폰 자동 하이픈 (010-1234-5678 형식)
  if (phoneEl) {
    phoneEl.addEventListener('input', () => {
      const digits = phoneEl.value.replace(/[^0-9]/g, '').slice(0, 11);
      let formatted = digits;
      if (digits.length >= 4 && digits.length <= 7) {
        formatted = digits.slice(0, 3) + '-' + digits.slice(3);
      } else if (digits.length >= 8) {
        formatted = digits.slice(0, 3) + '-' + digits.slice(3, 7) + '-' + digits.slice(7);
      }
      phoneEl.value = formatted;
    });
  }

  function showError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.hidden = false;
    setTimeout(() => errorEl.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
  }
  function clearError() {
    if (errorEl) errorEl.hidden = true;
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    clearError();

    const fd = new FormData(form);
    const payload = {
      storeName: (fd.get('storeName') || '').trim(),
      ownerName: (fd.get('ownerName') || '').trim(),
      category:  (fd.get('category')  || '').trim(),
      phone:     (fd.get('phone')     || '').trim(),
      instagramHandle: (fd.get('instagramHandle') || '').trim(),
      termsAgreed: fd.get('termsAgreed') === 'on',
    };

    // 클라이언트 측 기본 검증 — 서버에서도 동일하게 검증
    if (!payload.storeName) return showError('매장 이름을 입력해주세요.');
    if (!payload.ownerName) return showError('대표자 이름을 입력해주세요.');
    if (!payload.category)  return showError('매장 카테고리를 선택해주세요.');
    if (!payload.phone)     return showError('휴대폰 번호를 입력해주세요.');
    if (!/^01[016789]-?\d{3,4}-?\d{4}$/.test(payload.phone)) return showError('휴대폰 형식이 올바르지 않아요. (예: 010-1234-5678)');
    if (!payload.termsAgreed) return showError('개인정보 수집·이용 동의가 필요해요.');

    submitBtn.disabled = true;
    submitBtn.classList.add('is-loading');
    submitBtn.textContent = '신청 중…';

    try {
      const res = await fetch('/api/beta-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data && data.ok) {
        // 완료 화면으로 전환
        form.hidden = true;
        if (donePhoneEl) donePhoneEl.textContent = payload.phone;
        if (doneEl) {
          doneEl.hidden = false;
          setTimeout(() => doneEl.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
        }
        return;
      }

      // 실패 — 서버 에러 메시지 또는 기본
      showError((data && data.error) || '신청에 실패했어요. 잠시 후 다시 시도해주세요.');
    } catch (e) {
      showError('네트워크 오류 — 잠시 후 다시 시도해주세요.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.classList.remove('is-loading');
      submitBtn.textContent = '베타 신청하기';
    }
  });
})();
