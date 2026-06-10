    (function () {
      const token =
        localStorage.getItem('lumi-auth') ||
        localStorage.getItem('lumi_auth') ||
        localStorage.getItem('seller_jwt') || '';
      if (!token) { location.replace('/'); return; }
      const authHeaders = { Authorization: 'Bearer ' + token };

      // 사장님 친화적 toast (audit #5 — toast() 대체)
      const toastEl = document.querySelector('[data-toast]');
      let toastTimer;
      function toast(msg, ms) {
        if (!toastEl) return;
        toastEl.textContent = String(msg || '');
        toastEl.classList.add('is-open');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.remove('is-open'), ms || 2200);
      }

      // 로그아웃 — topbar [data-logout] (2026-05-16 사장님: 모든 탭에 로그아웃)
      document.querySelectorAll('[data-logout]').forEach(btn => {
        btn.addEventListener('click', () => {
          if (!confirm('로그아웃 하시겠어요?')) return;
          ['lumi-auth','lumi_auth','seller_jwt','lumi_refresh'].forEach(k => {
            try { localStorage.removeItem(k); } catch {}
          });
          try { sessionStorage.clear(); } catch {}
          location.href = '/';
        });
      });

      // HTML escape — 사용자 입력 캡션·예약 키·URL 을 innerHTML 에 삽입 전 항상 통과.
      function esc(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      const stateEl = document.querySelector('[data-state]');
      const tabsEl = document.querySelector('[data-tabs]');
      const tabsHintEl = document.querySelector('[data-tabs-hint]');
      const tabToolsEl = document.querySelector('[data-tab-tools]');
      const bulkBtn = document.querySelector('[data-bulk-delete]');
      const upcomingSec = document.querySelector('[data-pane="upcoming"]');
      const pastSec = document.querySelector('[data-pane="past"]');
      const upcomingList = document.querySelector('[data-upcoming-list]');
      const pastList = document.querySelector('[data-past-list]');
      const emptyEl = document.querySelector('[data-empty]');

      // ── 삭제 확인 모달 ──
      // 개별: 가벼운 확인. 모두 삭제: 실수 방지를 위해 '삭제' 텍스트 입력 검증.
      const delModal = document.querySelector('[data-del-modal]');
      const delTitle = document.querySelector('[data-del-title]');
      const delBody = document.querySelector('[data-del-body]');
      const delHint = document.querySelector('[data-del-hint]');
      const delInput = document.querySelector('[data-del-input]');
      const delConfirm = document.querySelector('[data-del-confirm]');
      const delCancel = document.querySelector('[data-del-cancel]');
      let delPendingAction = null; // () => Promise<void>

      const delMediaOpt   = document.querySelector('[data-del-media-opt]');
      const delMediaCheck = document.querySelector('[data-del-media-check]');
      // showMediaOption=true 면 "원본 게시물도 삭제" 체크박스 노출. onConfirm 호출 시 { deleteMedia } 전달.
      function openDelModal({ title, body, requireTyping, confirmText, variant, showMediaOption, onConfirm }) {
        delTitle.textContent = title || '삭제하시겠어요?';
        delBody.textContent = body || '이 기록만 히스토리에서 사라져요. 인스타·쓰레드의 실제 게시물은 그대로 남습니다.';
        delHint.hidden = !requireTyping;
        delInput.hidden = !requireTyping;
        delInput.value = '';
        delConfirm.disabled = !!requireTyping;
        delConfirm.textContent = confirmText || '삭제';
        // variant: 'danger' (디폴트) | 'primary'. danger = 빨강 (삭제), primary = 다크 (긍정 액션).
        delConfirm.classList.toggle('del-modal__btn--danger',  variant !== 'primary');
        delConfirm.classList.toggle('del-modal__btn--primary', variant === 'primary');
        // 원본 게시물 삭제 옵션
        if (delMediaOpt && delMediaCheck) {
          delMediaCheck.checked = false;
          delMediaOpt.hidden = !showMediaOption;
          delModal.classList.remove('is-media-checked');
        }
        delPendingAction = onConfirm;
        delModal.classList.add('is-open');
        delModal.setAttribute('aria-hidden', 'false');
        if (requireTyping) setTimeout(() => delInput.focus(), 50);
      }
      // 체크박스 토글 — danger 색 강조 + confirm 라벨 동적
      delMediaCheck?.addEventListener('change', () => {
        const on = !!delMediaCheck.checked;
        delModal.classList.toggle('is-media-checked', on);
        // 체크 시 confirm 라벨 변경 (danger 모드일 때만)
        if (delConfirm.classList.contains('del-modal__btn--danger')) {
          delConfirm.textContent = on ? '원본까지 삭제' : '삭제';
        }
      });
      function closeDelModal() {
        delModal.classList.remove('is-open');
        delModal.setAttribute('aria-hidden', 'true');
        delPendingAction = null;
      }
      delInput.addEventListener('input', () => {
        delConfirm.disabled = delInput.value.trim() !== '삭제';
      });
      delCancel.addEventListener('click', closeDelModal);
      delModal.addEventListener('click', (e) => { if (e.target === delModal) closeDelModal(); });
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && delModal.classList.contains('is-open')) closeDelModal();
      });
      delConfirm.addEventListener('click', async () => {
        if (delConfirm.disabled || !delPendingAction) return;
        const originalLabel = delConfirm.textContent;
        const deleteMedia = !!(delMediaCheck && !delMediaOpt.hidden && delMediaCheck.checked);
        delConfirm.disabled = true;
        delConfirm.textContent = '진행 중…';
        try {
          await delPendingAction({ deleteMedia });
        } finally {
          delConfirm.textContent = originalLabel;
          closeDelModal();
        }
      });

      // ── 인사이트 모달 — 채널 chip 클릭 시 게시별 metric 표시 ──
      const insightModal     = document.querySelector('[data-insight-modal]');
      const insightTitleEl   = insightModal?.querySelector('[data-insight-title]');
      const insightSubEl     = insightModal?.querySelector('[data-insight-sub]');
      const insightTabsEl    = insightModal?.querySelector('[data-insight-tabs]');
      const insightStateEl   = insightModal?.querySelector('[data-insight-state]');
      const insightGridEl    = insightModal?.querySelector('[data-insight-grid]');
      const insightCaptionEl = insightModal?.querySelector('[data-insight-caption]');
      const insightLinkEl    = insightModal?.querySelector('[data-insight-permalink]');
      const insightCloseBtn  = insightModal?.querySelector('[data-insight-close]');

      function openInsightModal() {
        if (!insightModal) return;
        insightModal.classList.add('is-open');
        insightModal.setAttribute('aria-hidden', 'false');
      }
      function closeInsightModal() {
        if (!insightModal) return;
        insightModal.classList.remove('is-open');
        insightModal.setAttribute('aria-hidden', 'true');
      }
      function resetInsightModal() {
        if (insightSubEl)     { insightSubEl.hidden = true; insightSubEl.textContent = ''; }
        if (insightTabsEl)    { insightTabsEl.hidden = true; insightTabsEl.innerHTML = ''; }
        if (insightStateEl)   { insightStateEl.hidden = false; insightStateEl.textContent = '불러오는 중…'; }
        if (insightGridEl)    { insightGridEl.hidden = true; insightGridEl.innerHTML = ''; }
        if (insightCaptionEl) { insightCaptionEl.hidden = true; insightCaptionEl.textContent = ''; }
        if (insightLinkEl)    { insightLinkEl.hidden = true; insightLinkEl.removeAttribute('href'); }
      }

      // 카드 click 진입 — 모든 채널 탭 노출. IG 우선 + 상태 아이콘 (✓ ⚠️ …).
      // 단일 채널만 있으면 탭 hidden + 콘텐츠만.
      let _currentReservationId = '';
      let _currentItems = [];
      function renderInsightTabs(items, reservationId) {
        if (!insightTabsEl || !items || !items.length) return;
        // IG 우선 정렬
        items = [...items].sort((a, b) => (a.channel === 'ig' ? -1 : 1));
        _currentReservationId = reservationId || '';
        _currentItems = items;
        const labelMap  = { ig: '인스타', threads: '쓰레드' };
        const statusIcon = (st) => st === 'posted' ? '✓' : st === 'failed' ? '⚠️' : '…';
        if (items.length === 1) {
          insightTabsEl.hidden = true;
        } else {
          insightTabsEl.innerHTML = items.map((it, i) => `
            <button type="button" class="insight-modal__tab ${i === 0 ? 'is-active' : ''}" role="tab" data-insight-tab="${it.channel}">
              ${labelMap[it.channel] || it.channel} <span aria-hidden="true">${statusIcon(it.status)}</span>
            </button>
          `).join('');
          insightTabsEl.hidden = false;
        }
        renderChannelContent(items[0]);
      }
      // 한 채널 콘텐츠 렌더 — 상태별 분기.
      function renderChannelContent(item) {
        if (!item) { if (insightStateEl) { insightStateEl.hidden = false; insightStateEl.textContent = '채널 정보를 찾을 수 없어요.'; } return; }
        const channel = item.channel;
        const status  = item.status;
        // 콘텐츠 영역 초기화 (sub/tabs 유지)
        if (insightStateEl)   { insightStateEl.hidden = true; insightStateEl.textContent = ''; }
        if (insightGridEl)    { insightGridEl.hidden = true; insightGridEl.innerHTML = ''; }
        if (insightCaptionEl) { insightCaptionEl.hidden = true; insightCaptionEl.textContent = ''; }
        if (insightLinkEl)    { insightLinkEl.hidden = true; insightLinkEl.removeAttribute('href'); }
        if (status === 'posted' && item.postId) {
          if (insightStateEl) { insightStateEl.hidden = false; insightStateEl.textContent = '불러오는 중…'; }
          loadInsightFetchOnly(channel, item.postId);
          return;
        }
        if (status === 'failed') {
          // 실패 안내 + 큰 다시 시도 버튼 — grid 영역에 inline 렌더
          const chLabel = channel === 'threads' ? '쓰레드' : '인스타';
          if (insightGridEl) {
            insightGridEl.innerHTML = `
              <div class="insight-failed">
                <div class="insight-failed__icon" aria-hidden="true">⚠️</div>
                <div class="insight-failed__msg">${chLabel} 게시가 실패했어요.<br>한 번 더 게시해볼까요?</div>
                <button type="button" class="insight-failed__retry" data-modal-retry data-channel="${channel}">↻ 다시 시도</button>
              </div>
            `;
            insightGridEl.hidden = false;
          }
          return;
        }
        // posting / pending 등
        if (insightStateEl) {
          insightStateEl.hidden = false;
          insightStateEl.textContent = '아직 게시 중이에요.';
        }
      }
      // 탭 클릭 → 해당 채널 콘텐츠 렌더.
      insightTabsEl?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-insight-tab]');
        if (!btn) return;
        insightTabsEl.querySelectorAll('.insight-modal__tab').forEach((el) => el.classList.toggle('is-active', el === btn));
        const channel = btn.dataset.insightTab === 'threads' ? 'threads' : 'ig';
        const item = _currentItems.find((it) => it.channel === channel);
        if (item) renderChannelContent(item);
      });
      // 모달 안 다시 시도 버튼 → 같은 confirm modal 호출. 성공 시 탭 상태·콘텐츠 갱신.
      document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-modal-retry]');
        if (!btn) return;
        e.preventDefault();
        const channel = btn.dataset.channel === 'ig' ? 'ig' : 'threads';
        const reservationId = _currentReservationId;
        if (!reservationId) return;
        const chLabel = channel === 'threads' ? '쓰레드' : '인스타';
        openDelModal({
          title: '다시 시도할까요?',
          body: `${chLabel} 게시가 실패한 기록입니다. 같은 사진·캡션으로 한 번 더 게시해요.`,
          confirmText: '다시 시도',
          variant: 'primary',
          onConfirm: () => retryFromModal(channel, reservationId),
        });
      });
      async function retryFromModal(channel, reservationId) {
        const chLabel = channel === 'threads' ? '쓰레드' : '인스타';
        try {
          const res = await fetch('/api/retry-channel-post', {
            method: 'POST',
            headers: { ...authHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ reservationId, channel }),
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok || !json.ok) {
            if (json.tokenExpired) toast(`${chLabel} 토큰이 만료됐어요. 설정에서 재연동해주세요.`);
            else toast(json.error || '재시도 실패');
            return;
          }
          // _currentItems 갱신 + 탭 아이콘 / 콘텐츠 즉시 반영
          const item = _currentItems.find((it) => it.channel === channel);
          if (item) {
            item.status = 'posted';
            item.postId = json.postId || '';
          }
          const tabBtn = insightTabsEl?.querySelector(`[data-insight-tab="${channel}"]`);
          if (tabBtn) {
            const icon = tabBtn.querySelector('span[aria-hidden="true"]');
            if (icon) icon.textContent = '✓';
          }
          renderChannelContent(item);
          // 카드 시각도 갱신 — chip → posted, retry link 제거.
          const card = document.querySelector(`.res[data-reservation-id="${reservationId}"]`);
          if (card) {
            const chip = card.querySelector(`.chan-chip--${channel}`);
            if (chip) {
              chip.classList.remove('is-failed');
              chip.classList.add('is-posted');
              chip.textContent = chLabel; // 실패 라벨 → 채널명만으로 복원
            }
            const link = card.querySelector(`[data-retry-link][data-channel="${channel}"]`);
            if (link) link.remove();
            // dataset 갱신
            const raw = card.dataset.channels || '';
            const next = raw.split(',').map((s) => {
              const [ch] = s.split(':');
              return ch === channel ? `${channel}:posted:${json.postId || ''}` : s;
            }).join(',');
            card.dataset.channels = next;
            card.classList.add('is-clickable');
          }
        } catch (err) {
          toast('네트워크 오류 — 다시 시도해주세요.');
        }
      }
      // 탭 전환용 — openInsightModal/resetInsightModal 안 호출 (이미 열려있음)
      async function loadInsightFetchOnly(channel, postId) {
        try {
          const url = `/api/insight-on-demand?mediaId=${encodeURIComponent(postId)}&channel=${encodeURIComponent(channel)}`;
          const res = await fetch(url, { headers: authHeaders });
          const json = await res.json().catch(() => ({}));
          if (!res.ok || !json.ok) {
            if (insightStateEl) insightStateEl.textContent = json.error === 'media_not_found'
              ? '게시물을 찾을 수 없어요. 삭제됐을 수 있어요.'
              : '인사이트를 가져오지 못했어요.';
            return;
          }
          if (json.tokenExpired || (json.data === null && json.error === 'token_expired')) {
            const chLabel = channel === 'threads' ? 'Threads' : 'IG';
            if (insightStateEl) insightStateEl.textContent = `${chLabel} 토큰이 만료됐어요. 설정에서 재연동해주세요.`;
            return;
          }
          if (!json.data) {
            const chLabel = channel === 'threads' ? '쓰레드' : '인스타';
            if (insightStateEl) insightStateEl.textContent = `${chLabel} 연동이 필요해요.`;
            return;
          }
          renderInsight(channel, json.data);
        } catch (e) {
          if (insightStateEl) insightStateEl.textContent = '네트워크 오류 — 다시 시도해주세요.';
        }
      }

      const STAT_LABELS = {
        ig:      [['likes', '좋아요'], ['comments', '댓글'], ['reach', '도달'], ['saved', '저장']],
        threads: [['views', '조회'],   ['likes', '좋아요'], ['replies', '답글'], ['reposts', '리포스트']],
      };
      function renderInsight(channel, data) {
        const chLabel = channel === 'threads' ? '쓰레드' : '인스타';
        if (insightTitleEl) insightTitleEl.textContent = `${chLabel} 게시 인사이트`;
        if (insightSubEl && data.timestamp) {
          try {
            const d = new Date(data.timestamp);
            insightSubEl.textContent = d.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
            insightSubEl.hidden = false;
          } catch { /* noop */ }
        }
        if (insightCaptionEl && data.caption) {
          insightCaptionEl.textContent = data.caption;
          insightCaptionEl.hidden = false;
        }
        if (insightLinkEl && data.permalink) {
          insightLinkEl.setAttribute('href', data.permalink);
          insightLinkEl.hidden = false;
        }
        if (insightGridEl) {
          const fmt = (n) => Number(n || 0).toLocaleString('ko-KR');
          const labels = STAT_LABELS[channel] || STAT_LABELS.ig;
          insightGridEl.innerHTML = labels.map(([key, label]) => `
            <div class="insight-stat">
              <div class="insight-stat__label">${label}</div>
              <div class="insight-stat__value">${fmt(data.metrics && data.metrics[key])}</div>
            </div>
          `).join('');
          insightGridEl.hidden = false;
        }
        if (insightStateEl) insightStateEl.hidden = true;
      }

      // 카드 전체 click → 인사이트 모달. posted 채널이 있는 카드만 진입 (.is-clickable).
      // 둘 다 posted = 모달 안 채널 탭, 단일 posted = 그 채널만, 그 외 = 클릭 비활성.
      // failed retry 는 카드 밖 별도 링크 (.chan-retry) — 카드 click 과 분리.
      document.addEventListener('click', (e) => {
        // 1) retry 링크 가 클릭됐다면 그 핸들러로 위임 (아래) — 카드 click 무시
        if (e.target.closest('[data-retry-link]')) return;
        // 2) 카드 내부의 interactive 요소 (취소 버튼 등) 클릭은 카드 click 으로 처리 X
        if (e.target.closest('button, a, input, textarea, select')) return;
        const card = e.target.closest('.res.is-clickable');
        if (!card) return;
        const raw = card.dataset.channels || '';
        if (!raw) return;
        e.preventDefault();
        // 모든 채널 — "ig:posted:<postId>,threads:failed:" 형식
        const items = raw.split(',').filter(Boolean).map((s) => {
          const [ch, st, pid] = s.split(':');
          return {
            channel: ch === 'threads' ? 'threads' : 'ig',
            status:  st || 'pending',
            postId:  pid || '',
          };
        });
        if (!items.length) return;
        const reservationId = card.dataset.reservationId || '';
        openInsightModal();
        resetInsightModal();
        renderInsightTabs(items, reservationId);
      });

      // 재시도 링크 (IG/Threads failed) — confirm modal → POST /api/retry-channel-post.
      // 성공 시 retry link 제거 + 옆 chip 의 시각을 is-failed → is-posted 로 갱신.
      async function retryChannelPost(channel, reservationId, linkEl) {
        if (!reservationId || !channel) return;
        const chLabel = channel === 'threads' ? '쓰레드' : '인스타';
        try {
          const res = await fetch('/api/retry-channel-post', {
            method: 'POST',
            headers: { ...authHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ reservationId, channel }),
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok || !json.ok) {
            if (json.tokenExpired) {
              toast(`${chLabel} 토큰이 만료됐어요. 설정에서 재연동해주세요.`);
            } else {
              toast(json.error || '재시도 실패');
            }
            return;
          }
          // 성공 — retry link 의 형제 chip 을 posted 시각으로 교체, link 제거.
          if (linkEl) {
            const sibling = linkEl.previousElementSibling;
            if (sibling && sibling.classList.contains('chan-chip')) {
              sibling.classList.remove('is-failed');
              sibling.classList.add('is-posted');
              sibling.textContent = chLabel; // "⚠️ ... 게시 실패" → "쓰레드" 라벨 복원
            }
            // 카드 의 dataset 에 새 post_id 추가 → 다음 카드 click 에서 모달 진입 가능
            const card = linkEl.closest('.res');
            if (card && json.postId) {
              const existing = card.dataset.postedChannels || '';
              const next = (existing ? existing + ',' : '') + `${channel}:${json.postId}`;
              card.dataset.postedChannels = next;
              card.classList.add('is-clickable');
            }
            linkEl.remove();
          }
        } catch (e) {
          toast('네트워크 오류 — 다시 시도해주세요.');
        }
      }
      document.addEventListener('click', (e) => {
        const link = e.target.closest('[data-retry-link]');
        if (!link) return;
        e.preventDefault();
        e.stopPropagation();
        const channel = link.dataset.channel === 'ig' ? 'ig' : 'threads';
        const reservationId = link.dataset.reservationId;
        if (!reservationId) return;
        const chLabel = channel === 'threads' ? '쓰레드' : '인스타';
        openDelModal({
          title: '다시 시도할까요?',
          body: `${chLabel} 게시가 실패한 기록입니다. 같은 사진·캡션으로 한 번 더 게시해요.`,
          confirmText: '다시 시도',
          variant: 'primary',
          onConfirm: () => retryChannelPost(channel, reservationId, link),
        });
      });
      insightCloseBtn?.addEventListener('click', closeInsightModal);
      insightModal?.addEventListener('click', (e) => { if (e.target === insightModal) closeInsightModal(); });
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && insightModal?.classList.contains('is-open')) closeInsightModal();
      });

      // ── 탭 동작 ──
      // URL ?tab=upcoming|past 로 디폴트 탭 결정. 미지정 시 upcoming (예약 목록).
      function getInitialTab() {
        try {
          const t = new URLSearchParams(location.search).get('tab');
          if (t === 'past' || t === 'upcoming') return t;
        } catch {}
        return 'upcoming';
      }
      let activeTab = getInitialTab();
      function applyTab() {
        document.querySelectorAll('[data-tab]').forEach(b => {
          const on = b.dataset.tab === activeTab;
          b.classList.toggle('is-active', on);
          b.setAttribute('aria-selected', String(on));
        });
        if (upcomingSec) upcomingSec.hidden = activeTab !== 'upcoming';
        if (pastSec) pastSec.hidden = activeTab !== 'past';
        // '모두 삭제' 버튼은 활성 탭에 항목 1건 이상일 때만 enabled.
        //   .res 카드는 data-key 가 있고, 빈 placeholder li.empty 는 없음 → 그걸로 구분.
        if (bulkBtn) {
          const activeList = activeTab === 'past' ? pastList : upcomingList;
          const hasItems = !!(activeList && activeList.querySelector('li[data-key]'));
          bulkBtn.disabled = !hasItems;
        }
      }
      document.querySelectorAll('[data-tab]').forEach(b => {
        b.addEventListener('click', () => {
          activeTab = b.dataset.tab;
          // URL 동기화 (뒤로가기 안전)
          try {
            const url = new URL(location.href);
            url.searchParams.set('tab', activeTab);
            history.replaceState(null, '', url);
          } catch {}
          applyTab();
        });
      });

      function fmtTime(iso) {
        if (!iso) return '—';
        const t = new Date(iso);
        const today = new Date();
        const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
        const isToday = t.toDateString() === today.toDateString();
        const isTomorrow = t.toDateString() === tomorrow.toDateString();
        const hh = String(t.getHours()).padStart(2, '0');
        const mm = String(t.getMinutes()).padStart(2, '0');
        const day = isToday ? '오늘' : isTomorrow ? '내일' : `${t.getMonth() + 1}/${t.getDate()}`;
        return `${day} ${hh}:${mm}`;
      }

      function statusBadge(r) {
        if (r.cancelled) return { cls: 'cancelled', label: '취소됨' };
        if (r.is_sent) return { cls: 'posted', label: '게시됨' };
        const s = r.caption_status || 'pending';

        // caption_status='scheduled' 는 두 의미를 동시에 갖는다:
        //  1) 사장님이 직접 예약 시간 지정 (post_mode='scheduled' 또는 'best-time')
        //  2) immediate 인데 게시 직전 transient — 특히 REELS 는 ffmpeg 후처리 60~150초 동안
        //     이 상태에 머문다. 같은 '예약됨' 라벨로 보이면 사장님이 진짜 예약처럼 오인.
        // post_mode 로 분기해서 라벨/색을 분리한다.
        if (s === 'scheduled') {
          if (r.post_mode === 'best-time') return { cls: 'posting', label: '최적 시간 대기' };
          if (r.post_mode === 'immediate') {
            // REELS 는 영상 처리 중임을 명시. PHOTO 는 transient 가 짧아 '곧 게시'.
            if (r.media_type === 'REELS' && !r.video_processed_at) {
              return { cls: 'posting', label: '영상 처리 중 · 곧 게시' };
            }
            return { cls: 'posting', label: '곧 게시' };
          }
          return { cls: 'scheduled', label: '예약됨' };
        }

        const map = {
          pending:  { cls: 'pending',   label: '캡션 작성 중' },
          draft:    { cls: 'draft',     label: '초안 · 복사용' },
          ready:    { cls: 'ready',     label: '준비 완료' },
          posting:  { cls: 'posting',   label: '게시 중' },
          posted:   { cls: 'posted',    label: '게시됨' },
          failed:   { cls: 'failed',    label: '실패' },
        };
        return map[s] || map.pending;
      }

      function captionPreview(r) {
        if (Array.isArray(r.captions) && typeof r.selected_caption_index === 'number') {
          const c = r.captions[r.selected_caption_index];
          if (c) return (c.text || c).slice(0, 80);
        }
        if (r.user_message) return r.user_message.slice(0, 80);
        return '';
      }

      function thumb(r) {
        if (Array.isArray(r.image_urls) && r.image_urls[0]) return r.image_urls[0];
        return null;
      }

      function renderItem(r) {
        const badge = statusBadge(r);
        const time = fmtTime(r.scheduled_at);
        const caption = captionPreview(r);
        // 초안 모드: 캡션 전체 복사 버튼 (게시 안 함 → 사장님이 직접 복사해 올림)
        let copyBtn = '';
        if ((r.caption_status || '') === 'draft') {
          const idx = (typeof r.selected_caption_index === 'number') ? r.selected_caption_index : 0;
          const cObj = Array.isArray(r.captions) ? r.captions[idx] : null;
          const fullCaption = cObj ? (cObj.text || cObj) : (caption || '');
          copyBtn = `<button class="res__copy" type="button" data-action="copy-caption" data-copy="${esc(String(fullCaption))}">📋 캡션 복사</button>`;
        }
        const t = thumb(r);
        // 액션 — '삭제' 버튼은 상단 "선택 삭제" / "모두 삭제" 로 일원화 (PR #232 이후 카드 제거).
        // 미게시 + 진행 중 row 만 '취소' 버튼 유지 (별도 의미).
        let actionBtn = '';
        if (!r.cancelled && !r.is_sent && ['scheduled', 'ready', 'pending', 'error'].includes(r.caption_status)) {
          actionBtn = `<button class="res__cancel" type="button" data-cancel="${esc(r.reserve_key)}" data-action="cancel">취소</button>`;
        }

        // 게시됨이면 캡션 평가 버튼 — tone_rated 가 false 일 때만 활성
        let rateBlock = '';
        if (r.is_sent && !r.cancelled) {
          const rated = r.tone_rated === true;
          rateBlock = `
            <div class="res__rate-wrap" data-rate-block data-rid="${esc(r.id || '')}" ${rated ? 'data-rated="1"' : ''}>
              ${rated ? `
                <div class="rate-thanks">평가해주셔서 감사해요. 다음 캡션 만들 때 참고할게요.</div>
              ` : `
                <div class="res__rate-row">
                  <button class="rate-btn" type="button" data-rate="like" aria-label="좋은 캡션">👍</button>
                  <button class="rate-btn" type="button" data-rate="dislike" aria-label="아쉬운 캡션">👎</button>
                  <span class="rate-hint">평가 + 코멘트 남기시면 다음 캡션에 반영해요</span>
                </div>
                <div class="rate-comment" data-rate-comment>
                  <textarea class="rate-comment__input" data-rate-comment-input maxlength="300" placeholder="왜 좋았어요? / 어디가 아쉬웠어요? (선택)"></textarea>
                  <div class="rate-comment__row">
                    <button class="rate-comment__btn" type="button" data-rate-comment-skip>코멘트 없이 저장</button>
                    <button class="rate-comment__btn rate-comment__btn--save" type="button" data-rate-comment-save>저장</button>
                  </div>
                </div>
              `}
            </div>`;
        }

        // 자막/오버레이 처리 실패 칩 — REELS 만 해당.
        // 2026-05-20 (E 재정의): process-video-background 가 ffmpeg/Whisper 실패 시
        // 원본 영상 그대로 publish 진행하면서 subtitle_status='skipped:<reason>' 만 DB 에
        // 기록 (사장님 무인지). 본 칩으로 history 에 가시화. reason 은 title 툴팁.
        let subtitleWarnChip = '';
        if (r.media_type === 'REELS' && typeof r.subtitle_status === 'string' && r.subtitle_status.startsWith('skipped:')) {
          const reason = r.subtitle_status.slice('skipped:'.length).trim() || '알 수 없는 사유';
          subtitleWarnChip = `<span class="chan-chip chan-chip--subtitle is-failed" title="${esc(reason)}">⚠️ 자막·오버레이 누락</span>`;
        }

        // 채널 칩 — 상태 라벨 본연 역할 (span). 클릭 진입점 아님.
        // 인사이트 진입 = 카드 전체 클릭 (posted 채널 있을 때만).
        // 재시도 진입 = failed 채널 옆의 별도 "↻ 다시 시도" 링크 (카드 밖에서 바로 보임).
        let chipBlock = '';
        if ((r.is_sent || r.caption_status === 'posting') && Array.isArray(r.channels) && r.channels.length) {
          const labelMap = { ig: '인스타', threads: '쓰레드' };
          const parts = r.channels
            .filter((c) => labelMap[c.channel])
            .map((c) => {
              const stCls = c.status === 'posted' ? 'is-posted' : (c.status === 'failed' ? 'is-failed' : 'is-posting');
              // failed 면 chip 라벨에 ⚠️ + "게시 실패" 명시 — 취소선만으론 약함
              const chipText = c.status === 'failed'
                ? `⚠️ ${labelMap[c.channel]} 게시 실패`
                : labelMap[c.channel];
              const chip = `<span class="chan-chip chan-chip--${esc(c.channel)} ${stCls}">${esc(chipText)}</span>`;
              if (c.status === 'failed') {
                const retry = `<button type="button" class="chan-retry" data-retry-link data-channel="${esc(c.channel)}" data-reservation-id="${esc(r.id)}" aria-label="${esc(labelMap[c.channel])} 게시 다시 시도">↻ 다시 시도</button>`;
                return chip + retry;
              }
              return chip;
            });
          if (parts.length) chipBlock = parts.join('');
        }

        // 카드 모든 채널 — posted / failed / posting 다 포함. 카드 click 진입 조건은
        // *posted 가 하나라도 있을 때* (선택 모드 OFF 일 때만). 모달 안 탭에서 모든 채널 상태 노출.
        // 선택 모드 ON 일 때는 모든 카드 click = 체크 토글 (body.is-select-mode 가 cursor 통제).
        // 직렬화: "ig:posted:<postId>,threads:failed:" (post_id 없으면 빈 문자열)
        const allChannelsArr = Array.isArray(r.channels)
          ? r.channels.filter((c) => c.channel === 'ig' || c.channel === 'threads')
          : [];
        const allChannelsStr = allChannelsArr
          .map((c) => `${c.channel}:${c.status || 'pending'}:${c.post_id || ''}`)
          .join(',');
        const hasPosted = allChannelsArr.some((c) => c.status === 'posted' && c.post_id);
        return `
          <li class="res${hasPosted ? ' is-clickable' : ''}" data-key="${esc(r.reserve_key)}"${allChannelsStr ? ` data-channels="${esc(allChannelsStr)}"` : ''}${hasPosted ? ` data-reservation-id="${esc(r.id)}"` : ''}>
            <span class="res__check" aria-hidden="true"></span>
            <div class="res__thumb"${t ? ` data-thumb="${esc(t)}"` : ''}></div>
            <div class="res__body">
              <div class="res__time">${esc(time)}</div>
              ${caption ? `<div class="res__caption">${esc(caption)}</div>` : ''}
              <div class="res__meta">
                <span class="res__badge badge--${esc(badge.cls)}">${esc(badge.label)}</span>
                ${chipBlock}
                ${subtitleWarnChip}
                ${actionBtn}
              </div>
              ${copyBtn}
              ${rateBlock}
            </div>
          </li>
        `;
      }

      // 초안 캡션 복사 (data-action="copy-caption") — 게시 안 하는 초안 모드용
      document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="copy-caption"]');
        if (!btn) return;
        const text = btn.dataset.copy || '';
        if (!text) return;
        const ok = () => toast('캡션 복사됐어요 — 인스타에 붙여넣어 올리세요 📷');
        const fail = () => toast('복사 실패 — 캡션을 길게 눌러 직접 복사해주세요');
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(ok).catch(fail);
        } else {
          fail();
        }
      });

      async function load() {
        // 15초 timeout — 서버 hang 시 무한 "불러오는 중" 방지
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 15_000);
        try {
          const res = await fetch('/api/list-reservations', { headers: authHeaders, signal: ctrl.signal });
          clearTimeout(tid);
          if (!res.ok) {
            stateEl.textContent = '히스토리를 불러오지 못했어요.';
            return;
          }
          const json = await res.json();
          const items = (json && json.items) || [];
          stateEl.hidden = true;

          // 외곽 emptyEl 은 사용 안 함 (탭별 메시지가 달라 혼동) — 탭 내부 placeholder 만 사용.
          if (emptyEl) emptyEl.hidden = true;

          const now = Date.now();
          const upcoming = [];
          const past = [];
          for (const r of items) {
            const t = r.scheduled_at ? new Date(r.scheduled_at).getTime() : 0;
            const isPast = r.is_sent || r.cancelled || (t && t < now);
            if (isPast) past.push(r); else upcoming.push(r);
          }
          upcoming.sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
          past.sort((a, b) => new Date(b.scheduled_at || b.submitted_at) - new Date(a.scheduled_at || a.submitted_at));

          // 두 리스트 모두 렌더 — 탭 전환 시 즉시 반영. 빈 리스트면 탭별 맞춤 placeholder.
          const upcomingEmpty = '<li class="empty"><div class="empty__icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg></div><div class="empty__title">예약된 게시가 없어요</div><p class="empty__sub">사진가 루미가 사진 직접 읽으려고 기다리고 있어요. 새 사진 한 장만 올려보세요.</p><a class="cta" href="/register-product">📷 사진 올리기</a></li>';
          const pastEmpty = '<li class="empty"><div class="empty__icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg></div><div class="empty__title">아직 게시 이력이 없어요</div><p class="empty__sub">편집장 루미가 첫 게시 잘 올라갔는지 확인해서 이력으로 남길게요.</p><a class="cta" href="/register-product">📷 사진 올리기</a></li>';
          upcomingList.innerHTML = upcoming.length ? upcoming.map(renderItem).join('') : upcomingEmpty;
          pastList.innerHTML = past.length ? past.slice(0, 30).map(renderItem).join('') : pastEmpty;
          // CSP: style-src 에 unsafe-inline 없음 → innerHTML 의 style 속성은 브라우저가 무시.
          // 썸네일 배경은 CSSOM 으로 지정 (dashboard [data-scheduled-thumb] 패턴 동일).
          // url 안 single-quote 는 encodeURI + %27 치환으로 context 탈출 차단.
          document.querySelectorAll('.res__thumb[data-thumb]').forEach((el) => {
            const u = el.getAttribute('data-thumb') || '';
            el.style.backgroundImage = `url('${encodeURI(u).replace(/'/g, '%27')}')`;
          });
          // 탭 표시 + 활성 탭에 따라 섹션 한 쪽만 노출
          if (tabsEl) tabsEl.hidden = false;
          if (tabsHintEl) tabsHintEl.hidden = false;
          if (tabToolsEl) tabToolsEl.hidden = false;
          applyTab();

          // 캡션 평가 — 2단계: 등급 선택 → 코멘트 입력(선택) → 저장
          document.querySelectorAll('[data-rate-block]').forEach(block => {
            if (block.dataset.rated === '1') return;
            const rid = Number(block.dataset.rid);
            if (!rid) return;
            const commentBox = block.querySelector('[data-rate-comment]');
            const commentInput = block.querySelector('[data-rate-comment-input]');
            const saveBtn = block.querySelector('[data-rate-comment-save]');
            const skipBtn = block.querySelector('[data-rate-comment-skip]');
            let chosenRating = null;

            // 등급 클릭 → 코멘트 박스 펼치기 (아직 서버 호출 X)
            block.querySelectorAll('[data-rate]').forEach(btn => {
              btn.addEventListener('click', () => {
                if (block.dataset.rated === '1') return;
                chosenRating = btn.dataset.rate;
                block.querySelectorAll('[data-rate]').forEach(b => {
                  b.classList.remove('is-active--like', 'is-active--dislike');
                });
                btn.classList.add(chosenRating === 'like' ? 'is-active--like' : 'is-active--dislike');
                if (commentBox) commentBox.classList.add('is-open');
                if (commentInput) setTimeout(() => commentInput.focus(), 100);
              });
            });

            async function submit(comment) {
              if (!chosenRating) {
                toast('먼저 👍 또는 👎 를 선택해주세요.');
                return;
              }
              if (saveBtn) saveBtn.disabled = true;
              if (skipBtn) skipBtn.disabled = true;
              try {
                const r = await fetch('/api/rate-caption', {
                  method: 'POST',
                  headers: { ...authHeaders, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ reservation_id: rid, rating: chosenRating, comment }),
                });
                if (!r.ok) throw new Error('실패');
                block.dataset.rated = '1';
                // 평가 성공 — block 안 모든 요소를 감사 메시지로 교체
                block.innerHTML = '<div class="rate-thanks">평가해주셔서 감사해요. 다음 캡션 만들 때 참고할게요.</div>';
              } catch (e) {
                if (saveBtn) saveBtn.disabled = false;
                if (skipBtn) skipBtn.disabled = false;
                toast('평가 저장에 실패했어요. 잠시 후 다시 시도해주세요.');
              }
            }
            if (saveBtn) {
              saveBtn.addEventListener('click', () => submit((commentInput && commentInput.value || '').trim()));
            }
            if (skipBtn) {
              skipBtn.addEventListener('click', () => submit(''));
            }
          });

          // 카드별 [삭제] 버튼은 PR #232 에서 제거 — 상단 "선택 삭제" / "모두 삭제" 로 일원화.

          // 취소 핸들러 (기존, 미게시 진행 중 row 전용) — /api/cancel-reservation
          // 더블탭 방지 + 15초 타임아웃 (네트워크/서버 지연 시 "취소 중…" 매달림 방지)
          document.querySelectorAll('[data-cancel]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
              e.preventDefault();
              if (btn.dataset.busy === '1') return;
              const action = btn.dataset.action || 'cancel';
              const isDelete = action === 'delete';
              const confirmMsg = isDelete ? '실패한 예약을 삭제할까요?' : '이 예약을 취소할까요?';
              if (!confirm(confirmMsg)) return;
              const key = btn.dataset.cancel;
              btn.dataset.busy = '1';
              btn.disabled = true;
              btn.textContent = isDelete ? '삭제 중…' : '취소 중…';
              const ctrl = new AbortController();
              const tid = setTimeout(() => ctrl.abort(), 15000);
              try {
                const r = await fetch('/api/cancel-reservation', {
                  method: 'POST',
                  headers: { ...authHeaders, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ reserve_key: key }),
                  signal: ctrl.signal,
                });
                if (!r.ok) throw new Error('실패');
                // 낙관적 UI — 취소된 카드 즉시 DOM 에서 제거.
                // 이전엔 load() 결과를 await 해서 버튼이 "취소 중…" 에 매달림.
                // load() 가 hang 하면 (직전 list-reservations 무한 로딩 이슈 등)
                // 버튼이 그대로 멈춰 보이던 버그.
                const li = btn.closest('li');
                if (li) li.remove();
                // 백그라운드로 최신 상태 동기화 — 실패해도 위 DOM 제거는 이미 반영.
                load();
              } catch (e) {
                toast(isDelete ? '삭제에 실패했어요. 잠시 후 다시 시도해주세요.' : '취소에 실패했어요.');
                btn.disabled = false;
                btn.textContent = isDelete ? '삭제' : '취소';
                btn.dataset.busy = '0';
              } finally {
                clearTimeout(tid);
              }
            });
          });
        } catch (e) {
          clearTimeout(tid);
          stateEl.textContent = e && e.name === 'AbortError'
            ? '시간이 초과됐어요. 새로고침해주세요.'
            : '히스토리를 불러오지 못했어요.';
        }
      }

      // 모두 삭제 — 활성 탭의 항목만 일괄. soft delete + 옵션으로 원본 게시물도 함께.
      if (bulkBtn) {
        bulkBtn.addEventListener('click', () => {
          const scope = activeTab === 'past' ? 'past' : 'upcoming';
          const scopeLabel = scope === 'past' ? '게시 기록' : '예약된 게시';
          openDelModal({
            title: `${scopeLabel} 전체를 삭제할까요?`,
            body: `현재 탭의 모든 ${scopeLabel}이 히스토리에서 사라져요.`,
            requireTyping: false,
            showMediaOption: scope === 'past', // 미게시 row 는 원본 게시물 없음 → 옵션 숨김
            onConfirm: async ({ deleteMedia }) => {
              bulkBtn.disabled = true;
              const ctrl = new AbortController();
              const tid = setTimeout(() => ctrl.abort(), 60000);
              try {
                const r = await fetch('/api/delete-reservations-bulk', {
                  method: 'POST',
                  headers: { ...authHeaders, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ scope, deleteMedia: !!deleteMedia }),
                  signal: ctrl.signal,
                });
                const json = await r.json().catch(() => ({}));
                if (!r.ok || !json.success) throw new Error(json.error || '실패');
                announceMediaResults(json.mediaSummary);
                const targetList = scope === 'past' ? pastList : upcomingList;
                if (targetList) targetList.innerHTML = '';
                load();
              } catch (err) {
                toast('일괄 삭제에 실패했어요. 잠시 후 다시 시도해주세요.');
              } finally {
                clearTimeout(tid);
                bulkBtn.disabled = false;
              }
            },
          });
        });
      }

      // 부분 실패 안내 — alert 로 간단히 (베타 1명 기준)
      function announceMediaResults(summary) {
        if (!summary) return;
        const lines = [];
        if (summary.ig && (summary.ig.deleted || summary.ig.failed)) {
          lines.push(`인스타 — 삭제 ${summary.ig.deleted}건, 실패 ${summary.ig.failed}건`);
        }
        if (summary.threads && (summary.threads.deleted || summary.threads.failed)) {
          lines.push(`쓰레드 — 삭제 ${summary.threads.deleted}건, 실패 ${summary.threads.failed}건`);
        }
        if (lines.length && (summary.ig?.failed || summary.threads?.failed)) {
          alert('원본 게시물 삭제 결과:\n' + lines.join('\n'));
        }
      }

      // 선택 삭제 모드 — body 에 .is-select-mode 토글 + 체크 카운트 동기.
      const selectModeBtn    = document.querySelector('[data-select-mode]');
      const selectConfirmBtn = document.querySelector('[data-select-confirm]');
      const selectCancelBtn  = document.querySelector('[data-select-cancel]');
      const toolsDefault     = document.querySelector('[data-tools-default]');
      const toolsSelect      = document.querySelector('[data-tools-select]');
      const selectedKeys = new Set();
      function enterSelectMode() {
        selectedKeys.clear();
        updateSelectCount();
        document.body.classList.add('is-select-mode');
        if (toolsDefault) toolsDefault.hidden = true;
        if (toolsSelect)  toolsSelect.hidden  = false;
      }
      function exitSelectMode() {
        selectedKeys.clear();
        document.body.classList.remove('is-select-mode');
        document.querySelectorAll('.res.is-checked').forEach((el) => el.classList.remove('is-checked'));
        if (toolsDefault) toolsDefault.hidden = false;
        if (toolsSelect)  toolsSelect.hidden  = true;
      }
      function updateSelectCount() {
        const n = selectedKeys.size;
        if (selectConfirmBtn) {
          selectConfirmBtn.textContent = `선택 삭제 (${n}건)`;
          selectConfirmBtn.disabled = n === 0;
        }
      }
      selectModeBtn?.addEventListener('click', enterSelectMode);
      selectCancelBtn?.addEventListener('click', exitSelectMode);

      // 선택 모드 카드 click — 체크 토글. capture 단계에서 인사이트 모달 진입 핸들러
      // 앞서 가로챈다. cancel/chan-retry 등은 CSS pointer-events:none 으로 차단됨.
      document.addEventListener('click', (e) => {
        if (!document.body.classList.contains('is-select-mode')) return;
        const card = e.target.closest('.res');
        if (!card) return;
        e.preventDefault();
        e.stopPropagation();
        const key = card.dataset.key;
        if (!key) return;
        if (card.classList.contains('is-checked')) {
          card.classList.remove('is-checked');
          selectedKeys.delete(key);
        } else {
          card.classList.add('is-checked');
          selectedKeys.add(key);
        }
        updateSelectCount();
      }, true);

      selectConfirmBtn?.addEventListener('click', () => {
        if (selectedKeys.size === 0) return;
        const keys = Array.from(selectedKeys);
        const isPast = activeTab === 'past';
        openDelModal({
          title: `선택한 ${keys.length}건을 삭제할까요?`,
          body: '히스토리에서 사라져요.',
          requireTyping: false,
          showMediaOption: isPast, // 미게시 row 는 원본 없음
          onConfirm: async ({ deleteMedia }) => {
            const ctrl = new AbortController();
            const tid = setTimeout(() => ctrl.abort(), 60000);
            try {
              const r = await fetch('/api/delete-reservations-bulk', {
                method: 'POST',
                headers: { ...authHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ scope: 'selected', reserveKeys: keys, deleteMedia: !!deleteMedia }),
                signal: ctrl.signal,
              });
              const json = await r.json().catch(() => ({}));
              if (!r.ok || !json.success) throw new Error(json.error || '실패');
              announceMediaResults(json.mediaSummary);
              exitSelectMode();
              load();
            } catch (err) {
              toast('선택 삭제에 실패했어요. 잠시 후 다시 시도해주세요.');
            } finally {
              clearTimeout(tid);
            }
          },
        });
      });

      load();

      // 자동 폴링 — 진행 중 reservation 이 하나라도 있으면 5초 마다 refresh.
      // 2026-05-15: register-product 가 reserve 응답 받으면 즉시 history 이동 (UX 개선).
      // 사용자가 화면 보고 있을 때 게시 완료 실시간 반영 → 새로고침 없이 결과 확인.
      // visibilitychange (탭 다시 활성화) 도 trigger.
      const POLL_MS = 5000;
      let pollTimer = null;
      function shouldPoll() {
        // _currentItems 갱신 시점 별도라 DOM 의 active badge 로 판단.
        const activeBadges = document.querySelectorAll('.res__badge.badge--pending, .res__badge.badge--posting, .res__badge.badge--ready');
        return activeBadges.length > 0;
      }
      function startPoll() {
        if (pollTimer) return;
        pollTimer = setInterval(() => {
          if (document.visibilityState !== 'visible') return;
          if (!shouldPoll()) { clearInterval(pollTimer); pollTimer = null; return; }
          load();
        }, POLL_MS);
      }
      // 페이지 로드 직후 한 번 진행 중 항목 있는지 검사. 없으면 polling skip.
      setTimeout(() => { if (shouldPoll()) startPoll(); }, 1000);
      // 다시 활성화 시 한 번 refresh
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          load();
          setTimeout(() => { if (shouldPoll()) startPoll(); }, 500);
        }
      });
    })();
