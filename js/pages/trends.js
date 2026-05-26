    (function () {
      const token =
        localStorage.getItem('lumi-auth') ||
        localStorage.getItem('lumi_auth') ||
        localStorage.getItem('seller_jwt');
      const authHeaders = token ? { Authorization: 'Bearer ' + token } : {};

      // 로그아웃 — topbar [data-logout] (2026-05-16 사장님: 모든 탭에 로그아웃)
      document.querySelectorAll('[data-logout]').forEach(btn => {
        btn.addEventListener('click', () => {
          if (!confirm('로그아웃 하시겠어요?')) return;
          ['lumi-auth','lumi_auth','seller_jwt'].forEach(k => {
            try { localStorage.removeItem(k); } catch {}
          });
          try { sessionStorage.clear(); } catch {}
          location.href = '/';
        });
      });

      // HTML escape — GPT 응답·키워드·소스 URL 모두 innerHTML 삽입 전 통과.
      // GPT prompt injection 으로 응답에 <img onerror> 같은 게 섞일 가능성 차단.
      function esc(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      const listEl = document.querySelector('[data-kw-list]');
      const stateEl = document.querySelector('[data-state]');
      const catLabel = document.querySelector('[data-cat-label]');
      const catTime = document.querySelector('[data-cat-time]');
      const majorTabsEl = document.querySelector('[data-major-tabs]');
      const sheet = document.querySelector('[data-sheet]');
      const backdrop = document.querySelector('[data-sheet-backdrop]');
      const sheetTitle = document.querySelector('[data-sheet-title]');
      const sheetBody = document.querySelector('[data-sheet-body]');

      const C = window.LumiCategories;
      // 트렌드 페이지에서 그룹 머지 시 제외할 sub (categories.js 전역 정의는 유지)
      const HIDDEN_CATS = new Set(['pet']);
      function visibleSubs(group) {
        return (group && group.subs) ? group.subs.filter(s => !HIDDEN_CATS.has(s.id)) : [];
      }
      // 트렌드는 대분류 단위로만 표시 — 소분류 칩 없음.
      // currentCategory 는 keyword-detail 호출용 fallback sub id (sheet 클릭 시 각 item.sourceSub 우선).
      let currentMajor = C.findMajorBySub(C.defaultSub).id;
      let currentCategory = (visibleSubs(C.findGroup(currentMajor))[0] || { id: C.defaultSub }).id;
      // 마지막으로 렌더한 키워드 객체들 — sheet 클릭 시 v2 메타 즉시 표시용
      let lastItems = [];

      function fmtTime(iso) {
        if (!iso) return '';
        try {
          const t = new Date(iso);
          return `${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')} 갱신`;
        } catch { return ''; }
      }

      // 대분류 5탭 렌더 — 소분류 칩은 없음 (그룹 안 모든 sub 키워드 머지 표시)
      function renderMajorTabs() {
        majorTabsEl.innerHTML = C.MAJOR_GROUPS.map(g =>
          `<button class="major-tab${g.id === currentMajor ? ' is-active' : ''}" type="button" data-major="${g.id}">${g.label}</button>`
        ).join('');
        majorTabsEl.querySelectorAll('.major-tab').forEach(btn => {
          btn.addEventListener('click', () => {
            const id = btn.dataset.major;
            if (!id || id === currentMajor) return;
            currentMajor = id;
            const group = C.findGroup(id);
            const visible = visibleSubs(group);
            // currentCategory 는 sheet 의 keyword-detail 호출용 fallback sub id
            currentCategory = (visible[0] || group.subs[0]).id;
            // 사장님이 보던 대분류 유지 — 새로고침 시 hash 로 복원.
            try { history.replaceState(null, '', '#major=' + id); } catch (_) {}
            renderMajorTabs();
            stateEl.textContent = '키워드 고르는 중…';
            listEl.innerHTML = '<li class="state" data-state>작가 루미가 키워드 고르는 중…</li>';
            loadTrends();
          });
        });
      }

      // 페이지 로드 시 hash 의 major 값 우선 → detectCategory 보다 우선.
      // 사장님이 "패션" 매장이라도 "음식" 대분류 보다 새로고침하면 그대로 유지.
      function applyHashMajor() {
        const m = (location.hash || '').match(/major=([a-z0-9_-]+)/i);
        if (!m) return false;
        const id = m[1];
        if (C.findGroup(id)) {
          currentMajor = id;
          const group = C.findGroup(id);
          const visible = visibleSubs(group);
          currentCategory = (visible[0] || group.subs[0]).id;
          return true;
        }
        return false;
      }

      // 사장님 매장 카테고리 결정 (실패 시 기본 그룹 유지). sub → 대분류 자동 도출.
      async function detectCategory() {
        try {
          const res = await fetch('/api/me', { headers: authHeaders });
          if (!res.ok) return;
          const data = await res.json();
          // /api/me 는 sellers.industry 를 그대로 반환 (data.seller.industry).
          const cat =
            (data.seller && (data.seller.industry || data.seller.category)) ||
            data.category ||
            (data.user && data.user.category);
          if (cat) {
            const sub = String(cat).toLowerCase();
            // 대분류만 도출 — currentCategory(fallback sub) 도 visible sub 으로 갱신.
            if (C.SUB_TO_MAJOR[sub]) {
              currentMajor = C.SUB_TO_MAJOR[sub];
              const grp = C.findGroup(currentMajor);
              const visible = visibleSubs(grp);
              currentCategory = (visible.find(s => s.id === sub) || visible[0] || { id: sub }).id;
            }
          }
        } catch {}
      }

      // 그룹 안 모든 visible sub 를 parallel fetch 후 키워드 머지.
      // 같은 키워드가 여러 sub 에 있으면 sourceRank 작은 쪽 우선 + velocityPct 보존.
      // 정렬: velocityPct desc > sourceRank asc.
      async function fetchGroupTrends(group) {
        const subs = visibleSubs(group);
        if (subs.length === 0) return { items: [], categoryLabel: group.label, updatedAt: null };
        // sub 가 parent + subcat 필드 있으면 (서브카테고리 분기) ?category=parent&subcat=value 형태 호출.
        // 없으면 기존대로 sub.id 를 category 로 보냄.
        const settled = await Promise.allSettled(
          subs.map(s => {
            const url = s.parent && s.subcat
              ? `/api/get-trends?category=${encodeURIComponent(s.parent)}&subcat=${encodeURIComponent(s.subcat)}`
              : `/api/get-trends?category=${encodeURIComponent(s.id)}`;
            return fetch(url).then(r => r.ok ? r.json() : null).then(d => ({ sub: s, data: d }));
          })
        );
        const merged = new Map();
        let latestUpdatedAt = null;
        for (const r of settled) {
          if (r.status !== 'fulfilled' || !r.value || !r.value.data) continue;
          const { sub, data } = r.value;
          if (data.updatedAt && (!latestUpdatedAt || data.updatedAt > latestUpdatedAt)) latestUpdatedAt = data.updatedAt;
          const arr = Array.isArray(data.keywords) ? data.keywords : [];
          arr.forEach((kw, idx) => {
            const key = (kw.keyword || '').trim();
            if (!key) return;
            const prev = merged.get(key);
            // sourceSub 보존 — sheet 클릭 시 keyword-detail 의 category 파라미터로 사용
            if (!prev || idx < prev.sourceRank) {
              merged.set(key, { ...kw, sourceSub: sub.id, sourceRank: idx });
            } else {
              // 다른 sub 에서 같은 키워드 velocity 가 더 강하면 메타만 보강
              const v = typeof kw.velocityPct === 'number' ? kw.velocityPct : -Infinity;
              const pv = typeof prev.velocityPct === 'number' ? prev.velocityPct : -Infinity;
              if (v > pv) prev.velocityPct = kw.velocityPct;
            }
          });
        }
        // ranking 정렬 — signal_tier 우선 (Option B, 사장님 결정 2026-05-15).
        //
        // 1차 정렬: signalTier (strong > medium > weak)
        //   strong: cross_source ≥2 / 검색량 ≥5k / velocity ≥30% 중 2개 이상 충족
        //   medium: 1개 충족
        //   weak:   0개
        //
        // 2차 정렬 (같은 tier 내): weightedScore desc
        //   weightedScore 는 backend computeWeightedScore() 가 산출:
        //     base (counts × source 다양성 ≥2 면 ×1.5) + log(monthly) × 0.3 + log(velocity+1) × 0.5
        //   = cross_source 다양성 + 검색량 + velocity 종합. 검색량 매칭 실패한 신조어도
        //     cross_source/velocity 가 강하면 같은 tier 내 상위 위치.
        //
        // 변경 이력:
        //   - 이전 (PR #175+ Option F): monthlySearchTotal × confidence × (1+v/100) 만 사용.
        //     검색량 매칭 실패한 신조어는 -weightedScore (음수) 로 매칭 성공 키워드 뒤로
        //     강제 밀림. cross_source 4곳 + velocity 200% strong 신조어가 묻힘 → 사장님이
        //     활용할 떠오르는 트렌드가 안 보이는 부작용.
        //   - 신규 (Option B, 2026-05-15): tier 우선 → 신호 강한 키워드가 검색량 유무
        //     무관하게 상위. detail sheet "왜 이 순위?" 가 검색량 미수집 사유 명시.
        //
        // root_morpheme · datalab_estimate 환산값은 여전히 사용 안 함 (거짓 신호 정책 유지).
        function tierRank(tier) {
          if (tier === 'strong') return 2;
          if (tier === 'medium') return 1;
          return 0; // weak 또는 undefined
        }
        function rankScore(k) {
          // tier × 1000 으로 tier 가 절대 우선. weightedScore 는 보통 < 60 이라 안전.
          const tier = tierRank(k.signalTier);
          const ws = typeof k.weightedScore === 'number' ? k.weightedScore : 0;
          return tier * 1000 + ws;
        }
        const sorted = Array.from(merged.values()).sort((a, b) => {
          const sa = rankScore(a);
          const sb = rankScore(b);
          if (sa !== sb) return sb - sa;
          return a.sourceRank - b.sourceRank;  // tie-breaker (sub-category 우선순위)
        });
        return { items: sorted, categoryLabel: group.label, updatedAt: latestUpdatedAt };
      }

      async function loadTrends() {
        try {
          const group = C.findGroup(currentMajor);
          const data = await fetchGroupTrends(group);
          if (catLabel) catLabel.textContent = data.categoryLabel || '트렌드';
          if (catTime) catTime.textContent = fmtTime(data.updatedAt);
          // 1위 ~ 10위 한정. 그 이하는 신호 약해 의사결정 가치 ↓.
          // sort 기준은 velocity desc > sourceRank asc (renderV2MetaSection 의
          // "신호 강도" 섹션에서 사용자에게 근거 노출).
          const items = (data.items || []).slice(0, 10);
          lastItems = items;
          if (items.length === 0) {
            stateEl.textContent = '아직 수집된 키워드가 없어요.';
            return;
          }
          listEl.innerHTML = items.map((item, idx) => {
            const rank = idx + 1;
            const kw = item.keyword || '';
            const trend = item.trend || '';
            const trendClass = trend === 'up' ? ' kw-item__trend--up' : trend === 'down' ? ' kw-item__trend--down' : '';
            const trendIcon = trend === 'up'
              ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 9 12 3 6 9"/><line x1="12" y1="3" x2="12" y2="21"/></svg>'
              : trend === 'down'
              ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 15 12 21 18 15"/><line x1="12" y1="3" x2="12" y2="21"/></svg>'
              : '';
            // v2 신호 메타 배지: 월간 검색량 + 🔥 급등 (velocity ≥ 50%) + 다중 소스
            const velocity = typeof item.velocityPct === 'number' ? item.velocityPct : null;
            const isHot = velocity !== null && velocity >= 50;
            const isWeak = item.signalTier === 'weak';
            const badges = [];
            // 사장님 요청 (2026-05-13): 순위 list 에서는 검색량 표시 제거.
            //   클릭 시 detail sheet 의 "왜 이 순위?" 섹션에서 정확한 검색량 노출.
            //   list 카드엔 상승률 (velocity) + 소스 다양성만 — 시각 노이즈 ↓.
            if (isHot) badges.push(`<span class="kw-badge kw-badge--hot">🔥 +${Math.round(velocity)}%</span>`);
            // 다중 소스 신뢰도 — 2곳 이상에서 잡힌 키워드만 표시 (1곳은 노이즈 가능)
            const srcCount = typeof item.crossSourceCount === 'number' ? item.crossSourceCount : null;
            if (srcCount !== null && srcCount >= 2) {
              badges.push(`<span class="kw-badge kw-badge--src" title="${srcCount}개 소스에서 잡힘">${srcCount}곳</span>`);
            }
            const badgeHtml = badges.length ? `<span class="kw-item__badges">${badges.join('')}</span>` : '';
            const itemClass = 'kw-item' + (isWeak ? ' kw-item--weak' : '');
            return `
              <li>
                <button class="${itemClass}" type="button" data-kw="${encodeURIComponent(kw)}">
                  <span class="kw-item__rank">${rank}</span>
                  <span class="kw-item__text">${esc(kw)}</span>
                  ${badgeHtml}
                  <span class="kw-item__trend${trendClass}">${trendIcon}</span>
                </button>
              </li>
            `;
          }).join('');

          // 클릭 핸들러 — idx 기반으로 lastItems 객체 전달
          listEl.querySelectorAll('.kw-item').forEach((btn, idx) => {
            btn.addEventListener('click', () => {
              const item = lastItems[idx] || { keyword: decodeURIComponent(btn.dataset.kw) };
              openSheet(item);
            });
          });

          // ?q=KEYWORD 자동 펼치기 — lastItems 에서 일치 검색, 없으면 minimal
          const params = new URLSearchParams(location.search);
          const q = params.get('q');
          if (q) {
            const found = lastItems.find(i => i.keyword === q) || { keyword: q };
            openSheet(found);
          }
        } catch (e) {
          stateEl.textContent = '키워드를 가져오지 못했어요.';
        }
      }

      // sheet 안 v2 메타(narrative/origin/sources/saturation) — 수집 시점에 cron 이 모은 신호.
      // keyword-detail 의 GPT 즉석 해석 도착 전에 즉시 보여줌.
      function renderV2MetaSection(item) {
        if (!item) return '';
        const blocks = [];

        // 0) "왜 이 순위?" — 사장님이 1위 키워드의 근거를 알 수 있도록 명시.
        //    monthlySearchTotal(실 검색량) + velocityPct(상승률) + crossSourceCount(소스 다양성) 종합.
        const rankSignals = [];
        // 1차 정렬 기준 — 네이버 검색광고 API 의 월간 PC + 모바일 합산.
        // 신뢰도 등급별로 다른 라벨 노출 — 사장님이 정확/근사/추정 판단 가능.
        if (typeof item.monthlySearchTotal === 'number' && item.monthlySearchTotal > 0) {
          const total = item.monthlySearchTotal;
          const svType = item.searchVolumeMatchType;
          const root = item.searchVolumeRootKeyword || '';
          let icon = '🔎';
          if (total >= 100000) icon = '🚀';
          else if (total >= 10000) icon = '🔥';
          else if (total >= 1000) icon = '📈';

          if (svType === 'exact' || svType === 'normalized') {
            rankSignals.push(`${icon} 월간 검색량 <strong>${total.toLocaleString()}회</strong> (네이버 PC + 모바일, 정확)`);
          } else {
            // root_morpheme · datalab_estimate 등 직접 매칭 외 모든 케이스 — raw 노출 X.
            // 사용자 지시 2026-05-14: 네이버 광고 API 가 직접 검색량을 못 주는 키워드는
            // 사람들이 사실상 검색 안 하는 것 = 트렌드 아님. root 검색량/환산값 노출은 거짓 신호.
            rankSignals.push(`<span style="color:var(--ink-muted);">검색량 정확 매칭 실패 — 네이버 키워드 도구에 직접 데이터 없음</span>`);
          }
        } else if (item.signalTier !== 'weak') {
          rankSignals.push(`<span style="color:var(--ink-muted);">검색량 미수집 — 네이버 키워드 도구에 데이터 없음 (새로 떠오르는 신호일 수 있음)</span>`);
        }
        // 2차 — 상승률 가산점
        const v = typeof item.velocityPct === 'number' ? item.velocityPct : null;
        if (v !== null) {
          if (v >= 50) rankSignals.push(`🔥 상승률 <strong>+${Math.round(v)}%</strong> (전 cron 대비)`);
          else if (v > 0) rankSignals.push(`📈 상승률 +${Math.round(v)}%`);
          else if (v <= -30) rankSignals.push(`📉 ${Math.round(v)}% 하락 중`);
          else rankSignals.push(`📊 상승률 ${Math.round(v)}% (안정)`);
        }
        const csc = typeof item.crossSourceCount === 'number' ? item.crossSourceCount : null;
        if (csc !== null && csc >= 2) {
          rankSignals.push(`🔁 <strong>${csc}개 소스</strong>에서 동시 노출`);
        } else if (csc === 1) {
          rankSignals.push(`⚠️ 1개 소스만 등장 (약한 신호)`);
        }
        if (rankSignals.length) {
          blocks.push(`
            <div class="sheet__section sheet__section--rank">
              <div class="sheet__label">왜 이 순위?</div>
              <ul class="sheet__rank-list">
                ${rankSignals.map(s => `<li>${s}</li>`).join('')}
              </ul>
              <p class="sheet__meta-line" style="margin-top:6px;">정렬: 신호 강도(강함 > 보통 > 약함) 우선, 그 안에서 종합 점수(cross-source 다양성 + 검색량 + 상승률) 내림차순. 검색량 정확매칭 실패해도 다른 신호(소스 다양성·상승률)가 강하면 상위 노출.</p>
            </div>
          `);
        }

        // 1) cron 이 추출 시 GPT 가 만든 한줄 요약 (narrative) + 출처 단서 (origin)
        if (item.narrative || item.origin) {
          const lines = [];
          if (item.narrative) lines.push(`<p class="sheet__text">${esc(item.narrative)}</p>`);
          if (item.origin)    lines.push(`<p class="sheet__meta-line">${esc(item.origin)}</p>`);
          blocks.push(`
            <div class="sheet__section">
              <div class="sheet__label">루미 수집 메모</div>
              ${lines.join('')}
            </div>
          `);
        }

        // 2) 어디서 발견됐나 — sources 분포 (네이버/블로그/유튜브/인스타/뉴스/쇼핑)
        const SOURCE_LABELS = {
          naver: '네이버', datalab: '네이버', blog: '블로그',
          youtube: '유튜브', yt: '유튜브', ytKR: '유튜브',
          ig: '인스타', insta: '인스타',
          news: '뉴스',
          shopping: '쇼핑',  // 네이버 쇼핑인사이트 (의류/뷰티/꽃·식품·운동·헤어 카테고리 강도)
        };
        if (item.sources && typeof item.sources === 'object') {
          const chips = Object.entries(item.sources)
            .filter(([, count]) => Number(count) > 0)
            .sort(([, a], [, b]) => Number(b) - Number(a))
            .map(([key, count]) =>
              `<span class="sheet__source-chip">${esc(SOURCE_LABELS[key] || key)}<strong>${esc(count)}</strong></span>`
            );
          if (chips.length) {
            blocks.push(`
              <div class="sheet__section">
                <div class="sheet__label">어디서 봤나요</div>
                <div class="sheet__source-chips">${chips.join('')}</div>
              </div>
            `);
          }
        }

        // 3) 신호 강도 — signalTier / saturationLevel / 사용자 피드백
        //    Tier 는 backend classifySignalTier() 가 산출:
        //    cross_source ≥2 / 검색량 ≥5k / velocity ≥30% 중 충족 개수 → strong(2+)/medium(1)/weak(0)
        //    구체 수치는 sheet 상단 "왜 이 순위?" 섹션이 이미 노출하므로 여기선 tier 라벨만.
        const signals = [];
        if (item.signalTier === 'strong')      signals.push('확실 신호 (3개 지표 중 2개 이상 강함)');
        else if (item.signalTier === 'medium') signals.push('주목 신호 (1개 지표 강함)');
        else if (item.signalTier === 'weak')   signals.push('약한 신호 (지표 모두 약함)');
        if (item.saturationLevel === 'low')    signals.push('포화도 낮음 (덜 흔함)');
        if (item.saturationLevel === 'high')   signals.push('포화도 높음 (이미 흔함)');
        if (typeof item.likes === 'number'    && item.likes > 0)    signals.push(`👍 ${item.likes}`);
        if (typeof item.dislikes === 'number' && item.dislikes > 0) signals.push(`👎 ${item.dislikes}`);
        if (signals.length) {
          blocks.push(`
            <div class="sheet__section">
              <div class="sheet__label">신호</div>
              <p class="sheet__meta-line">${signals.join(' · ')}</p>
            </div>
          `);
        }

        if (!blocks.length) return '';
        return blocks.join('') + '<div class="sheet__divider"></div>';
      }

      function openSheet(item) {
        // 호환: 옛 호출이 keyword 문자열만 넘기면 객체로 감싸기
        if (typeof item === 'string') item = { keyword: item };
        const keyword = item.keyword || '';
        // 머지 결과 item 에 sourceSub 있으면 우선 — keyword-detail 의 category 파라미터로 사용
        const cat = item.sourceSub || currentCategory;
        sheetTitle.textContent = '#' + keyword;
        const metaHtml = renderV2MetaSection(item);
        sheetBody.innerHTML = metaHtml + '<div class="state" data-detail-loading>잠시만요…</div>';
        backdrop.classList.add('is-open');
        sheet.classList.add('is-open');
        document.body.style.overflow = 'hidden';
        loadDetail(keyword, metaHtml, cat);
      }

      function closeSheet() {
        backdrop.classList.remove('is-open');
        sheet.classList.remove('is-open');
        document.body.style.overflow = '';
      }

      backdrop.addEventListener('click', closeSheet);
      document.querySelector('[data-sheet-close]')?.addEventListener('click', closeSheet);
      document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

      async function loadDetail(keyword, metaHtml = '', cat) {
        try {
          const useCat = cat || currentCategory;
          const url = `/api/keyword-detail?keyword=${encodeURIComponent(keyword)}&category=${encodeURIComponent(useCat)}`;
          const res = await fetch(url, { headers: authHeaders });
          const json = await res.json();
          if (res.status === 429) {
            sheetBody.innerHTML = metaHtml + '<div class="state">오늘 설명 한도를 다 썼어요. 내일 다시 시도해주세요.</div>';
            return;
          }
          if (!json.ok || !json.data) {
            sheetBody.innerHTML = metaHtml + '<div class="state">해석을 가져오지 못했어요.</div>';
            return;
          }
          const d = json.data;
          const sections = [];
          if (d.definition) {
            sections.push(`
              <div class="sheet__section">
                <div class="sheet__label">키워드</div>
                <p class="sheet__text">${esc(d.definition)}</p>
              </div>
            `);
          }
          if (d.audience) {
            sections.push(`
              <div class="sheet__section">
                <div class="sheet__label">누가 쓰나요</div>
                <p class="sheet__text">${esc(d.audience)}</p>
              </div>
            `);
          }
          if (d.why) {
            sections.push(`
              <div class="sheet__section">
                <div class="sheet__label">왜 뜨나요</div>
                <p class="sheet__text">${esc(d.why)}</p>
              </div>
            `);
          }
          // 사장님 결정 (2026-05-15): 활용 아이디어 섹션 제거. GPT 생성 ideas 가
          // 실용성 낮다고 판단. keyword-detail.js 의 ideas 필드는 유지하나 UI 노출 X.
          if (Array.isArray(d.hashtags) && d.hashtags.length > 0) {
            sections.push(`
              <div class="sheet__section">
                <div class="sheet__label">관련 해시태그</div>
                <div class="sheet__chips">
                  ${d.hashtags.map(h => `<span class="sheet__chip">#${esc(String(h).replace(/^#/, ''))}</span>`).join('')}
                </div>
              </div>
            `);
          }
          const detailHtml = sections.join('') || '<div class="state">해석이 비어 있어요.</div>';
          sheetBody.innerHTML = metaHtml + detailHtml;
        } catch {
          sheetBody.innerHTML = metaHtml + '<div class="state">해석을 가져오지 못했어요.</div>';
        }
      }

      // 시작 — hash 의 major 가 있으면 그것 우선, 없으면 사장님 매장 industry 기반 자동 결정.
      (async () => {
        const hashApplied = applyHashMajor();
        if (!hashApplied) await detectCategory();
        renderMajorTabs();
        await loadTrends();
      })();
    })();
