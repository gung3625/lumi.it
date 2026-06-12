    (function () {
      const token =
        localStorage.getItem('lumi-auth') ||
        localStorage.getItem('lumi_auth') ||
        localStorage.getItem('seller_jwt') || '';
      if (!token) { location.replace('/'); return; }
      const authHeaders = { Authorization: 'Bearer ' + token };

      // 탭 전환 — hash 가 있으면 무조건 hash 우선 (사장님 새로고침 시 보던 탭 유지).
      // 그 다음 path-based (/insights/best-time 진입), 마지막 default 'weekly'.
      // 이전 버그: pathBased 가 hash 보다 우선되어 사장님이 '이번 주' 탭 보다가 새로고침하면
      // path 가 /insights/best-time 그대로라 베스트 시간 탭으로 강제 복귀.
      const hashTab = (location.hash || '').replace('#', '');
      const pathBased = location.pathname.includes('/insights/best-time') ? 'best-time' : '';
      const initialTab = hashTab || pathBased || 'weekly';
      function switchTab(name) {
        document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('is-active', b.dataset.tab === name));
        document.querySelectorAll('[data-pane]').forEach(p => p.classList.toggle('is-active', p.dataset.pane === name));
        if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
      }
      document.querySelectorAll('[data-tab]').forEach(b => {
        b.addEventListener('click', () => switchTab(b.dataset.tab));
      });
      switchTab(['weekly','monthly','best-time','benchmark'].includes(initialTab) ? initialTab : 'weekly');

      // ── 통계 렌더 ──
      function fmtNum(n) {
        if (typeof n !== 'number') return '—';
        if (n >= 10000) return (n / 10000).toFixed(1) + '만';
        return n.toLocaleString();
      }
      function fmtDelta(n) {
        if (typeof n !== 'number' || n === 0) return '';
        const sign = n > 0 ? '+' : '';
        return `${sign}${n.toLocaleString()}`;
      }
      function deltaClass(n) {
        if (typeof n !== 'number' || n === 0) return '';
        return n > 0 ? 'stat__delta--up' : 'stat__delta--down';
      }
      function renderStats(grid, data, period) {
        const followers = data.followers;
        const likes = data.likesTotal;
        const reach = data.reach;
        const profileViews = data.profileViews;
        const followersChange = data.followersChange;
        const items = [
          { label: '팔로워', value: fmtNum(followers), delta: fmtDelta(followersChange), deltaCls: deltaClass(followersChange) },
          { label: period === 'weekly' ? '이번 주 좋아요' : '이번 달 좋아요', value: fmtNum(likes), delta: '', deltaCls: '' },
          { label: '도달', value: fmtNum(reach), delta: '', deltaCls: '' },
          { label: '프로필 조회', value: fmtNum(profileViews), delta: '', deltaCls: '' },
        ];
        let html = '<div class="stat-section-label">인스타그램</div>' + items.map(it => `
          <div class="stat">
            <div class="stat__label">${it.label}</div>
            <div class="stat__value">${it.value}</div>
            ${it.delta ? `<div class="stat__delta ${it.deltaCls}">${it.delta}</div>` : ''}
          </div>
        `).join('');

        // M4.2 — Threads 섹션 (연동된 사장님만).
        // tokenExpired 시 안내 카드, 정상 시 views/likes/replies/reposts/quotes.
        const t = data.threads;
        if (t && t.connected) {
          if (t.tokenExpired) {
            html += `<div class="stat-section-label">쓰레드</div>
              <div class="stat stat--threads-expired">
                <div class="stat__label">⚠️ 쓰레드 재연동 필요</div>
                <div class="stat__value stat__value--sm">설정에서 토큰 갱신</div>
              </div>`;
          } else {
            const threadsItems = [
              { label: period === 'weekly' ? '이번 주 조회' : '이번 달 조회',   value: fmtNum(t.views) },
              { label: period === 'weekly' ? '이번 주 좋아요' : '이번 달 좋아요', value: fmtNum(t.likes) },
              { label: '답글',     value: fmtNum(t.replies) },
              { label: '리포스트', value: fmtNum(t.reposts) },
            ];
            html += '<div class="stat-section-label">쓰레드</div>' + threadsItems.map(it => `
              <div class="stat stat--threads">
                <div class="stat__label">${it.label}</div>
                <div class="stat__value">${it.value}</div>
              </div>
            `).join('');
          }
        }
        grid.innerHTML = html;
      }

      // 토큰 만료 응답일 때 stateEl 영역을 재연동 배너로 교체.
      // 백엔드(insight-weekly/monthly)는 토큰 만료 시 200 + { error: 'token_expired', data: null } 응답.
      function renderTokenExpiredBanner(stateEl) {
        stateEl.classList.remove('state');
        stateEl.removeAttribute('hidden');
        stateEl.innerHTML = `
          <a class="ig-expired" href="/settings">
            <span class="ig-expired__icon" aria-hidden="true">⚠️</span>
            <div class="ig-expired__body">
              <div class="ig-expired__title">인스타 재연동이 필요해요</div>
              <div class="ig-expired__sub">토큰이 만료돼서 인사이트를 못 가져왔어요. 설정에서 재연동.</div>
            </div>
            <span class="ig-expired__chev" aria-hidden="true">→</span>
          </a>
        `;
      }

      async function loadInsight(period) {
        const stateEl = document.querySelector(`[data-${period}-state]`);
        const contentEl = document.querySelector(`[data-${period}-content]`);
        const gridEl = document.querySelector(`[data-${period}-grid]`);
        const summaryEl = document.querySelector(`[data-${period}-summary]`);
        try {
          const url = period === 'weekly' ? '/api/insight-weekly' : '/api/insight-monthly';
          const res = await fetch(url, { headers: authHeaders });
          if (!res.ok) {
            stateEl.textContent = '인사이트를 가져오지 못했어요. 인스타가 연동돼 있나요?';
            return;
          }
          const json = await res.json();
          // 토큰 만료 — 인사이트 데이터 없음. 재연동 배너로 교체.
          // tokenExpired 표준 키 우선, error='token_expired' 는 옛 호환 (PR #169).
          if (json && (json.tokenExpired || json.error === 'token_expired')) {
            renderTokenExpiredBanner(stateEl);
            return;
          }
          const data = (json && json.data) || {};
          stateEl.hidden = true;
          contentEl.hidden = false;
          renderStats(gridEl, data, period);
          if (data.mediaCountInRange != null) {
            const days = period === 'weekly' ? '이번 주' : '이번 달';
            summaryEl.innerHTML = `<div class="summary-card__title">${days} 게시물</div><div class="summary-card__text">총 ${data.mediaCountInRange}건 게시했어요${data.commentsTotal ? `, 댓글 ${data.commentsTotal}개` : ''}.</div>`;
            summaryEl.hidden = false;
          }
        } catch (e) {
          stateEl.textContent = '인사이트를 가져오지 못했어요.';
        }
      }
      loadInsight('weekly');
      loadInsight('monthly');

      // ── 베스트 시간 ──
      let btCache = null;
      let currentDay = 'weekday';
      // 응답의 modes/progress/thresholds 를 받아 모드 배지·진행 카드 갱신.
      // currentDay 가 'personal' 이면 핑크 "내 데이터", 아니면 회색 "업종 평균".
      // 사장님 결정 (2026-05-15 재정정):
      // personal/seed 둘 다 슬롯 3개 표시. seed 면 모드 배지 '업종 평균' + 안내 카드 노출.
      function renderModeAndProgress() {
        if (!btCache) return;
        const modes = btCache.modes || {};
        const personal = modes[currentDay] === 'personal';

        // 모드 배지 — personal/seed 둘 다 표시.
        const modeEl = document.querySelector('[data-bt-mode]');
        const modeLabelEl = document.querySelector('[data-bt-mode-label]');
        if (modeEl && modeLabelEl) {
          modeEl.classList.toggle('is-personal', personal);
          modeEl.classList.toggle('is-seed', !personal);
          modeLabelEl.textContent = personal ? '내 데이터' : '업종 평균';
          modeEl.hidden = false;
        }

        // 진행 카드 — personal 이면 hide, seed 면 표시 ('업종 평균 표시 중, 내 데이터 수집 중').
        const progEl = document.querySelector('[data-bt-progress]');
        if (!progEl) return;
        progEl.hidden = personal;
      }
      function renderBest() {
        const listEl = document.querySelector('[data-bt-list]');
        if (!btCache) return;
        renderModeAndProgress();
        // 사장님 결정 (재정정): seed 도 슬롯 표시.
        const items = btCache[currentDay] || [];
        if (!items.length) {
          listEl.innerHTML = '';
          return;
        }
        // 현재 시각 + 30분 이후 가장 가까운 슬롯에 "다음 임박" 강조.
        // 단 현재 탭이 오늘 요일과 일치할 때만 (평일 탭 + 오늘 평일, 주말 탭 + 오늘 주말).
        // 그 외엔 강조 없음 — 다른 요일 참고용으로만 보임.
        const today = new Date().getDay();
        const todayIsWeekend = today === 0 || today === 6;
        const tabMatchesToday = (currentDay === 'weekday' && !todayIsWeekend) || (currentDay === 'weekend' && todayIsWeekend);
        let nowIdx = -1;
        if (tabMatchesToday) {
          const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
          const slotMins = items.map(it => {
            const [hh, mm] = String(it.time || '0:0').split(':').map(Number);
            return hh * 60 + mm;
          });
          nowIdx = slotMins.findIndex(m => m > nowMin + 30);
        }
        const note = (tabMatchesToday && nowIdx === -1)
          ? '<div class="bt-note">오늘 추천 시간은 모두 지났어요. 내일 다시 알려드릴게요.</div>'
          : '';
        const esc = (s) => String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        listEl.innerHTML = note + items.map((it, i) => {
          const isNow = i === nowIdx;
          const badge = isNow ? '<span class="time-card__badge">다음 임박</span>' : '';
          return `
            <button type="button" class="time-card${isNow ? ' is-best' : ''}"
                    data-card-time="${esc(it.time || '')}"
                    data-card-reason="${esc(it.reason || '')}">
              <div class="time-card__hour">${esc(it.time || '—')}</div>
              <div class="time-card__reason">${esc(it.reason || '')}</div>
              ${badge}
            </button>
          `;
        }).join('');
      }
      // time-card 는 button 으로 렌더 — 기본 스타일 reset (인라인 가벼움)
      // sheet open / close / tier 별 카피
      const sheetEl = document.querySelector('[data-bt-sheet]');
      const sheetTime = document.querySelector('[data-bt-sheet-time]');
      const sheetDay = document.querySelector('[data-bt-sheet-day]');
      const sheetTier = document.querySelector('[data-bt-sheet-tier]');
      const sheetBody = document.querySelector('[data-bt-sheet-body]');
      let lastFocused = null;

      function tierMeta(tier) {
        // tier1 = 본인 게시 도달(reach) 기반 / tier2 = 팔로워 활동 매트릭스 / tier4 = 업종 평균
        if (tier === 'tier2') return { label: '내 팔로워 활동', cls: 'is-tier2' };
        if (tier === 'tier1') return { label: '내 데이터', cls: 'is-tier1' };
        return { label: '업종 평균', cls: 'is-tier4' };
      }
      const THRESHOLDS_LABEL = { weekday: 5, weekend: 3 };
      function sheetCopy(tier, day, reason, ctx) {
        const dayLabel = day === 'weekend' ? '주말' : '평일';
        const p = ctx.progress || {};
        const t2 = ctx.tier2_progress || {};
        const dayP = p[day] || { have: 0, need: THRESHOLDS_LABEL[day] };
        const dayT2 = t2[day] || { snapshot_days: 0, needed_days: day === 'weekend' ? 6 : 15 };
        if (tier === 'tier2') {
          return `
            <p>${dayLabel} 이 시각대에 <strong>내 팔로워가 인스타에서 가장 활발</strong>해요.</p>
            <p>최근 ${dayLabel} ${dayT2.snapshot_days}일 분 누적된 인스타 활동 데이터 기준입니다. 이 시간 게시는 첫 1시간 노출량이 평균보다 높을 가능성이 큽니다.</p>
          `;
        }
        if (tier === 'tier1') {
          return `
            <p>이 시각에 올린 <strong>내 게시물을 팔로워가 가장 많이 본 시간</strong>이에요.</p>
            <p>${dayLabel} 게시 ${dayP.have || 0}건의 도달(reach)·저장 데이터를 가중 평균한 결과입니다. 팔로워 활동 데이터가 ${dayT2.needed_days}일 분 누적되면 더 정확해져요.</p>
          `;
        }
        // tier4 (시드)
        return `
          <p>아직 내 데이터가 부족해 <strong>사람들이 많이 볼 만한 시간대 평균</strong>을 보여드려요.</p>
          <p>${dayLabel} 게시물의 도달(reach) 데이터가 ${dayP.have || 0}/${dayP.need || THRESHOLDS_LABEL[day]}건 모이면 내 팔로워가 실제로 본 시간으로 자동 전환됩니다. (인스타 도달 메트릭은 게시 후 24~72시간 안에 채워져요.)</p>
        `;
      }

      function openSheet(time, reason) {
        if (!btCache) return;
        const tier = (btCache.sources && btCache.sources[currentDay]) || 'tier4';
        const meta = tierMeta(tier, btCache.modes && btCache.modes[currentDay]);
        sheetTime.textContent = time || '—';
        sheetDay.textContent = currentDay === 'weekend' ? '주말' : '평일';
        sheetTier.className = 'bt-sheet__tier ' + meta.cls;
        sheetTier.textContent = meta.label;
        sheetBody.innerHTML = sheetCopy(tier, currentDay, reason, btCache);
        lastFocused = document.activeElement;
        sheetEl.hidden = false;
        // panel 에 focus — esc 처리 위해
        const closeBtn = sheetEl.querySelector('.bt-sheet__close');
        if (closeBtn) closeBtn.focus();
        document.addEventListener('keydown', onSheetKey);
      }
      function closeSheet() {
        sheetEl.hidden = true;
        document.removeEventListener('keydown', onSheetKey);
        if (lastFocused && typeof lastFocused.focus === 'function') {
          try { lastFocused.focus(); } catch {}
        }
      }
      function onSheetKey(e) {
        if (e.key === 'Escape') closeSheet();
      }
      document.querySelectorAll('[data-bt-sheet-close]').forEach((el) => {
        el.addEventListener('click', closeSheet);
      });
      // 카드 클릭(이벤트 위임) — listEl 안의 button 만
      const listElForSheet = document.querySelector('[data-bt-list]');
      if (listElForSheet) {
        listElForSheet.addEventListener('click', (e) => {
          const card = e.target.closest('[data-card-time]');
          if (!card) return;
          openSheet(card.getAttribute('data-card-time'), card.getAttribute('data-card-reason'));
        });
      }
      document.querySelectorAll('[data-day]').forEach(b => {
        b.addEventListener('click', () => {
          currentDay = b.dataset.day;
          document.querySelectorAll('[data-day]').forEach(x => x.classList.toggle('is-active', x === b));
          renderBest();
        });
      });
      async function loadBest() {
        const stateEl = document.querySelector('[data-bt-state]');
        const contentEl = document.querySelector('[data-bt-content]');
        try {
          const meRes = await fetch('/api/me', { headers: authHeaders });
          const meJson = await meRes.json();
          const cat = (meJson.seller || meJson).industry || 'cafe';
          const res = await fetch('/api/get-best-time', {
            method: 'POST',
            headers: { ...authHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ category: cat }),
          });
          const json = await res.json();
          if (!res.ok) {
            stateEl.textContent = '베스트 시간을 가져오지 못했어요.';
            return;
          }
          btCache = json && (json.data || json);
          stateEl.hidden = true;
          contentEl.hidden = false;
          renderBest();
        } catch (e) {
          stateEl.textContent = '베스트 시간을 가져오지 못했어요.';
        }
      }
      loadBest();

      // ── 벤치마크 탭 ──
      (function benchmark() {
        const listEl = document.querySelector('[data-bm-list]');
        const stateEl = document.querySelector('[data-bm-state]');
        const formEl = document.querySelector('[data-bm-form]');
        const inputEl = document.querySelector('[data-bm-input]');
        if (!listEl || !formEl) return;

        const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
          { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
        const fmt = (n) => (typeof n === 'number') ? (n >= 10000 ? (n / 10000).toFixed(1) + '만' : n.toLocaleString()) : '—';
        const pct = (n) => (typeof n === 'number') ? n + '%' : '—';
        let pollTimer = null;

        function compareRows(mine, theirs) {
          const rows = [
            ['팔로워', fmt(mine?.followers), fmt(theirs?.followers)],
            ['참여율', mine?.engagementRate != null ? mine.engagementRate + '%' : '—', theirs?.engagementRate != null ? theirs.engagementRate + '%' : '—'],
            ['주당 게시물', mine?.perWeek ?? '—', theirs?.perWeek ?? '—'],
            ['릴 비중', pct(mine?.formatMix?.reel), pct(theirs?.formatMix?.reel)],
            ['평균 좋아요', fmt(mine?.avgLikes), fmt(theirs?.avgLikes)],
          ];
          return rows.map(([k, a, b]) => `
            <div class="bm-cmp__row">
              <span class="bm-cmp__key">${k}</span>
              <span class="bm-cmp__val">${esc(a)}</span>
              <span class="bm-cmp__val bm-cmp__val--theirs">${esc(b)}</span>
            </div>`).join('');
        }

        function aiCards(report) {
          if (!report) {
            return '<div class="bm-hint">통계는 준비됐어요. 루미의 해석 리포트는 잠시 뒤 분석을 다시 누르면 함께 만들어 드려요.</div>';
          }
          // linkify: '이번 주에 해볼 일'은 카드를 누르면 그 아이디어가 업로드 메모에
          // 담긴 채(?idea=) 등록 페이지로 — 캡션 AI 가 소재로 사용.
          const block = (title, items, linkify) => `
            <div class="bm-ai">
              <div class="bm-ai__title">${title}</div>
              ${(items || []).map((it) => linkify ? `
                <a class="bm-ai__item bm-ai__item--link" href="/register-product?idea=${encodeURIComponent(it.title || '')}">
                  <div class="bm-ai__item-title">${esc(it.title)}</div>
                  <div class="bm-ai__item-body">${esc(it.body)}</div>
                  <div class="bm-ai__item-go">📷 이 아이디어로 만들기 →</div>
                </a>` : `
                <div class="bm-ai__item">
                  <div class="bm-ai__item-title">${esc(it.title)}</div>
                  <div class="bm-ai__item-body">${esc(it.body)}</div>
                </div>`).join('')}
            </div>`;
          const v = report.verdict || {};
          const vRow = (k, val, mod) => val
            ? `<div class="bm-verdict__row${mod ? ' bm-verdict__row--gap' : ''}"><span class="bm-verdict__k">${k}</span><span class="bm-verdict__v">${esc(val)}</span></div>`
            : '';
          const verdictHtml = (v.mine || v.theirs || v.gap) ? `
            <div class="bm-verdict">
              <div class="bm-ai__title">총평</div>
              ${vRow('내 계정', v.mine)}${vRow('그 가게', v.theirs)}${vRow('핵심 차이', v.gap, true)}
            </div>` : '';
          return verdictHtml
            + block('사장님 계정과 다른 점', report.differences)
            + block('이 가게가 잘 되는 방식', report.formula)
            + block('이번 주에 해볼 일', report.suggestions, true)
            + '<a class="bm-cta hover-lift" href="/register-product">사진 올리러 가기</a>';
        }

        function statsChips(theirs) {
          if (!theirs) return '';
          const tags = (theirs.topHashtags || []).slice(0, 5).map((t) => `<span class="bm-chip">#${esc(t.tag)}</span>`).join('');
          const hours = (theirs.topHours || []).map((h) => `${h.hour}시`).join(' · ');
          const days = (theirs.topDays || []).map((d) => d.day).join(' · ');
          return `
            <div class="bm-chips">
              ${hours ? `<span class="bm-chip bm-chip--time">주로 ${esc(hours)}</span>` : ''}
              ${days ? `<span class="bm-chip bm-chip--time">${esc(days)}요일</span>` : ''}
              ${tags}
            </div>`;
        }

        function cardHtml(acc) {
          const r = acc.latestReport;
          let body = '';
          if (!r) {
            body = '<div class="bm-hint">아직 분석 전이에요. 분석을 누르면 1~2분 안에 정리해 드려요.</div>';
          } else if (r.status === 'running') {
            body = '<div class="bm-hint bm-hint--busy">게시물을 모으고 있어요… 1~2분 정도 걸려요.</div>';
          } else if (r.status === 'error') {
            body = `<div class="bm-hint bm-hint--err">${esc(r.error || '분석에 실패했어요. 다시 시도해 주세요.')}</div>`;
          } else if (r.status === 'done' && r.stats) {
            const mine = r.stats.mine, theirs = r.stats.theirs;
            body = `
              <div class="bm-cmp">
                <div class="bm-cmp__row bm-cmp__row--head">
                  <span class="bm-cmp__key"></span>
                  <span class="bm-cmp__val">내 계정</span>
                  <span class="bm-cmp__val bm-cmp__val--theirs">@${esc(theirs?.username || '')}</span>
                </div>
                ${compareRows(mine, theirs)}
              </div>
              ${mine ? '' : '<div class="bm-hint">인스타그램을 연동하면 내 계정 숫자도 나란히 보여드려요.</div>'}
              ${statsChips(theirs)}
              ${aiCards(r.report)}`;
          }
          const busy = r && r.status === 'running';
          return `
            <article class="bm-card" data-bm-card="${acc.id}">
              <div class="bm-card__head">
                <a class="bm-card__name" href="https://www.instagram.com/${esc(acc.ig_username)}/" target="_blank" rel="noopener">@${esc(acc.ig_username)}</a>
                <div class="bm-card__actions">
                  <button type="button" class="bm-card__analyze hover-lift" data-bm-analyze="${acc.id}" ${busy ? 'disabled' : ''}>${busy ? '분석 중…' : '분석'}</button>
                  <button type="button" class="bm-card__remove" data-bm-remove="${acc.id}" aria-label="삭제">×</button>
                </div>
              </div>
              <div class="bm-card__body">${body}</div>
            </article>`;
        }

        async function load(silent) {
          try {
            const res = await fetch('/api/get-benchmark', { headers: authHeaders });
            const json = await res.json();
            if (!json.ok) throw new Error(json.error || 'load_failed');
            if (json.enabled === false) {
              stateEl.hidden = false;
              stateEl.textContent = '벤치마크 분석은 지금 준비 중이에요. 곧 열릴 예정이에요.';
            } else {
              stateEl.hidden = true;
            }
            listEl.innerHTML = (json.accounts || []).map(cardHtml).join('')
              || '<div class="bm-hint">아직 등록한 가게가 없어요. 궁금한 가게 계정을 위에 입력해 보세요.</div>';
            const anyRunning = (json.accounts || []).some((a) => a.latestReport && a.latestReport.status === 'running');
            clearTimeout(pollTimer);
            if (anyRunning) pollTimer = setTimeout(() => load(true), 8000);
          } catch (e) {
            if (!silent) {
              stateEl.hidden = false;
              stateEl.textContent = '벤치마크 정보를 가져오지 못했어요. 잠시 후 다시 시도해 주세요.';
            }
          }
        }

        formEl.addEventListener('submit', async (ev) => {
          ev.preventDefault();
          const username = (inputEl.value || '').trim();
          if (!username) return;
          const btn = formEl.querySelector('[data-bm-add-btn]');
          btn.disabled = true;
          try {
            const res = await fetch('/api/benchmark-accounts', {
              method: 'POST',
              headers: { ...authHeaders, 'Content-Type': 'application/json' },
              body: JSON.stringify({ username }),
            });
            const json = await res.json();
            if (!json.ok) { alert(json.error || '등록에 실패했어요.'); return; }
            inputEl.value = '';
            await load();
          } finally {
            btn.disabled = false;
          }
        });

        listEl.addEventListener('click', async (ev) => {
          const analyzeId = ev.target.closest && ev.target.closest('[data-bm-analyze]')?.dataset.bmAnalyze;
          const removeId = ev.target.closest && ev.target.closest('[data-bm-remove]')?.dataset.bmRemove;
          if (analyzeId) {
            const btn = ev.target.closest('[data-bm-analyze]');
            btn.disabled = true;
            btn.textContent = '분석 중…';
            await fetch('/api/benchmark-scrape', {
              method: 'POST',
              headers: { ...authHeaders, 'Content-Type': 'application/json' },
              body: JSON.stringify({ accountId: analyzeId }),
            }).catch(() => {});
            setTimeout(() => load(true), 1500);
            pollTimer = setTimeout(() => load(true), 8000);
          }
          if (removeId) {
            if (!confirm('이 가게를 벤치마크에서 뺄까요? 분석 기록도 같이 지워져요.')) return;
            const res = await fetch('/api/benchmark-accounts?id=' + encodeURIComponent(removeId), {
              method: 'DELETE',
              headers: authHeaders,
            });
            const json = await res.json().catch(() => ({}));
            if (!json.ok) { alert(json.error || '삭제에 실패했어요.'); return; }
            await load();
          }
        });

        load();
      })();
    })();
