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

  // "이제 루미와 연결하기" 버튼 — POST /api/ig-oauth 로 OAuth 시작 URL 받아 redirect.
  // (signup.js 의 startOAuth 와 동일한 패턴 — JWT POST body, 응답 url 로 이동)
  const igConnectBtn = document.querySelector('[data-ig-connect-now]');
  const igConnectErr = document.querySelector('[data-ig-connect-error]');
  function showIgErr(msg) {
    if (igConnectErr) {
      igConnectErr.textContent = msg;
      igConnectErr.hidden = false;
    }
  }
  if (igConnectBtn) {
    igConnectBtn.addEventListener('click', async () => {
      if (!token) {
        // 로그인 안 된 상태 — 베타 페이지로 보내서 카카오 가입 유도
        location.href = '/beta';
        return;
      }
      const original = igConnectBtn.textContent;
      igConnectBtn.disabled = true;
      igConnectBtn.textContent = '연결 화면 여는 중…';
      if (igConnectErr) igConnectErr.hidden = true;
      try {
        const r = await fetch('/api/ig-oauth', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, return_to: '/dashboard' }),
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.url) {
          location.href = j.url;  // 페이스북 OAuth 화면으로
          return;
        }
        showIgErr((j && j.error) || '연결 화면을 열지 못했어요. 잠시 후 다시 시도해주세요.');
        igConnectBtn.textContent = original;
        igConnectBtn.disabled = false;
      } catch (e) {
        showIgErr('네트워크 오류 — 잠시 후 다시 시도해주세요.');
        igConnectBtn.textContent = original;
        igConnectBtn.disabled = false;
      }
    });
  }
})();
