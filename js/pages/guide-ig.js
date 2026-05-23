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

  // ─────── 2026-05-23 베타 흐름: 메타 비즈니스 인증 대기 중 ───────
  // 일반 OAuth 불가능 — 사장님 IG 를 Meta Developer Console 에서 Tester 로 미리 추가 필요.
  // 상태 흐름:
  //   pending  → tester 요청 form
  //   requested → 요청 완료, 루미팀 처리 대기 (OAuth 시도 가능 — 단 권한 못 받을 수 있음 안내)
  //   invited  → 처리 완료, OAuth 정상 가능
  // 상태 결정: GET /api/me → testerStatus.state
  //   토큰 없으면 모두 'pending' (form 노출 + 제출 시 /beta 로 유도)

  const block = document.querySelector('[data-tester-block]');
  if (!block) return;

  const pendingEl   = block.querySelector('[data-tester-state="pending"]');
  const requestedEl = block.querySelector('[data-tester-state="requested"]');
  const invitedEl   = block.querySelector('[data-tester-state="invited"]');

  function showState(state) {
    if (pendingEl)   pendingEl.hidden   = (state !== 'pending');
    if (requestedEl) requestedEl.hidden = (state !== 'requested');
    if (invitedEl)   invitedEl.hidden   = (state !== 'invited');
  }

  // 초기 상태 결정 — 토큰 있으면 /api/me 조회
  async function initState() {
    if (!token) { showState('pending'); return; }
    try {
      const r = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) { showState('pending'); return; }
      const j = await r.json();
      // IG 이미 연결됐으면 → 모든 상태 숨김 (이미 끝남)
      if (j && j.igStatus && j.igStatus.connected) {
        block.hidden = true;
        const doneMsg = document.createElement('div');
        doneMsg.className = 'guide-success';
        doneMsg.innerHTML = '<div class="guide-success__icon">🎉</div><h4 class="guide-success__title">이미 연결 완료!</h4><p class="guide-success__sub">루미 대시보드에서 게시 시작하세요.</p><div class="guide-success__actions"><a class="guide-success__cta" href="/dashboard">대시보드로</a></div>';
        block.parentNode.insertBefore(doneMsg, block);
        return;
      }
      const ts = j && j.testerStatus;
      const state = (ts && ts.state) || 'pending';
      showState(state);
      // requested 상태면 입력한 핸들 표시
      if (state === 'requested' && ts.requestedIgHandle) {
        const display = block.querySelector('[data-tester-handle-display]');
        if (display) display.textContent = '@' + ts.requestedIgHandle;
      }
    } catch (e) {
      console.warn('[guide-ig] /api/me 실패 — pending 으로 폴백:', e && e.message);
      showState('pending');
    }
  }
  initState();

  // ─────── Tester 초대 요청 form ───────
  const form = block.querySelector('[data-tester-form]');
  const errEl = block.querySelector('[data-tester-error]');
  const submitBtn = block.querySelector('[data-tester-submit]');
  function showFormErr(msg) {
    if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
  }
  function clearFormErr() { if (errEl) errEl.hidden = true; }

  if (form) {
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      clearFormErr();
      if (!token) { location.href = '/beta'; return; }
      const igHandle = (form.querySelector('#tester-ig-handle')?.value || '').trim().replace(/^@/, '').toLowerCase();
      if (!igHandle) { showFormErr('인스타 아이디를 입력해주세요.'); return; }
      if (!/^[a-z0-9._]{1,30}$/.test(igHandle)) {
        showFormErr('인스타 아이디 형식이 올바르지 않아요. (영문 소문자·숫자·_·. 만)');
        return;
      }

      const originalText = submitBtn.textContent;
      submitBtn.disabled = true;
      submitBtn.textContent = '요청 보내는 중…';
      try {
        const r = await fetch('/api/request-tester-invite', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ igHandle, contextUrl: location.href }),
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.ok) {
          // 응답 상태에 따라 UI 전환
          const newState = j.state === 'invited' ? 'invited' : 'requested';
          const display = block.querySelector('[data-tester-handle-display]');
          if (display) display.textContent = '@' + igHandle;
          showState(newState);
          return;
        }
        showFormErr((j && j.error) || '요청 보내기에 실패했어요. 잠시 후 다시 시도해주세요.');
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
      } catch (e) {
        showFormErr('네트워크 오류 — 잠시 후 다시 시도해주세요.');
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
      }
    });
  }

  // requested 상태에서 "인스타 아이디 다시 입력" → pending 으로 되돌리기 (form 재노출)
  const reEditBtn = block.querySelector('[data-tester-re-edit]');
  if (reEditBtn) {
    reEditBtn.addEventListener('click', () => {
      showState('pending');
      const input = form?.querySelector('#tester-ig-handle');
      if (input) setTimeout(() => input.focus(), 50);
    });
  }

  // ─────── "이제 루미와 연결하기" 버튼 — OAuth 시작 ───────
  // requested 와 invited 상태 둘 다에 버튼 있음. 둘 다 클릭 가능 (requested 는 권한 못 받을 수 있다는 안내).
  const igConnectBtns = block.querySelectorAll('[data-ig-connect-now]');
  function showIgErr(msg) {
    block.querySelectorAll('[data-ig-connect-error]').forEach((el) => {
      el.textContent = msg;
      el.hidden = false;
    });
  }
  igConnectBtns.forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!token) { location.href = '/beta'; return; }
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = '연결 화면 여는 중…';
      block.querySelectorAll('[data-ig-connect-error]').forEach((el) => { el.hidden = true; });
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
        btn.textContent = original;
        btn.disabled = false;
      } catch (e) {
        showIgErr('네트워크 오류 — 잠시 후 다시 시도해주세요.');
        btn.textContent = original;
        btn.disabled = false;
      }
    });
  });
})();
