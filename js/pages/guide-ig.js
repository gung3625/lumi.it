// guide-ig.js — 인스타 연결 가이드 페이지 (2026-05-21).
// 핵심 기능: "루미 팀에 도움 요청" 버튼 → /api/request-ig-help 호출.
// 로그인 X 상태도 가이드는 그대로 볼 수 있음 (가이드 페이지는 public).

(function () {
  const token =
    localStorage.getItem('lumi-auth') ||
    localStorage.getItem('lumi_auth') ||
    localStorage.getItem('seller_jwt') || '';

  const helpBtn = document.querySelector('[data-request-help]');
  const helpHint = document.querySelector('[data-help-hint]');

  if (helpBtn) {
    helpBtn.addEventListener('click', async () => {
      if (!token) {
        // 로그인 안 됨 — 안내 표시
        if (helpHint) helpHint.hidden = false;
        return;
      }
      const original = helpBtn.textContent;
      helpBtn.disabled = true;
      helpBtn.textContent = '보내는 중…';
      try {
        const r = await fetch('/api/request-ig-help', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stage: 'other',
            userSelectedReason: 'all-done-still-fails',
            message: '가이드 페이지에서 도움 요청',
            contextUrl: location.href,
          }),
        });
        if (r.ok) {
          helpBtn.textContent = '✓ 보냈어요. 1시간 안에 카톡으로 연락드릴게요';
          helpBtn.classList.add('is-sent');
        } else {
          helpBtn.textContent = '요청 실패 — 다시 시도해주세요';
          helpBtn.disabled = false;
        }
      } catch (e) {
        helpBtn.textContent = '네트워크 오류 — 다시 시도해주세요';
        helpBtn.disabled = false;
      }
      // 5초 후 원래대로 (사용자가 다시 누를 수 있게)
      setTimeout(() => {
        if (helpBtn.classList.contains('is-sent')) return;  // 성공 상태는 유지
        helpBtn.textContent = original;
        helpBtn.disabled = false;
      }, 5000);
    });
  }

  // "루미와 연결하러 가기" 버튼 — 로그인 안 됐으면 / 로 (로그인 페이지)
  const goSettings = document.querySelector('[data-go-settings]');
  if (goSettings) {
    goSettings.addEventListener('click', (e) => {
      if (!token) {
        e.preventDefault();
        location.href = '/';
      }
      // 토큰 있으면 그대로 /settings 로 이동 (href 그대로)
    });
  }
})();
