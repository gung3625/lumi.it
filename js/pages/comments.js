    (function () {
      const token =
        localStorage.getItem('lumi-auth') ||
        localStorage.getItem('lumi_auth') ||
        localStorage.getItem('seller_jwt') || '';
      if (!token) { location.replace('/'); return; }
      const authHeaders = { Authorization: 'Bearer ' + token };

      const stateEl = document.querySelector('[data-state]');
      const listEl = document.querySelector('[data-list]');
      const emptyEl = document.querySelector('[data-empty]');
      const emptyTitle = document.querySelector('[data-empty-title]');
      const emptySub = document.querySelector('[data-empty-sub]');
      const emptyCta = document.querySelector('[data-empty-cta]');

      // network-error retry — stateEl 안 [data-state-retry] 버튼 클릭 시 load() 재시도 (audit #9)
      if (stateEl) {
        stateEl.addEventListener('click', (e) => {
          if (!e.target.closest('[data-state-retry]')) return;
          stateEl.textContent = '댓글을 가져오는 중…';
          load();
        });
      }

      function fmtTime(iso) {
        if (!iso) return '';
        try {
          const t = new Date(iso);
          const diff = (Date.now() - t.getTime()) / 1000;
          if (diff < 60) return '방금';
          if (diff < 3600) return Math.floor(diff / 60) + '분 전';
          if (diff < 86400) return Math.floor(diff / 3600) + '시간 전';
          return `${t.getMonth() + 1}/${t.getDate()}`;
        } catch { return ''; }
      }

      // IG 댓글 텍스트·username 은 외부 입력 → innerHTML 삽입 전 escape 필수.
      function esc(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      // forceRefresh=true 면 서버 캐시 우회 (사장님이 IG 에서 게시물·답글 삭제 후 즉시 반영).
      async function load(forceRefresh = false) {
        try {
          const url = '/api/comments?limit=50' + (forceRefresh ? '&refresh=1' : '');
          const res = await fetch(url, { headers: authHeaders });
          if (!res.ok) {
            stateEl.innerHTML = '댓글을 가져오지 못했어요. <button type="button" class="state-retry" data-state-retry>다시 시도</button>';
            return;
          }
          const json = await res.json();
          const items = (json && json.items) || [];
          stateEl.hidden = true;

          if (items.length === 0) {
            if (json.tokenExpired) {
              // 토큰 만료 — 재연동 유도 (대시보드 배너와 별개로 페이지 진입 직접 케이스 커버)
              emptyTitle.textContent = '인스타 재연동이 필요해요';
              emptySub.textContent = '토큰이 만료돼서 댓글을 못 가져왔어요. 설정에서 재연동하면 다시 모입니다.';
              emptyCta.textContent = '⚙️ 설정에서 재연동';
              emptyCta.setAttribute('href', '/settings');
              emptyCta.hidden = false;
            } else if (json.igConnected) {
              emptyTitle.textContent = '아직 새 댓글이 없어요';
              emptySub.textContent = '새 인스타 댓글이 들어오면 여기 모입니다.';
              emptyCta.hidden = true;
            } else {
              emptyTitle.textContent = '인스타 연동 후 댓글이 표시돼요';
              emptySub.textContent = '비즈니스/크리에이터 계정과 연동하면 받은 댓글이 한곳에 모입니다.';
              emptyCta.textContent = '📷 인스타 연동하기';
              emptyCta.setAttribute('href', '/dashboard');
              emptyCta.hidden = false;
            }
            emptyEl.hidden = false;
            return;
          }

          listEl.innerHTML = items.map(c => {
            const u = (c.username || c.from || '익명').slice(0, 24);
            const initial = (u[0] || '·').toUpperCase();
            const text = (c.text || '').slice(0, 240);
            const time = fmtTime(c.timestamp || c.created_at);
            const replyText = (c.reply_text || '').slice(0, 240);
            const reply = replyText ? `<div class="comment__reply">${esc(replyText)}</div>` : '';
            const postCaption = (c.post_caption || '').slice(0, 40);
            const captionLine = postCaption
              ? `<div class="comment__post-caption">📷 ${esc(postCaption)}…</div>`
              : '';
            const thumb = c.post_thumb
              ? `<img class="comment__post-thumb" src="${esc(c.post_thumb)}" alt="댓글 달린 게시물" loading="lazy">`
              : '';
            // permalink 있으면 IG 게시물 새 탭으로 열기. display:contents 로 레이아웃 유지.
            const wrap = c.permalink
              ? (inner) => `<a href="${esc(c.permalink)}" target="_blank" rel="noopener noreferrer" class="comment__link">${inner}</a>`
              : (inner) => inner;
            // M4.1 — 채널 칩. channel 없으면 'ig' fallback (옛 응답 호환).
            const channel = (c.channel === 'threads') ? 'threads' : 'ig';
            const chipLabel = channel === 'threads' ? '쓰레드' : '인스타';
            const chipHtml = `<span class="chan-chip chan-chip--${channel}">${chipLabel}</span>`;
            // 답글 컴포저: 이미 사장님이 답글 단 댓글은 컴포저 숨김 (1회만 답글 가능 정책).
            // IG/Threads 둘 다 지원 — channel 에 따라 maxlength 와 placeholder 분기.
            const canReply = !replyText && c.id;
            const replyMax = channel === 'threads' ? 500 : 2200;
            const replyPlaceholder = channel === 'threads' ? '답글을 적어주세요 (500자)' : '답글을 적어주세요';
            const composer = canReply ? `
              <button type="button" class="comment__reply-toggle" data-reply-toggle="${esc(c.id)}">↳ 답글 달기</button>
              <form class="comment__reply-form" data-reply-form="${esc(c.id)}" data-reply-channel="${channel}" hidden>
                <textarea class="comment__reply-textarea" maxlength="${replyMax}" placeholder="${esc(replyPlaceholder)}" data-reply-text></textarea>
                <div class="comment__reply-error" data-reply-error hidden></div>
                <div class="comment__reply-actions">
                  <button type="button" class="comment__reply-btn comment__reply-btn--cancel" data-reply-cancel>취소</button>
                  <button type="submit" class="comment__reply-btn comment__reply-btn--send" data-reply-send>전송</button>
                </div>
              </form>
            ` : '';
            return `
              <li class="comment" data-comment-id="${esc(c.id || '')}" data-channel="${channel}">
                ${wrap(`
                  <span class="comment__avatar">${esc(initial)}</span>
                  <div class="comment__body">
                    <span class="comment__user">${esc(u)}</span>
                    ${chipHtml}
                    <span class="comment__time">${esc(time)}</span>
                    ${captionLine}
                    <div class="comment__text">${esc(text)}</div>
                    ${reply}
                  </div>
                  ${thumb}
                `)}
                ${composer}
              </li>
            `;
          }).join('');
          listEl.hidden = false;
        } catch (e) {
          stateEl.textContent = '댓글을 가져오지 못했어요.';
        }
      }

      // 답글 컴포저 동작 — 이벤트 위임으로 한 번만 바인딩.
      // 토글: "↳ 답글 달기" → 폼 펼침. 취소: 폼 접고 비움. 전송: POST /api/reply-comment.
      listEl.addEventListener('click', (e) => {
        const toggle = e.target.closest('[data-reply-toggle]');
        if (toggle) {
          e.preventDefault();
          const commentId = toggle.dataset.replyToggle;
          const form = listEl.querySelector(`[data-reply-form="${CSS.escape(commentId)}"]`);
          if (form) {
            form.hidden = false;
            toggle.style.display = 'none';
            form.querySelector('[data-reply-text]')?.focus();
          }
          return;
        }
        const cancel = e.target.closest('[data-reply-cancel]');
        if (cancel) {
          e.preventDefault();
          const form = cancel.closest('[data-reply-form]');
          if (form) {
            form.hidden = true;
            form.querySelector('[data-reply-text]').value = '';
            const errEl = form.querySelector('[data-reply-error]');
            errEl.hidden = true;
            errEl.textContent = '';
            // 토글 버튼 복원
            const commentId = form.dataset.replyForm;
            const toggle = listEl.querySelector(`[data-reply-toggle="${CSS.escape(commentId)}"]`);
            if (toggle) toggle.style.display = '';
          }
        }
      });

      listEl.addEventListener('submit', async (e) => {
        const form = e.target.closest('[data-reply-form]');
        if (!form) return;
        e.preventDefault();
        const commentId = form.dataset.replyForm;
        const channel = form.dataset.replyChannel === 'threads' ? 'threads' : 'ig';
        const textEl = form.querySelector('[data-reply-text]');
        const sendBtn = form.querySelector('[data-reply-send]');
        const errEl = form.querySelector('[data-reply-error]');
        const message = (textEl.value || '').trim();
        if (!message) {
          errEl.textContent = '답글 내용을 입력해주세요.';
          errEl.hidden = false;
          return;
        }
        sendBtn.disabled = true;
        sendBtn.textContent = '전송 중…';
        errEl.hidden = true;
        errEl.textContent = '';
        try {
          const res = await fetch('/api/reply-comment', {
            method: 'POST',
            headers: { ...authHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ commentId, message, channel }),
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok || !json.ok) {
            if (json.tokenExpired) {
              const chLabel = channel === 'threads' ? 'Threads' : 'IG';
              errEl.textContent = `${chLabel} 토큰이 만료됐어요. 설정에서 재연동해주세요.`;
            } else {
              errEl.textContent = json.error || '답글 전송 실패';
            }
            errEl.hidden = false;
            return;
          }
          // 성공 — 답글을 즉시 화면에 반영 (낙관적 업데이트) 후 다음 load 시 fresh.
          const li = form.closest('.comment');
          const body = li?.querySelector('.comment__body');
          if (body && !body.querySelector('.comment__reply')) {
            const replyDiv = document.createElement('div');
            replyDiv.className = 'comment__reply';
            replyDiv.textContent = message;
            body.appendChild(replyDiv);
            // 몰입 R2 — 답글 등록 성공 마이크로 피드백 (motion.css .tick-pop)
            replyDiv.classList.add('tick-pop');
            replyDiv.addEventListener('animationend', () => replyDiv.classList.remove('tick-pop'), { once: true });
          }
          form.remove();
          const toggle = li?.querySelector('[data-reply-toggle]');
          if (toggle) toggle.remove();
        } catch (err) {
          errEl.textContent = '네트워크 오류 — 다시 시도해주세요.';
          errEl.hidden = false;
        } finally {
          sendBtn.disabled = false;
          sendBtn.textContent = '전송';
        }
      });

      // 새로고침 버튼 — 캐시 우회 fresh fetch + 회전 애니메이션.
      const refreshBtn = document.querySelector('[data-refresh]');
      let isRefreshing = false;
      async function manualRefresh() {
        if (isRefreshing) return;
        isRefreshing = true;
        refreshBtn?.classList.add('is-spinning');
        try {
          await load(true);
        } finally {
          isRefreshing = false;
          refreshBtn?.classList.remove('is-spinning');
        }
      }
      refreshBtn?.addEventListener('click', manualRefresh);

      // 페이지 가시성 변화 시 자동 갱신 — 다른 탭에서 IG 삭제 후 돌아왔을 때 즉시 반영.
      // 30초 이상 지났을 때만 (잦은 탭 전환 시 무한 fetch 방지).
      let lastLoadAt = Date.now();
      const AUTO_REFRESH_THRESHOLD_MS = 30 * 1000;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (Date.now() - lastLoadAt < AUTO_REFRESH_THRESHOLD_MS) return;
        lastLoadAt = Date.now();
        load(true);
      });

      load();
      lastLoadAt = Date.now();
    })();
