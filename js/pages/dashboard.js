    (function () {
      // 0) URL hash 의 lumi_token + lumi_refresh (카카오 callback 직후) → localStorage 저장.
      //    onboarded=true 사장님은 callback 이 /dashboard#lumi_token=... 으로 보냄.
      //    audit #2: refresh token 도 같이 받아서 자동 갱신 가능하게.
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
      // 토큰 없으면 즉시 / 로 — 인증 안 된 채 dashboard 떠 있으면 다음 탭 이동에서 튕김
      if (!token) { location.replace('/'); return; }
      const authHeaders = { Authorization: 'Bearer ' + token };

      // HTML escape — 트렌드 키워드(외부 cron 수집)·예약 캡션 등 innerHTML 삽입 전 항상 통과.
      function esc(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      // 사장님 카테고리 — loadMe 가 갱신, loadTrends/loadBestTime 이 사용. 미감지 시 'cafe' fallback.
      let userCategory = 'cafe';

      function setText(sel, text) {
        const el = document.querySelector(sel);
        if (el) {
          el.textContent = text;
          // v55: 값 도착 시 스켈레톤 자리 해제 (있을 때만 — 데이터 로직 무변경)
          el.classList.remove('skeleton', 'skeleton--text');
        }
      }

      // 매장 이름 + 카테고리
      async function loadMe() {
        try {
          const res = await fetch('/api/me', { headers: authHeaders });
          if (!res.ok) return;
          const data = await res.json();
          const name =
            data.store_name ||
            (data.seller && data.seller.store_name) ||
            (data.user && data.user.store_name);
          if (name) {
            document.querySelectorAll('[data-store-name]').forEach(el => { el.textContent = name; });
          }
          // /api/me 는 sellers.industry 반환. 옛 필드(category) 호환 보존.
          const cat =
            (data.seller && (data.seller.industry || data.seller.category)) ||
            data.category ||
            (data.user && data.user.category);
          if (cat) userCategory = String(cat).toLowerCase();

          // IG 토큰 만료 — 재연동 카드 노출. tokenExpired 표준 키 사용,
          // tokenInvalid 는 옛 응답 호환용 (PR #169 통일).
          const ig = data.igStatus || null;
          const reconnectSection = document.querySelector('[data-ig-reconnect-section]');
          if (reconnectSection && ig && ig.connected && (ig.tokenExpired || ig.tokenInvalid)) {
            reconnectSection.hidden = false;
          }

          // 2026-05-23 베타 흐름 — IG 미연동 사장님: 첫 연동 안내 카드 표시 + 다른 카드 숨김.
          // 트렌드/사장님 정보는 그대로 두고, 인스타 데이터 의존 카드만 hidden.
          // 탭 가드도 활성화 (사진 올리기·히스토리 클릭 시 모달).
          window.__lumiIgConnected = !!(ig && ig.connected);
          if (ig && !ig.connected) {
            const igRequiredCard = document.querySelector('[data-ig-connect-required-section]');
            if (igRequiredCard) igRequiredCard.hidden = false;
            // 시작 체크리스트 — 이미 한 단계는 ✓ 표시 (①잘되는 가게 분석 ②초안)
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
            // IG 데이터 의존 카드 숨김 — 빈 상태 노출 방지.
            // 트렌드(요즘 뜨는 키워드)·날씨·매장정보는 그대로 노출.
            ['[data-stat-row]', '[data-failure-banner]', '[data-scheduled-card]', '[data-scheduled-empty]'].forEach((sel) => {
              const el = document.querySelector(sel);
              if (el) el.hidden = true;
            });
            // 이번 주 / 다음 예약 / 베스트 시간 / 댓글 섹션 통째 숨김 — 미연동이라 무의미.
            ['sec-stats', 'sec-scheduled', 'sec-besttime', 'sec-comments'].forEach((id) => {
              const section = document.getElementById(id);
              const wrapperSection = section ? section.closest('section') : null;
              if (wrapperSection) wrapperSection.hidden = true;
            });
          }
          // M3.1 — Threads 토큰 만료 카드 (IG 와 독립적으로 노출 가능)
          const threads = data.threadsStatus || null;
          const threadsReconnect = document.querySelector('[data-threads-reconnect-section]');
          if (threadsReconnect && threads && threads.connected && threads.tokenExpired) {
            threadsReconnect.hidden = false;
          }
        } catch (e) {
          // 인증 실패 같은 critical 시나리오일 가능성 — devtools 에 로그 + 매장 정보 미수집.
          console.warn('[dashboard] /api/me 실패:', e && e.message);
        }
      }

      // 이번 주 좋아요·팔로워 (insight-weekly)
      // 신규 사용자(데이터 없음/0) → 카드 통째 숨기고 "첫 게시 후" 안내 카드 노출
      async function loadStats() {
        const statRow = document.querySelector('[data-stat-row]');
        const statEmpty = document.querySelector('[data-stat-empty]');
        let hasData = false;
        try {
          const res = await fetch('/api/insight-weekly', { headers: authHeaders });
          if (res.ok) {
            const json = await res.json();
            const data = json && json.data;
            if (data) {
              if (typeof data.likesTotal === 'number') {
                setText('[data-stat-likes]', data.likesTotal.toLocaleString());
                // 몰입 R2 — 실데이터 도착 순간 0→값 카운트업 (모션 비활성 환경선 미정의 → 스킵)
                if (window.lumiCountUp) window.lumiCountUp(document.querySelector('[data-stat-likes]'));
                if (data.likesTotal > 0) hasData = true;
              }
              if (typeof data.followers === 'number') {
                setText('[data-stat-followers]', data.followers.toLocaleString());
                if (window.lumiCountUp) window.lumiCountUp(document.querySelector('[data-stat-followers]'));
                if (data.followers > 0) hasData = true;
              }
              if (typeof data.followersChange === 'number' && data.followersChange !== 0) {
                const sign = data.followersChange > 0 ? '+' : '';
                setText('[data-stat-followers-delta]', sign + data.followersChange + ' 이번 주');
              }
            }
          }
        } catch (e) {
          console.warn('[dashboard] /api/insight-weekly 실패:', e && e.message);
        }
        // hasData=false (응답 실패 OR 모두 0) → 카드 숨기고 안내 표시
        if (!hasData) {
          if (statRow) statRow.hidden = true;
          if (statEmpty) statEmpty.hidden = false;
        }
      }

      // 요즘 뜨는 키워드 (get-trends) — 사장님 카테고리 기반
      async function loadTrends() {
        try {
          const res = await fetch('/api/get-trends?category=' + encodeURIComponent(userCategory));
          if (!res.ok) return;
          const json = await res.json();
          const tags = (json && json.tags) || [];
          if (tags.length === 0) return;
          const container = document.querySelector('[data-keywords]');
          if (!container) return;
          container.innerHTML = tags.slice(0, 5).map(tag => {
            const clean = String(tag).replace(/^#/, '');
            return `<a class="keyword-chip" href="/trends?q=${encodeURIComponent(clean)}">#${esc(clean)}</a>`;
          }).join('');
        } catch (e) {
          console.warn('[dashboard] /api/get-trends 실패:', e && e.message);
        }
      }

      // 다음 예약 (list-reservations 중 가장 가까운 미래)
      // 발행 실패 알림 (Blocker C, 2026-05-19)
      // 최근 7일 caption_status='failed'|'error' 또는 채널 발행 실패 건 카운트.
      // 사장님이 "올렸는데 안 올라갔다" 를 watchdog 메일 기다리지 않고 dashboard 에서 즉시 확인.
      async function loadFailures() {
        const banner = document.querySelector('[data-failure-banner]');
        if (!banner) return;
        try {
          const res = await fetch('/api/list-reservations', { headers: authHeaders });
          if (!res.ok) return;
          const json = await res.json();
          const items = (json && json.items) || [];
          const cutoff = Date.now() - 7 * 24 * 3600 * 1000; // 7일 cutoff
          const failed = items.filter(r => {
            const created = new Date(r.created_at || r.scheduled_at || 0).getTime();
            if (created < cutoff) return false;
            // 1) 명시적 실패 상태
            if (r.caption_status === 'failed' || r.caption_status === 'error') return true;
            // 2) scheduled 인데 scheduled_at 30분 이상 지났고 ig_post_id 없음 (stuck)
            const scheduledAt = r.scheduled_at ? new Date(r.scheduled_at).getTime() : 0;
            if (r.caption_status === 'scheduled' && !r.ig_post_id && scheduledAt && (Date.now() - scheduledAt > 30 * 60000)) return true;
            // 3) 채널 발행 실패 (channel_posts.status 가 failed/error 인 채널 존재)
            if (Array.isArray(r.channels) && r.channels.some(c => c.status === 'failed' || c.status === 'error')) return true;
            return false;
          });
          if (failed.length === 0) return;
          const countEl = banner.querySelector('[data-failure-count]');
          const reasonEl = banner.querySelector('[data-failure-reason]');
          if (countEl) countEl.textContent = String(failed.length);
          // 가장 흔한 실패 사유 한 줄 (가장 최근 실패의 caption_error)
          const latest = failed.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))[0];
          if (reasonEl && latest) {
            const err = (latest.caption_error || '').slice(0, 60);
            reasonEl.textContent = err ? err : '탭하면 자세히 볼 수 있어요';
          }
          banner.hidden = false;
        } catch (e) {
          console.warn('[dashboard] loadFailures 실패:', e && e.message);
        }
      }

      async function loadScheduled() {
        const cardEl = document.querySelector('[data-scheduled-card]');
        const emptyEl = document.querySelector('[data-scheduled-empty]');
        try {
          const res = await fetch('/api/list-reservations', { headers: authHeaders });
          if (!res.ok) return;
          const json = await res.json();
          const items = (json && json.items) || [];
          const now = Date.now();
          const next = items
            .filter(r => r.scheduled_at && new Date(r.scheduled_at).getTime() > now && !r.is_sent && !r.cancelled)
            .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))[0];
          if (!next) return;
          // 데이터 있음 → 카드 보이고 empty 숨김
          if (cardEl) cardEl.hidden = false;
          if (emptyEl) emptyEl.hidden = true;

          const t = new Date(next.scheduled_at);
          const today = new Date();
          const isToday = t.toDateString() === today.toDateString();
          const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
          const isTomorrow = t.toDateString() === tomorrow.toDateString();
          const hh = String(t.getHours()).padStart(2, '0');
          const mm = String(t.getMinutes()).padStart(2, '0');
          const day = isToday ? '오늘' : isTomorrow ? '내일' : `${t.getMonth() + 1}/${t.getDate()}`;
          setText('[data-scheduled-time]', `${day} ${hh}:${mm}`);

          if (next.title || next.caption) {
            const title = (next.title || next.caption).slice(0, 40);
            setText('[data-scheduled-title]', title);
          }
          if (next.image_url || next.thumbnail_url) {
            const thumb = document.querySelector('[data-scheduled-thumb]');
            // I-H (2026-05-15): CSS injection 차단 — URL 안 ')' / ';' 로 context 탈출 가능.
            // encodeURI + 싱글쿼터 escape + 싱글쿼터 감싸기 (history.html:1429 패턴 동일).
            if (thumb) {
              const rawUrl = String(next.image_url || next.thumbnail_url || '');
              const safeUrl = encodeURI(rawUrl).replace(/'/g, '%27');
              thumb.style.backgroundImage = `url('${safeUrl}')`;
              thumb.style.backgroundSize = 'cover';
              thumb.style.backgroundPosition = 'center';
            }
          }
          if (Array.isArray(next.channels) && next.channels.length > 0) {
            const labels = { ig: '인스타', tt: '틱톡', nblog: '블로그', kakao: '카톡 채널' };
            setText('[data-scheduled-channels]', next.channels.map(c => labels[c] || c).join(' · '));
          }
        } catch (e) {
          console.warn('[dashboard] /api/list-reservations 실패:', e && e.message);
        }
      }

      // 새 댓글 카드 (Phase 1: IG 미연동 안내 또는 빈 상태. 실제 댓글 fetch 는 Phase 2)
      async function loadComments() {
        const listEl = document.querySelector('[data-comments]');
        if (!listEl) return;
        try {
          const res = await fetch('/api/comments?limit=3', { headers: authHeaders });
          if (!res.ok) {
            listEl.innerHTML = '<li class="comments-card__item comments-card__empty"><span class="comments-card__text u-text-muted">댓글을 가져오지 못했어요.</span></li>';
            return;
          }
          const json = await res.json();
          const items = (json && json.items) || [];
          if (items.length === 0) {
            const msg = json.igConnected
              ? '아직 새 댓글이 없어요'
              : '인스타 연동 후 새 댓글이 여기 표시돼요';
            listEl.innerHTML = `<li class="comments-card__item comments-card__empty"><span class="comments-card__text u-text-muted">${msg}</span></li>`;
            return;
          }
          // 외부 IG 입력 → escape 필수.
          const esc = (s) => String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
          listEl.innerHTML = items.slice(0, 3).map(c => {
            const u = (c.username || c.from || '익명').slice(0, 24);
            const initial = (u[0] || '·').toUpperCase();
            const text = (c.text || '').slice(0, 60);
            const thumb = c.post_thumb
              ? `<img class="comments-card__post-thumb" src="${esc(c.post_thumb)}" alt="댓글 달린 게시물" loading="lazy">`
              : '';
            const inner = `
              <span class="comments-card__avatar">${esc(initial)}</span>
              <div class="comments-card__body">
                <div class="comments-card__user">${esc(u)}</div>
                <div class="comments-card__text">${esc(text)}</div>
              </div>
              ${thumb}
            `;
            // permalink 있으면 IG 게시물 새 탭으로 열기. 없으면 그냥 div.
            const link = c.permalink
              ? `<a href="${esc(c.permalink)}" target="_blank" rel="noopener noreferrer" class="comments-card__link">${inner}</a>`
              : `<div class="comments-card__link">${inner}</div>`;
            return `<li class="comments-card__item">${link}</li>`;
          }).join('');
          // 댓글이 있으면 위젯 끝에 "답글 달기·전체 보기" 링크 노출 (/comments 로 이동).
          const moreEl = document.querySelector('[data-comments-more]');
          if (moreEl) moreEl.hidden = false;
        } catch (e) {
          listEl.innerHTML = '<li class="comments-card__item comments-card__empty"><span class="comments-card__text u-text-muted">댓글을 가져오지 못했어요.</span></li>';
        }
      }

      // 베스트 시간 (get-best-time)
      // 응답: { bestTime, reason, tip, allSlots, weekday[], weekend[], source }
      // 오늘이 평일이면 weekday, 주말이면 weekend 슬롯 전체를 렌더. 현재 시각 이후
      // 가장 가까운 슬롯에 is-now 강조.
      async function loadBestTime() {
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
          // 사장님 결정 (2026-05-15 재정정): personal/seed 둘 다 슬롯 3개 표시.
          // seed 면 배지가 '업종 평균' 으로 명시 + 진행 카드 안내 ('내 베스트 시간 수집 중') 유지.
          const slots = (isWeekend ? json.weekend : json.weekday) || json.allSlots || [];
          const slotsEl = document.querySelector('[data-besttime-slots]');
          const titleEl = document.querySelector('[data-besttime]');
          const subEl = document.querySelector('[data-besttime-sub]');

          if (Array.isArray(slots) && slots.length) {
            // 현재 시각 + 30분 이후 가장 가까운 슬롯 = "다음 임박" 강조 대상.
            // 30분 마진 = 사진 찍고 캡션 생성·게시까지 걸리는 시간 여유.
            // 오늘 슬롯이 모두 지났으면(nowIdx = -1) 강조 없음 — "내일" 안내.
            const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
            const slotMins = slots.map(s => {
              const [hh, mm] = String(s.time || '0:0').split(':').map(Number);
              return hh * 60 + mm;
            });
            const nowIdx = slotMins.findIndex(m => m > nowMin + 30);
            const allPassed = nowIdx === -1;

            const esc = (s) => String(s == null ? '' : s)
              .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            slotsEl.innerHTML = slots.map((s, i) => {
              const isNow = i === nowIdx;
              const badge = isNow ? '<span class="besttime-slot__badge">다음 임박</span>' : '';
              return `
                <div class="besttime-slot${isNow ? ' is-now' : ''}">
                  <span class="besttime-slot__time">${esc(s.time || '—')}</span>
                  <span class="besttime-slot__reason">${esc(s.reason || '')}</span>
                  ${badge}
                </div>
              `;
            }).join('');
            slotsEl.hidden = false;
            // 기존 단일 title 숨김. 모드 배지 + 진행 카드로 사장님에게 현재 상태 안내.
            if (titleEl) titleEl.hidden = true;

            // ── 모드 배지 (오늘 요일 기준) ──
            const modes = (json && json.modes) || {};
            const todayMode = isWeekend ? modes.weekend : modes.weekday;
            const modeEl = document.querySelector('[data-besttime-mode]');
            const modeLabelEl = document.querySelector('[data-besttime-mode-label]');
            if (modeEl && modeLabelEl) {
              const personal = todayMode === 'personal';
              modeEl.classList.toggle('is-personal', personal);
              modeEl.classList.toggle('is-seed', !personal);
              modeLabelEl.textContent = personal ? '내 데이터' : '업종 평균';
              modeEl.hidden = false;
            }

            // ── 진행 카드 — seed 면 안내 표시, personal 이면 숨김 ──
            // 사장님 결정 (2026-05-15 재정정): personal 활성 시 안내 카드 hide.
            //   seed 면 슬롯 + 안내 ('업종 평균 표시 중, 내 데이터 모이면 정확해짐') 보존.
            const progress = (json && json.progress) || null;
            const thresholds = (json && json.thresholds) || { weekday: 5, weekend: 3 };
            const progressEl = document.querySelector('[data-besttime-progress]');
            const progressHintEl = document.querySelector('[data-besttime-progress-hint]');
            if (progressEl) {
              const isPersonalToday = todayMode === 'personal';
              progressEl.hidden = isPersonalToday;
            }
            if (false) {
              const tier2 = (json && json.tier2_progress) || null;
              const t2BothReady = !!(tier2 && tier2.weekday && tier2.weekday.ready && tier2.weekend && tier2.weekend.ready);
              const t1BothReady = !!progress.ready;
              if (t1BothReady && t2BothReady) {
                progressEl.hidden = true;
              } else {
                progressEl.hidden = false;
                // 1단계 — 팔로워 접속 시간 (Tier 1a). 단일 상태 표시 ✓/⏳ + 라벨.
                // weekday/weekend ready 가 동일 (online_followers 는 요일 분리 없음).
                const t1Ready = !!(progress.weekday && progress.weekday.ready);
                const stage1El = document.querySelector('[data-progress-stage="t1"]');
                const stage1IconEl  = stage1El?.querySelector('.besttime-progress__status-icon');
                const stage1StateEl = document.querySelector('[data-progress-state="t1"]');
                if (stage1El) stage1El.classList.toggle('is-ready', t1Ready);
                if (stage1IconEl)  stage1IconEl.textContent  = t1Ready ? '✓' : '⏳';
                // IG 연동됐는데 online_followers 데이터 아직 안 모인 경우는 "데이터 수집 중" 으로 정확히 안내.
                // 진짜 미연동만 "IG 연동 필요" 표시.
                const igOk = !!(json && json.ig_connected);
                if (stage1StateEl) stage1StateEl.textContent = t1Ready ? '활성' : (igOk ? '데이터 수집 중' : 'IG 연동 필요');
                // 2단계 — 내 팔로워 활동 데이터 (Tier 2). 1단계 미충족 시 locked.
                const stage2El = document.querySelector('[data-progress-stage="t2"]');
                if (stage2El) stage2El.classList.toggle('is-locked', !t1BothReady);
                ['weekday', 'weekend'].forEach((dow) => {
                  const p2 = (tier2 && tier2[dow]) || { snapshot_days: 0, needed_days: dow === 'weekend' ? 6 : 15, ready: false };
                  const have = Math.max(0, Number(p2.snapshot_days) || 0);
                  const need = Math.max(1, Number(p2.needed_days) || (dow === 'weekend' ? 6 : 15));
                  const ratio = Math.min(100, Math.round((have / need) * 100));
                  const fill = document.querySelector(`[data-progress-fill-t2="${dow}"]`);
                  const count = document.querySelector(`[data-progress-count-t2="${dow}"]`);
                  const row = document.querySelector(`[data-progress-row-t2="${dow}"]`);
                  if (fill) fill.style.width = (p2.ready ? 100 : ratio) + '%';
                  if (count) count.textContent = `${have}/${need}일`;
                  if (row) row.classList.toggle('is-ready', !!p2.ready);
                });
                // 사장님 결정 (2026-05-15): 단계별 progress / 분기 안내 제거.
                // HTML 의 정적 한 줄 안내 그대로 유지 (data-besttime-progress-hint).
              }
            }

            // sub 메시지 — 오늘 슬롯 다 지난 케이스 전용. 그 외는 숨김 (안내는 진행 카드가 담당).
            if (subEl) {
              if (allPassed) {
                subEl.textContent = '오늘 추천 시간은 모두 지났어요. 내일 다시 알려드릴게요.';
                subEl.hidden = false;
              } else {
                subEl.hidden = true;
              }
            }
          } else {
            // 폴백: 옛 단일 bestTime 표시 유지
            const bt = json && (json.bestTime || json.label);
            if (bt) {
              setText('[data-besttime]', bt + '에 올리면 좋아요');
              if (json.reason) setText('[data-besttime-sub]', json.reason);
            }
          }
        } catch (e) {
          console.warn('[dashboard] /api/get-best-time 실패:', e && e.message);
        }
      }

      // 로그아웃 — confirm + 토큰 삭제 + 홈으로. 모든 [data-logout] 에 일관 패턴 (2026-05-16).
      document.querySelectorAll('[data-logout]').forEach(btn => {
        btn.addEventListener('click', () => {
          if (!confirm('로그아웃 하시겠어요?')) return;
          ['lumi-auth', 'lumi_auth', 'seller_jwt', 'lumi_refresh'].forEach(k => {
            try { localStorage.removeItem(k); } catch {}
          });
          try { sessionStorage.clear(); } catch {}
          window.location.href = '/';
        });
      });

      // loadMe 가 userCategory 를 정한 뒤에 카테고리 의존 호출들이 시작되도록 순서 보장.
      // 오늘 날씨 (get-weather) — region 기반. region 없으면 카드 안 보임.
      async function loadWeather() {
        const cardEl = document.querySelector('[data-weather-card]');
        if (!cardEl) return;
        try {
          const res = await fetch('/api/get-weather', { headers: authHeaders });
          if (!res.ok) return;
          const j = await res.json();
          if (!j || !j.ok || j.noRegion || j.error) return;
          const setT = (sel, text) => { const el = cardEl.querySelector(sel); if (el) el.textContent = text || ''; };
          setT('[data-weather-emoji]', j.emoji || '🌤️');
          setT('[data-weather-region]', j.displayName || j.shortName || '');
          setT('[data-weather-temp]', (j.temperature != null ? j.temperature + '°' : ''));
          setT('[data-weather-status]', j.status || '');
          setT('[data-weather-mood]', j.mood || '');
          cardEl.hidden = false;
        } catch (e) {
          console.warn('[dashboard] /api/get-weather 실패:', e && e.message);
        }
      }

      // 2026-05-23 베타 흐름 — IG 미연동 사장님이 잠긴 탭 클릭 시 모달.
      // window.__lumiIgConnected 는 loadMe() 에서 설정. 그 전엔 undefined → 잠금 안 함 (안전 fallback).
      function showIgRequiredModal() {
        const modal = document.querySelector('[data-ig-required-modal]');
        if (!modal) return;
        modal.hidden = false;
        // 첫 포커스 — 접근성
        const confirm = modal.querySelector('.ig-required-modal__confirm');
        if (confirm) setTimeout(() => confirm.focus(), 50);
      }
      function hideIgRequiredModal() {
        const modal = document.querySelector('[data-ig-required-modal]');
        if (modal) modal.hidden = true;
      }
      document.querySelectorAll('[data-ig-guard]').forEach((el) => {
        el.addEventListener('click', (ev) => {
          // loadMe 가 아직 완료 안 된 경우 (__lumiIgConnected undefined) 는 그대로 통과.
          // 명시적으로 false 인 경우만 차단.
          if (window.__lumiIgConnected === false) {
            ev.preventDefault();
            showIgRequiredModal();
          }
        });
      });
      document.querySelectorAll('[data-ig-required-modal-close]').forEach((el) => {
        el.addEventListener('click', hideIgRequiredModal);
      });
      // ESC 키로 모달 닫기
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') hideIgRequiredModal();
      });

      // 카테고리 무관 호출(loadStats/loadScheduled/loadComments)은 병렬.
      (async () => {
        await loadMe();
        loadStats();
        loadFailures();
        loadScheduled();
        loadComments();
        loadTrends();
        loadBestTime();
        loadWeather();
      })();
    })();
