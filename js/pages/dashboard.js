    (function () {
      // 0) URL hash 의 lumi_token + lumi_refresh (카카오 callback 직후) → localStorage 저장.
      try {
        if (location.hash && location.hash.indexOf('lumi_token=') !== -1) {
          const params = new URLSearchParams(location.hash.replace(/^#/, ''));
          const t = params.get('lumi_token');
          const rt = params.get('lumi_refresh');
          if (t) localStorage.setItem('lumi-auth', t);
          if (rt) localStorage.setItem('lumi_refresh', rt);
          history.replaceState(null, '', location.pathname);
        }
      } catch (_) {}

      const token =
        localStorage.getItem('lumi-auth') ||
        localStorage.getItem('lumi_auth') ||
        localStorage.getItem('seller_jwt');
      if (!token) { location.replace('/'); return; }
      const authHeaders = { Authorization: 'Bearer ' + token };

      function esc(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }

      let userCategory = 'cafe';

      // ──────────────────────────────────────────
      //  콘텐츠 캘린더 (화면 주인공)
      // ──────────────────────────────────────────
      function dateKey(d) { return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
      function pad(n) { return String(n).padStart(2, '0'); }

      const _now = new Date();
      let calY = _now.getFullYear();   // 보고 있는 달 (연)
      let calM = _now.getMonth();      // 보고 있는 달 (월 0-11)
      let selKey = dateKey(_now);      // 선택한 날짜
      let allRes = [];                 // 예약 전체 (list-reservations)

      // 날짜별 상태 집계 — 예약/게시완료/실패
      function dayStatus(key) {
        let scheduled = 0, posted = 0, failed = 0;
        for (const r of allRes) {
          const raw = r.scheduled_at || r.created_at;
          if (!raw || dateKey(new Date(raw)) !== key) continue;
          if (r.caption_status === 'failed' || r.caption_status === 'error') failed++;
          else if (r.is_sent || r.ig_post_id) posted++;
          else scheduled++;
        }
        return { scheduled, posted, failed, has: scheduled || posted || failed };
      }

      // 월 그리드 렌더 (요일 헤더 + 1일~말일, 앞쪽 빈칸 패딩)
      function renderCalendar() {
        const grid = document.querySelector('[data-cal-grid]');
        const title = document.querySelector('[data-cal-title]');
        if (!grid) return;
        if (title) title.textContent = `${calY}년 ${calM + 1}월`;
        const startDow = new Date(calY, calM, 1).getDay();      // 1일 요일 (0=일)
        const days = new Date(calY, calM + 1, 0).getDate();     // 말일
        const todayK = dateKey(new Date());

        let html = ['일', '월', '화', '수', '목', '금', '토']
          .map(d => `<span class="cal__dow">${d}</span>`).join('');
        for (let i = 0; i < startDow; i++) html += `<span class="cal__cell cal__cell--blank"></span>`;
        for (let day = 1; day <= days; day++) {
          const key = dateKey(new Date(calY, calM, day));
          const st = dayStatus(key);
          const isToday = key === todayK;
          const isSel = key === selKey;
          let dotCls = '';
          if (st.failed) dotCls = 'is-failed';
          else if (st.posted) dotCls = 'is-posted';
          else if (st.scheduled) dotCls = 'is-scheduled';
          html += `<button type="button" class="cal__cell${isToday ? ' is-today' : ''}${isSel ? ' is-selected' : ''}" data-day="${key}" aria-label="${calM + 1}월 ${day}일">`
            + `<span class="cal__num">${day}</span>`
            + `<span class="cal__dot ${dotCls}"></span>`
            + `</button>`;
        }
        grid.innerHTML = html;
      }

      // 선택한 날의 예약 목록 + 작성 버튼 (날짜 연동)
      function renderDayPanel() {
        const titleEl = document.querySelector('[data-day-title]');
        const listEl = document.querySelector('[data-day-list]');
        const cta = document.querySelector('[data-compose-cta]');
        const p = selKey.split('-').map(Number);
        const sel = new Date(p[0], p[1], p[2]);
        const todayK = dateKey(new Date());
        const tmr = new Date(); tmr.setDate(tmr.getDate() + 1);

        let label = `${sel.getMonth() + 1}월 ${sel.getDate()}일`;
        if (selKey === todayK) label += ' · 오늘';
        else if (selKey === dateKey(tmr)) label += ' · 내일';
        if (titleEl) titleEl.textContent = label;

        // 작성 버튼에 선택 날짜 전달 (register-product 가 date 파라미터로 예약일 프리필)
        if (cta) cta.href = `/register-product?date=${sel.getFullYear()}-${pad(sel.getMonth() + 1)}-${pad(sel.getDate())}`;

        if (!listEl) return;
        const items = allRes
          .filter(r => { const raw = r.scheduled_at || r.created_at; return raw && dateKey(new Date(raw)) === selKey; })
          .sort((a, b) => new Date(a.scheduled_at || a.created_at) - new Date(b.scheduled_at || b.created_at));

        if (items.length === 0) {
          listEl.innerHTML = `<div class="day__empty u-text-muted">예약된 게시물이 없어요</div>`;
          return;
        }
        const chLabels = { ig: '인스타', tt: '틱톡', nblog: '블로그', kakao: '카톡 채널' };
        listEl.innerHTML = items.map(r => {
          const t = new Date(r.scheduled_at || r.created_at);
          const time = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
          let state = '예약', stCls = 'is-scheduled';
          if (r.caption_status === 'failed' || r.caption_status === 'error') { state = '실패'; stCls = 'is-failed'; }
          else if (r.is_sent || r.ig_post_id) { state = '게시완료'; stCls = 'is-posted'; }
          const ttl = esc((r.title || r.caption || '게시물').slice(0, 40));
          const chs = Array.isArray(r.channels) ? r.channels.map(c => chLabels[c] || c).join(' · ') : '';
          return `<a class="day-item" href="/history?tab=upcoming">`
            + `<span class="day-item__time">${time}</span>`
            + `<span class="day-item__body"><span class="day-item__title">${ttl}</span>${chs ? `<span class="day-item__ch">${esc(chs)}</span>` : ''}</span>`
            + `<span class="day-item__state ${stCls}">${state}</span>`
            + `</a>`;
        }).join('');
      }

      // 발행 실패 알림 — 최근 7일 실패 건 카운트 (list-reservations 공유)
      function renderFailures(items) {
        const banner = document.querySelector('[data-failure-banner]');
        if (!banner) return;
        const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
        const failed = (items || []).filter(r => {
          const created = new Date(r.created_at || r.scheduled_at || 0).getTime();
          if (created < cutoff) return false;
          if (r.caption_status === 'failed' || r.caption_status === 'error') return true;
          const scheduledAt = r.scheduled_at ? new Date(r.scheduled_at).getTime() : 0;
          if (r.caption_status === 'scheduled' && !r.ig_post_id && scheduledAt && (Date.now() - scheduledAt > 30 * 60000)) return true;
          if (Array.isArray(r.channels) && r.channels.some(c => c.status === 'failed' || c.status === 'error')) return true;
          return false;
        });
        if (failed.length === 0) return;
        const countEl = banner.querySelector('[data-failure-count]');
        const reasonEl = banner.querySelector('[data-failure-reason]');
        if (countEl) countEl.textContent = String(failed.length);
        const latest = failed.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0];
        if (reasonEl && latest) {
          const err = (latest.caption_error || '').slice(0, 60);
          reasonEl.textContent = err ? err : '눌러서 확인하기';
        }
        banner.hidden = false;
      }

      // 매장 이름 + 카테고리 + 연동 상태
      async function loadMe() {
        try {
          const res = await fetch('/api/me', { headers: authHeaders });
          if (!res.ok) return;
          const data = await res.json();
          const name = data.store_name || (data.seller && data.seller.store_name) || (data.user && data.user.store_name);
          if (name) document.querySelectorAll('[data-store-name]').forEach(el => { el.textContent = name; });
          const cat = (data.seller && (data.seller.industry || data.seller.category)) || data.category || (data.user && data.user.category);
          if (cat) userCategory = String(cat).toLowerCase();

          const ig = data.igStatus || null;
          const reconnectSection = document.querySelector('[data-ig-reconnect-section]');
          if (reconnectSection && ig && ig.connected && (ig.tokenExpired || ig.tokenInvalid)) {
            reconnectSection.hidden = false;
          }

          window.__lumiIgConnected = !!(ig && ig.connected);
          if (ig && !ig.connected) {
            const igRequiredCard = document.querySelector('[data-ig-connect-required-section]');
            if (igRequiredCard) igRequiredCard.hidden = false;
            // 시작 체크리스트 — 이미 한 단계는 ✓ 표시
            (async () => {
              const setDone = (sel) => {
                const a = document.querySelector(sel);
                if (!a) return;
                a.classList.add('is-done');
                const num = a.querySelector('.start-step__num');
                if (num) num.textContent = '✓';
              };
              try {
                const [bm, rv] = await Promise.all([
                  fetch('/api/get-benchmark', { headers: authHeaders }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
                  fetch('/api/list-reservations', { headers: authHeaders }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
                ]);
                if (bm && Array.isArray(bm.accounts) && bm.accounts.length) setDone('[data-step-bench]');
                if (rv && Array.isArray(rv.items) && rv.items.length) setDone('[data-step-draft]');
              } catch (_) {}
            })();
            // 미연동이라 무의미한 영역 통째 숨김 — 체크리스트가 첫 동선 담당.
            ['[data-cal-section]', '[data-day-section]', '[data-quicklinks]', '[data-failure-banner]'].forEach((sel) => {
              const el = document.querySelector(sel);
              if (el) el.hidden = true;
            });
          }

          const threads = data.threadsStatus || null;
          const threadsReconnect = document.querySelector('[data-threads-reconnect-section]');
          if (threadsReconnect && threads && threads.connected && threads.tokenExpired) {
            threadsReconnect.hidden = false;
          }
        } catch (e) {
          console.warn('[dashboard] /api/me 실패:', e && e.message);
        }
      }

      // 예약 1회 fetch → 캘린더·선택일 패널·발행 실패 공유
      async function loadReservations() {
        try {
          const res = await fetch('/api/list-reservations', { headers: authHeaders });
          if (!res.ok) return;
          const json = await res.json();
          allRes = (json && json.items) || [];
          renderCalendar();
          renderDayPanel();
          renderFailures(allRes);
        } catch (e) {
          console.warn('[dashboard] /api/list-reservations 실패:', e && e.message);
        }
      }

      // 오늘 베스트 시간 → 작성 버튼 부제에 한 줄로 녹임
      async function loadBestTime() {
        const subEl = document.querySelector('[data-compose-sub]');
        if (!subEl) return;
        try {
          const res = await fetch('/api/get-best-time', {
            method: 'POST',
            headers: { ...authHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ category: userCategory }),
          });
          if (!res.ok) return;
          const json = await res.json();
          const day = new Date().getDay();
          const isWeekend = day === 0 || day === 6;
          const slots = (isWeekend ? json.weekend : json.weekday) || json.allSlots || [];
          if (!Array.isArray(slots) || !slots.length) return;
          const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
          const future = slots
            .map(s => { const [hh, mm] = String(s.time || '0:0').split(':').map(Number); return { min: hh * 60 + mm, time: s.time }; })
            .filter(s => s.min > nowMin + 30)
            .sort((a, b) => a.min - b.min);
          const pick = future[0];
          if (pick && pick.time) subEl.textContent = `지금은 ${pick.time}쯤이 올리기 좋아요`;
        } catch (e) {
          console.warn('[dashboard] /api/get-best-time 실패:', e && e.message);
        }
      }

      // 이번 주 반응 (좋아요·팔로워) — 데스크톱 위젯
      async function loadStats() {
        try {
          const res = await fetch('/api/insight-weekly', { headers: authHeaders });
          if (!res.ok) return;
          const json = await res.json();
          const d = json && json.data;
          if (!d) return;
          if (typeof d.likesTotal === 'number') {
            const el = document.querySelector('[data-stat-likes]');
            if (el) { el.textContent = d.likesTotal.toLocaleString(); el.classList.remove('skeleton', 'skeleton--text'); }
          }
          if (typeof d.followers === 'number') {
            const el = document.querySelector('[data-stat-followers]');
            if (el) { el.textContent = d.followers.toLocaleString(); el.classList.remove('skeleton', 'skeleton--text'); }
          }
        } catch (e) {
          console.warn('[dashboard] /api/insight-weekly 실패:', e && e.message);
        }
      }

      // 새 댓글 — 데스크톱 위젯
      async function loadComments() {
        const listEl = document.querySelector('[data-comments]');
        if (!listEl) return;
        try {
          const res = await fetch('/api/comments?limit=3', { headers: authHeaders });
          if (!res.ok) { listEl.innerHTML = '<li class="comments-card__item comments-card__empty"><span class="comments-card__text u-text-muted">댓글을 가져오지 못했어요.</span></li>'; return; }
          const json = await res.json();
          const items = (json && json.items) || [];
          if (items.length === 0) {
            const msg = json.igConnected ? '아직 새 댓글이 없어요' : '인스타 연동 후 표시돼요';
            listEl.innerHTML = `<li class="comments-card__item comments-card__empty"><span class="comments-card__text u-text-muted">${msg}</span></li>`;
            return;
          }
          listEl.innerHTML = items.slice(0, 3).map(c => {
            const u = (c.username || c.from || '익명').slice(0, 24);
            const initial = (u[0] || '·').toUpperCase();
            const text = (c.text || '').slice(0, 60);
            return `<li class="comments-card__item"><span class="comments-card__avatar">${esc(initial)}</span><div class="comments-card__body"><div class="comments-card__user">${esc(u)}</div><div class="comments-card__text">${esc(text)}</div></div></li>`;
          }).join('');
        } catch (e) {
          listEl.innerHTML = '<li class="comments-card__item comments-card__empty"><span class="comments-card__text u-text-muted">댓글을 가져오지 못했어요.</span></li>';
        }
      }

      // ── 캘린더 조작 (이전/다음 달, 날짜 선택) ──
      document.querySelector('[data-cal-prev]')?.addEventListener('click', () => {
        calM--; if (calM < 0) { calM = 11; calY--; }
        renderCalendar();
      });
      document.querySelector('[data-cal-next]')?.addEventListener('click', () => {
        calM++; if (calM > 11) { calM = 0; calY++; }
        renderCalendar();
      });
      document.querySelector('[data-cal-grid]')?.addEventListener('click', (e) => {
        const cell = e.target.closest('[data-day]');
        if (!cell) return;
        selKey = cell.dataset.day;
        renderCalendar();
        renderDayPanel();
      });

      // 로그아웃
      document.querySelectorAll('[data-logout]').forEach(btn => {
        btn.addEventListener('click', () => {
          if (!confirm('로그아웃 하시겠어요?')) return;
          ['lumi-auth', 'lumi_auth', 'seller_jwt', 'lumi_refresh'].forEach(k => { try { localStorage.removeItem(k); } catch {} });
          try { sessionStorage.clear(); } catch {}
          window.location.href = '/';
        });
      });

      // IG 미연동 사장님이 잠긴 탭/버튼 클릭 시 모달
      function showIgRequiredModal() {
        const modal = document.querySelector('[data-ig-required-modal]');
        if (!modal) return;
        modal.hidden = false;
        const c = modal.querySelector('.ig-required-modal__confirm');
        if (c) setTimeout(() => c.focus(), 50);
      }
      function hideIgRequiredModal() {
        const modal = document.querySelector('[data-ig-required-modal]');
        if (modal) modal.hidden = true;
      }
      document.querySelectorAll('[data-ig-guard]').forEach((el) => {
        el.addEventListener('click', (ev) => {
          if (window.__lumiIgConnected === false) { ev.preventDefault(); showIgRequiredModal(); }
        });
      });
      document.querySelectorAll('[data-ig-required-modal-close]').forEach((el) => {
        el.addEventListener('click', hideIgRequiredModal);
      });
      document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hideIgRequiredModal(); });

      // 초기 렌더 (빈 캘린더) → 데이터 도착 시 재렌더
      renderCalendar();
      renderDayPanel();
      (async () => {
        await loadMe();
        loadReservations();
        loadBestTime();
        loadStats();
        loadComments();
      })();
    })();
