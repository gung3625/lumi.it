// dashboard-chat.js — 채팅형 명령창 + 사이드바 + 결과 캔버스 오케스트레이션
// 메모리 project_linear_canvas_ui_doctrine_0428.md
//
// 동작:
//   1. 좌측 사이드바: 즐겨찾기 + 업무 히스토리 (오늘/어제/7일/30일)
//   2. 중앙 캔버스: 기본=오늘 요약 위젯, 명령 시=결과 카드
//   3. 하단 명령창: 자연어 입력 → /api/command-router → 결과 카드
//   4. Top Action Agent: 자동 제안 1줄 슬라이드
//
// dashboard-canvas.js와 공존 — canvas.js가 먼저 로드되어 위젯·다크모드·⌘K 등 처리.

(function () {
  'use strict';

  // ─── 헬퍼 (canvas.js와 일부 중복 — 이 파일은 채팅 영역 한정) ───
  function $(sel, parent) { return (parent || document).querySelector(sel); }
  function $$(sel, parent) { return Array.from((parent || document).querySelectorAll(sel)); }
  function getToken() { return (localStorage.getItem('lumi_seller_jwt') || '').trim(); }
  function authHeaders() {
    const t = getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function timeAgoShort(iso) {
    if (!iso) return '';
    const ms = Date.now() - new Date(iso).getTime();
    const m = Math.round(ms / 60000);
    if (m < 1) return '방금';
    if (m < 60) return `${m}분`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}시간`;
    const d = Math.round(h / 24);
    return `${d}일`;
  }
  function flash(msg) {
    let el = $('#chatFlash');
    if (!el) {
      el = document.createElement('div');
      el.id = 'chatFlash';
      el.style.cssText =
        'position:fixed;bottom:180px;left:50%;transform:translateX(-50%);background:#18181b;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;z-index:300;box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:90vw;text-align:center;transition:opacity .3s';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(window.__chatFlashT);
    window.__chatFlashT = setTimeout(() => { el.style.opacity = '0'; }, 2400);
  }

  // ─── 사이드바 (히스토리 + 즐겨찾기) ───
  async function loadFavorites() {
    const wrap = $('#sidebarFavorites');
    if (!wrap) return;
    try {
      const r = await fetch('/api/command-favorites', { headers: authHeaders() });
      if (r.status === 401) {
        renderFavoritesDefault(wrap);
        return;
      }
      if (!r.ok) {
        renderFavoritesDefault(wrap);
        return;
      }
      const data = await r.json();
      renderFavorites(wrap, data.favorites || []);
    } catch (_) {
      renderFavoritesDefault(wrap);
    }
  }
  function renderFavoritesDefault(wrap) {
    const defaults = [
      { label: '오늘 뜨는 상품', command_text: '오늘 뜨는 상품 추천해 줘', icon: 'T' },
      { label: '쿠팡 가격 점검', command_text: '쿠팡 판매가가 비싼 상품 알려 줘', icon: 'P' },
      { label: '재고 부족', command_text: '재고 5개 이하 상품 보여 줘', icon: 'S' },
      { label: '이번 주 매출', command_text: '이번 주 매출 요약', icon: 'R' },
    ];
    renderFavorites(wrap, defaults);
  }
  function renderFavorites(wrap, favorites) {
    if (!favorites || favorites.length === 0) {
      wrap.innerHTML = '<div class="chat-sidebar__empty">즐겨찾기가 없어요</div>';
      return;
    }
    wrap.innerHTML = favorites.map((f) => `
      <button class="chat-sidebar__item" type="button" data-favorite-cmd="${escapeHtml(f.command_text)}">
        <span class="chat-sidebar__item-icon">${escapeHtml(f.icon || '·')}</span>
        <span class="chat-sidebar__item-body">
          <span class="chat-sidebar__item-text">${escapeHtml(f.label)}</span>
        </span>
      </button>
    `).join('');
    wrap.querySelectorAll('[data-favorite-cmd]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cmd = btn.dataset.favoriteCmd;
        if (cmd) submitCommand(cmd);
      });
    });
  }

  async function loadHistory() {
    const wrap = $('#sidebarHistory');
    if (!wrap) return;
    try {
      const r = await fetch('/api/command-history', { headers: authHeaders() });
      if (r.status === 401) {
        wrap.innerHTML = '<div class="chat-sidebar__empty">로그인 후 명령 기록이 여기에 쌓여요</div>';
        return;
      }
      if (!r.ok) {
        wrap.innerHTML = '<div class="chat-sidebar__empty">기록을 불러오지 못했어요</div>';
        return;
      }
      const data = await r.json();
      renderHistory(wrap, data.buckets || {});
    } catch (_) {
      wrap.innerHTML = '<div class="chat-sidebar__empty">아직 내역이 없어요</div>';
    }
  }
  function renderHistory(wrap, buckets) {
    const groups = [
      ['pinned', '핀'],
      ['today', '오늘'],
      ['yesterday', '어제'],
      ['last7', '7일 이내'],
      ['last30', '30일 이내'],
      ['older', '이전'],
    ];
    let html = '';
    let total = 0;
    for (const [key, label] of groups) {
      const list = buckets[key] || [];
      if (list.length === 0) continue;
      total += list.length;
      html += `<div class="chat-sidebar__group-label">${escapeHtml(label)}</div>`;
      for (const item of list) {
        const text = item.input || '명령';
        const time = timeAgoShort(item.created_at);
        const isPinned = !!item.is_pinned;
        html += `
          <div class="chat-sidebar__item" data-history-id="${escapeHtml(item.id)}" tabindex="0" role="button">
            <span class="chat-sidebar__item-icon">${escapeHtml(intentIcon(item.intent))}</span>
            <span class="chat-sidebar__item-body">
              <span class="chat-sidebar__item-text">${escapeHtml(text)}</span>
              <span class="chat-sidebar__item-time">${escapeHtml(time)} · ${escapeHtml(intentLabel(item.intent))}</span>
            </span>
            <button type="button" class="chat-sidebar__item-pin${isPinned ? ' chat-sidebar__item-pin--active' : ''}" data-pin-id="${escapeHtml(item.id)}" data-pinned="${isPinned ? '1' : '0'}" aria-label="핀">★</button>
          </div>
        `;
      }
    }
    if (total === 0) {
      wrap.innerHTML = '<div class="chat-sidebar__empty">아직 내역이 없어요. 명령창에 입력해 보세요</div>';
      return;
    }
    wrap.innerHTML = html;

    wrap.querySelectorAll('[data-history-id]').forEach((row) => {
      const id = row.dataset.historyId;
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-pin-id]')) return;
        replayHistory(id);
      });
      row.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); replayHistory(id); }
      });
    });
    wrap.querySelectorAll('[data-pin-id]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const id = btn.dataset.pinId;
        const wasPinned = btn.dataset.pinned === '1';
        try {
          const r = await fetch(`/api/command-history?id=${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ is_pinned: !wasPinned }),
          });
          if (r.ok) loadHistory();
        } catch (_) {}
      });
    });
  }
  function intentIcon(intent) {
    return ({
      shop: 'S', greeting: 'H', non_related: '?', abuse: '!',
      weather: 'W', currency: '₩', calendar: 'C', calc: '=',
    })[intent] || '·';
  }
  function intentLabel(intent) {
    return ({
      shop: '운영', greeting: '인사', non_related: '잡담', abuse: '차단',
      weather: '날씨', currency: '환율', calendar: '공휴일', calc: '계산',
    })[intent] || '명령';
  }

  async function replayHistory(id) {
    // 히스토리 재생: result_payload·summary 다시 카드로 표시
    try {
      const r = await fetch('/api/command-history', { headers: authHeaders() });
      if (!r.ok) return;
      const data = await r.json();
      const all = [
        ...(data.buckets?.pinned || []),
        ...(data.buckets?.today || []),
        ...(data.buckets?.yesterday || []),
        ...(data.buckets?.last7 || []),
        ...(data.buckets?.last30 || []),
        ...(data.buckets?.older || []),
      ];
      const item = all.find((x) => x.id === id);
      if (!item) return;
      showResultCard({
        input: item.input,
        intent: item.intent,
        ability_level: item.ability_level,
        cost_tier: item.cost_tier,
        summary: item.summary,
        payload: item.result_payload,
        cached: false,
        replay: true,
      });
    } catch (_) {}
  }

  // ─── 결과 카드 표시 ───
  function showLoadingCard(input) {
    showCanvasMode('result');
    const wrap = $('#canvasResult');
    if (!wrap) return;
    wrap.innerHTML = `
      <div class="result-card result-card--loading" id="loadingCard">
        루미가 "${escapeHtml(input)}" 처리 중이에요…
      </div>
    `;
  }

  function showResultCard(res) {
    showCanvasMode('result');
    const wrap = $('#canvasResult');
    if (!wrap) return;
    const intent = res.intent || 'shop';
    const intentClass = `result-card__intent--${intent}`;
    const abilityText = abilityLabel(res.ability_level);
    const cached = res.cached ? '<span class="result-card__cached">캐시 적중</span>' : '';
    const replay = res.replay ? '<span class="result-card__cached">기록 재생</span>' : '';

    let detailHtml = '';
    let nextHtml = '';

    const payload = res.payload || {};
    if (payload.kind === 'weather' && payload.detail) {
      const d = payload.detail;
      detailHtml = `<div class="result-card__detail">
        ${d.ok && typeof d.temp === 'number' ? `<strong>${d.temp}도</strong> · 체감 ${d.feels_like}도 · 습도 ${d.humidity}%` : escapeHtml(d.summary || '')}
      </div>`;
    } else if (payload.kind === 'currency' && payload.detail) {
      const d = payload.detail;
      if (d.ok) {
        detailHtml = `<div class="result-card__detail">
          ${escapeHtml(d.base)} → ${escapeHtml(d.target)} <strong>${Number(d.rate).toLocaleString('ko-KR')}원</strong>
          <br/>업데이트: ${escapeHtml(d.updated_at || '')}
        </div>`;
      }
    } else if (payload.kind === 'calendar' && payload.detail) {
      const d = payload.detail;
      const upcoming = d.upcoming || d.matched || [];
      if (upcoming.length > 0) {
        detailHtml = '<div class="result-card__detail">'
          + upcoming.map(h => `<div><strong>${escapeHtml(h.name)}</strong> · ${escapeHtml(h.date)} (D-${h.daysUntil})</div>`).join('')
          + '</div>';
      }
    } else if (payload.kind === 'calc' && payload.detail && payload.detail.result) {
      detailHtml = `<div class="result-card__detail">${escapeHtml(payload.detail.summary || '')}</div>`;
    } else if (payload.kind === 'shop_command') {
      if (Array.isArray(payload.next_steps) && payload.next_steps.length > 0) {
        nextHtml = `
          <div class="result-card__next">
            <p class="result-card__next-title">다음 액션</p>
            ${payload.next_steps.map(s => `<div class="result-card__next-item">${escapeHtml(s)}</div>`).join('')}
          </div>`;
      }
      if (payload.beta_note) {
        nextHtml += `<p class="result-card__beta-note">${escapeHtml(payload.beta_note)}</p>`;
      }
    } else if (payload.kind === 'invalid' || payload.blocked) {
      detailHtml = '';
    }

    wrap.innerHTML = `
      <article class="result-card">
        <div class="result-card__header">
          <span class="result-card__intent ${intentClass}">${escapeHtml(intentLabel(intent))}</span>
          <span class="result-card__ability">${escapeHtml(abilityText)}${cached}${replay}</span>
        </div>
        ${res.input ? `<p class="result-card__user-input">"${escapeHtml(res.input)}"</p>` : ''}
        <p class="result-card__summary">${escapeHtml(res.summary || '')}</p>
        ${detailHtml}
        ${nextHtml}
      </article>
    `;
    // 결과 위로 스크롤
    setTimeout(() => {
      const area = $('#canvasArea');
      if (area) area.scrollTo({ top: 0, behavior: 'smooth' });
    }, 50);
  }

  function abilityLabel(level) {
    return ({
      1: 'Lv.1 자동',
      2: 'Lv.2 제안',
      3: 'Lv.3 보조',
      4: 'Lv.4 사장님',
    })[level] || '';
  }

  function showCanvasMode(mode) {
    const greet = $('#canvasGreet');
    const def = $('#canvasDefault');
    const result = $('#canvasResult');
    if (!def || !result) return;
    if (mode === 'result') {
      if (greet) greet.hidden = true;
      def.hidden = true;
      result.hidden = false;
    } else {
      if (greet) greet.hidden = false;
      def.hidden = false;
      result.hidden = true;
      result.innerHTML = '';
    }
  }

  // ─── 정적 명령 라우팅 (fuzzy match) ───
  const STATIC_ROUTES = [
    { keywords: ['상품 등록', '상품등록', '물건 등록', '물건등록', '올리기', '물건올리기', '상품올리기', '등록'], href: '/register-product' },
    { keywords: ['주문', '주문 확인', '주문확인', '오늘 주문', '오늘주문'], href: '/orders' },
    { keywords: ['cs', '씨에스', '문의', '상담', '고객', '반품', '환불', '인박스', 'cs 인박스', 'cs인박스'], href: '/cs-inbox' },
    { keywords: ['마이그레이션', '옮기기', '데이터 가져오기', '데이터가져오기', '이전', '가져오기', '솔루션 이전'], href: '/migration-wizard' },
    { keywords: ['트렌드', '트렌드 분석', '키워드', '뜨는', '뜨는 상품'], href: '/trends' },
    { keywords: ['정산', '세무', '수익', '매출', '매출 확인'], href: '/dashboard.html#settlement' },
    { keywords: ['처리할 일', '처리할일', '할 일', '할일', '송장', '우선순위', '태스크', 'tasks'], href: '/tasks' },
    { keywords: ['설정', '계정', '마켓 설정', '마켓설정', '결제'], href: '/settings' },
  ];

  function staticRoute(text) {
    const q = text.toLowerCase().replace(/\s+/g, ' ').trim();
    for (const route of STATIC_ROUTES) {
      for (const kw of route.keywords) {
        if (q === kw || q.includes(kw) || kw.includes(q)) {
          return route.href;
        }
      }
    }
    return null;
  }

  // ─── 명령 전송 ───
  async function submitCommand(input) {
    const text = String(input || '').trim();
    if (!text) return;

    // 1순위: 정적 키워드 매칭 → 즉시 페이지 이동 (LLM 호출 X)
    const staticHref = staticRoute(text);
    if (staticHref) {
      window.location.href = staticHref;
      return;
    }

    const inputEl = $('#chatInput');
    if (inputEl) inputEl.value = '';
    autoResize(inputEl);
    syncSendBtn();

    const form = $('#chatForm');
    if (form) form.classList.add('is-loading');

    showLoadingCard(text);

    try {
      const r = await fetch('/api/command-router', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ input: text }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        showResultCard({
          input: text,
          intent: 'invalid',
          ability_level: 4,
          cost_tier: 0,
          summary: data.error || '명령을 처리하지 못했어요',
          payload: { kind: 'invalid' },
        });
      } else {
        showResultCard({
          input: text,
          intent: data.intent,
          ability_level: data.ability_level,
          cost_tier: data.cost_tier,
          summary: data.summary,
          payload: data.payload,
          cached: data.cached,
        });
        // 사이드바 새로고침 (히스토리 추가됨)
        if (data.history_id) loadHistory();
      }
    } catch (_) {
      showResultCard({
        input: text,
        intent: 'invalid',
        ability_level: 4,
        cost_tier: 0,
        summary: '네트워크 오류. 잠시 후 다시 시도해 주세요',
        payload: { kind: 'invalid' },
      });
    } finally {
      if (form) form.classList.remove('is-loading');
      if (inputEl) inputEl.focus();
    }
  }

  // ─── 입력창 핸들링 ───
  function autoResize(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }
  function syncSendBtn() {
    const btn = $('#chatSend');
    const inputEl = $('#chatInput');
    if (!btn || !inputEl) return;
    btn.disabled = inputEl.value.trim().length < 2;
  }

  function bindChatForm() {
    const form = $('#chatForm');
    const inputEl = $('#chatInput');
    if (!form || !inputEl) return;
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const v = inputEl.value.trim();
      if (v.length >= 2) submitCommand(v);
    });
    inputEl.addEventListener('input', () => {
      autoResize(inputEl);
      syncSendBtn();
    });
    inputEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        const v = inputEl.value.trim();
        if (v.length >= 2) submitCommand(v);
      }
    });
    // ⌘K 포커스
    document.addEventListener('keydown', (ev) => {
      const isMac = navigator.platform.toUpperCase().includes('MAC');
      const cmdKey = (isMac && ev.metaKey) || (!isMac && ev.ctrlKey);
      if (cmdKey && ev.key.toLowerCase() === 'k') {
        ev.preventDefault();
        inputEl.focus();
        // 모바일 사이드바 닫기
        closeMobileSidebar();
      }
    });
  }

  function bindSuggests() {
    $$('#chatSuggests [data-suggest]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cmd = btn.dataset.suggest;
        if (cmd) submitCommand(cmd);
      });
    });
  }

  function bindNewCommand() {
    const btn = $('#newCommandBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      showCanvasMode('default');
      const inputEl = $('#chatInput');
      if (inputEl) {
        inputEl.value = '';
        autoResize(inputEl);
        syncSendBtn();
        inputEl.focus();
      }
      closeMobileSidebar();
    });
  }

  // ─── Top Action Agent ───
  let _agentSuggestions = [];
  let _agentIdx = 0;

  function loadAgentSuggestions() {
    // mock 3개 + dismissed 필터 (canvas.js의 ACTION_AGENT_MOCKS와 호환되지 않게 별도)
    const all = [
      { id: 'price-diff', msg: '쿠팡 판매가가 네이버보다 ₩500 비쌉니다', cmd: '쿠팡 가격 점검' },
      { id: 'low-stock', msg: '재고 부족 상품 3개. 재발주 시점이에요', cmd: '재고 5개 이하 상품' },
      { id: 'trend-gap', msg: '뜨는 카테고리에 등록된 상품이 0개에요', cmd: '오늘 뜨는 상품 추천' },
    ];
    const dismissed = JSON.parse(localStorage.getItem('lumi_top_agent_dismissed') || '[]');
    _agentSuggestions = all.filter((a) => !dismissed.includes(a.id));
    _agentIdx = 0;
    renderAgent();
  }
  function renderAgent() {
    const stack = $('#topActionAgent');
    const msgEl = $('#topAgentMsg');
    if (!stack || !msgEl) return;
    if (_agentSuggestions.length === 0) {
      stack.hidden = true;
      return;
    }
    stack.hidden = false;
    const cur = _agentSuggestions[_agentIdx % _agentSuggestions.length];
    msgEl.textContent = cur.msg;
    msgEl.dataset.cmd = cur.cmd;
    msgEl.dataset.id = cur.id;
  }
  function bindAgent() {
    const yes = $('#topAgentYes');
    const no = $('#topAgentNo');
    if (yes) {
      yes.addEventListener('click', () => {
        const msgEl = $('#topAgentMsg');
        if (!msgEl) return;
        const cmd = msgEl.dataset.cmd;
        const id = msgEl.dataset.id;
        if (cmd) submitCommand(cmd);
        if (id) dismissAgent(id);
      });
    }
    if (no) {
      no.addEventListener('click', () => {
        const msgEl = $('#topAgentMsg');
        if (!msgEl) return;
        const id = msgEl.dataset.id;
        if (id) dismissAgent(id);
      });
    }
  }
  function dismissAgent(id) {
    const cur = JSON.parse(localStorage.getItem('lumi_top_agent_dismissed') || '[]');
    if (!cur.includes(id)) cur.push(id);
    localStorage.setItem('lumi_top_agent_dismissed', JSON.stringify(cur));
    _agentIdx = 0;
    loadAgentSuggestions();
  }

  // ─── 모바일 사이드바 ───
  function bindMobileSidebar() {
    const btn = $('#mobileMenuBtn');
    const sidebar = $('#chatSidebar');
    const backdrop = $('#chatSidebarBackdrop');
    if (!btn || !sidebar || !backdrop) return;
    btn.addEventListener('click', () => {
      sidebar.classList.add('is-open');
      backdrop.classList.add('is-open');
    });
    backdrop.addEventListener('click', closeMobileSidebar);
  }
  function closeMobileSidebar() {
    const sidebar = $('#chatSidebar');
    const backdrop = $('#chatSidebarBackdrop');
    if (sidebar) sidebar.classList.remove('is-open');
    if (backdrop) backdrop.classList.remove('is-open');
  }

  function bindMobileTheme() {
    const btn = $('#mobileThemeBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const cur = localStorage.getItem('lumi_dark_mode') === '1';
      localStorage.setItem('lumi_dark_mode', cur ? '0' : '1');
      // canvas.js의 applyTheme 트리거 (페이지 reload 없이)
      document.body.classList.toggle('dark-mode', !cur);
      btn.textContent = !cur ? '☀' : '☾';
      const fab = $('#themeFab');
      if (fab) fab.textContent = !cur ? '☀' : '☾';
    });
    // 초기 동기화
    btn.textContent = (localStorage.getItem('lumi_dark_mode') === '1') ? '☀' : '☾';
  }

  // ─── 첨부 ───
  function bindAttach() {
    const attach = $('#chatAttach');
    const file = $('#chatFile');
    if (!attach || !file) return;
    attach.addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      if (file.files && file.files.length > 0) {
        attach.classList.add('is-attached');
        flash('첨부 1개 — 정식 출시 시 사진 1장으로 멀티마켓 등록까지 자동');
        // 베타 단계: 첨부 표시만, 백엔드 호출 X
      } else {
        attach.classList.remove('is-attached');
      }
    });
  }

  // ─── 시작 ───
  document.addEventListener('DOMContentLoaded', () => {
    bindChatForm();
    bindSuggests();
    bindNewCommand();
    bindAgent();
    bindMobileSidebar();
    bindMobileTheme();
    bindAttach();
    syncSendBtn();
    loadFavorites();
    loadHistory();
    loadAgentSuggestions();

    // 30초마다 히스토리 새로고침 (사이드바 동기화)
    setInterval(loadHistory, 30000);
  });
})();
