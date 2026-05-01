// sprint5-failures.js — 실패 통합 추적 클라이언트
// failure-log.html 전용

(function () {
  'use strict';

  const SUPABASE_URL = window.SUPABASE_URL || 'https://kfacacxqshpnipngdsuk.supabase.co';

  function getToken() {
    return (localStorage.getItem('lumi_seller_jwt') || '').trim();
  }

  function authHeaders() {
    const t = getToken();
    return t ? { 'Authorization': `Bearer ${t}` } : {};
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const ms = Date.now() - new Date(iso).getTime();
    const m = Math.round(ms / 60000);
    if (m < 1) return '방금';
    if (m < 60) return `${m}분 전`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}시간 전`;
    const d = Math.round(h / 24);
    if (d < 7) return `${d}일 전`;
    return new Date(iso).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
  }

  // 카테고리 표시 텍스트
  const CATEGORY_LABEL = {
    product_register: '상품 등록',
    product_update: '상품 수정',
    order_collect: '주문 수집',
    tracking_send: '송장 송신',
    claim_process: '클레임',
    mapping: '매핑',
  };

  // 마켓 배지 색상
  const MARKET_COLOR = {
    coupang: '#e8003d',
    naver: '#03c75a',
    toss: '#0064ff',
  };

  // ─── 상태 ───
  let state = {
    activeCategory: 'all',   // 'all' | 카테고리키
    failures: [],
    counts: { total: 0, product_register: 0, product_update: 0, order_collect: 0, tracking_send: 0, claim_process: 0, mapping: 0 },
    loading: false,
    rawModal: null,   // 현재 열린 원본 보기 failure_id
  };

  // ─── DOM refs ───
  const listEl = document.getElementById('failureList');
  const emptyEl = document.getElementById('emptyState');
  const loadingEl = document.getElementById('loadingState');
  const tabsEl = document.getElementById('failureTabs');
  const rawModalEl = document.getElementById('rawModal');
  const rawContentEl = document.getElementById('rawContent');
  const rawCloseEl = document.getElementById('rawModalClose');
  const todayCountEl = document.getElementById('statToday');
  const weekCountEl = document.getElementById('statWeek');

  // ─── 탭 업데이트 ───
  function updateTabs() {
    if (!tabsEl) return;
    tabsEl.querySelectorAll('[data-cat]').forEach((btn) => {
      const cat = btn.dataset.cat;
      const count = cat === 'all' ? state.counts.total : (state.counts[cat] || 0);
      const badge = btn.querySelector('.tab-badge');
      if (badge) badge.textContent = count > 0 ? count : '';
      btn.classList.toggle('tab--active', cat === state.activeCategory);
    });
  }

  // ─── 마켓 배지 HTML ───
  function marketBadge(market) {
    if (!market) return '';
    const color = MARKET_COLOR[market] || '#86868b';
    return `<span class="failure-card__market" style="background:${color};">${escapeHtml(market)}</span>`;
  }

  // ─── 카드 렌더 ───
  function renderCard(f) {
    const catLabel = CATEGORY_LABEL[f.category] || f.category;
    const retryBadge = f.retry_count > 0
      ? `<span class="failure-card__retry-count">재시도 ${f.retry_count}회</span>`
      : '';
    return `
      <article class="failure-card" data-id="${escapeHtml(f.id)}">
        <div class="failure-card__head">
          ${marketBadge(f.market)}
          <span class="failure-card__cat">${escapeHtml(catLabel)}</span>
          ${retryBadge}
          <span class="failure-card__time">${timeAgo(f.created_at)}</span>
        </div>
        <p class="failure-card__summary">${escapeHtml(f.target_summary || f.target_id || '(대상 없음)')}</p>
        ${f.error_message ? `<p class="failure-card__error">${escapeHtml(f.error_message)}</p>` : ''}
        ${f.error_code ? `<span class="failure-card__code">코드: ${escapeHtml(f.error_code)}</span>` : ''}
        <div class="failure-card__actions">
          <button class="btn btn--primary btn--sm" type="button" data-action="retry" data-id="${escapeHtml(f.id)}">재시도</button>
          <button class="btn btn--ghost btn--sm" type="button" data-action="resolve" data-id="${escapeHtml(f.id)}">무시</button>
          ${f.raw_response ? `<button class="btn btn--ghost btn--sm" type="button" data-action="raw" data-id="${escapeHtml(f.id)}" data-raw='${escapeHtml(JSON.stringify(f.raw_response))}'>원본 보기</button>` : ''}
        </div>
      </article>`;
  }

  // ─── 리스트 렌더 ───
  function renderList() {
    if (!listEl) return;
    if (state.loading) {
      if (loadingEl) loadingEl.hidden = false;
      if (emptyEl) emptyEl.hidden = true;
      listEl.innerHTML = '';
      return;
    }
    if (loadingEl) loadingEl.hidden = true;

    const items = state.activeCategory === 'all'
      ? state.failures
      : state.failures.filter((f) => f.category === state.activeCategory);

    if (items.length === 0) {
      if (emptyEl) emptyEl.hidden = false;
      listEl.innerHTML = '';
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    listEl.innerHTML = items.map(renderCard).join('');
  }

  // ─── API: 목록 조회 ───
  async function fetchFailures() {
    state.loading = true;
    renderList();

    try {
      const res = await fetch('/api/list-failures?resolved=false&limit=100', {
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.failures = data.failures || [];
      state.counts = data.counts || state.counts;
    } catch (err) {
      console.error('[sprint5-failures] fetchFailures:', err);
      state.failures = [];
    }

    state.loading = false;
    renderList();
    updateTabs();
    renderStats();
  }

  // ─── 통계 렌더 (오늘/이번주) ───
  function renderStats() {
    const now = Date.now();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(now - 7 * 86400000);

    let today = 0, week = 0;
    for (const f of state.failures) {
      const t = new Date(f.created_at).getTime();
      if (t >= todayStart.getTime()) today++;
      if (t >= weekStart.getTime()) week++;
    }
    if (todayCountEl) todayCountEl.textContent = today;
    if (weekCountEl) weekCountEl.textContent = week;
  }

  // ─── API: 재시도 / 해결 ───
  async function postAction(failureId, action) {
    const btn = listEl ? listEl.querySelector(`[data-action="${action}"][data-id="${failureId}"]`) : null;
    if (btn) { btn.disabled = true; btn.textContent = action === 'retry' ? '처리 중…' : '처리 중…'; }

    try {
      const res = await fetch('/api/retry-failure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ failure_id: failureId, action }),
      });
      const data = await res.json();
      if (data.success) {
        // 목록에서 제거
        state.failures = state.failures.filter((f) => f.id !== failureId);
        if (state.counts.total > 0) state.counts.total--;
        const f = state.failures.find((x) => x.id === failureId);
        if (f && state.counts[f.category] > 0) state.counts[f.category]--;
        renderList();
        updateTabs();
        renderStats();
        showToast(data.message || '완료되었어요.', 'success');
      } else {
        showToast(data.error || '처리에 실패했어요.', 'error');
        if (btn) { btn.disabled = false; btn.textContent = action === 'retry' ? '재시도' : '무시'; }
        // 재시도 실패 시 목록 새로고침 (retry_count 반영)
        if (action === 'retry') fetchFailures();
      }
    } catch (err) {
      showToast('네트워크 오류가 발생했어요.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = action === 'retry' ? '재시도' : '무시'; }
    }
  }

  // ─── 토스트 ───
  function showToast(msg, type) {
    let toast = document.getElementById('lumiToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'lumiToast';
      toast.className = 'lumi-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.className = `lumi-toast lumi-toast--${type} lumi-toast--show`;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('lumi-toast--show'), 2800);
  }

  // ─── 원본 보기 모달 ───
  function openRawModal(rawJson) {
    if (!rawModalEl || !rawContentEl) return;
    try {
      rawContentEl.textContent = JSON.stringify(JSON.parse(rawJson), null, 2);
    } catch (_) {
      rawContentEl.textContent = rawJson;
    }
    rawModalEl.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeRawModal() {
    if (!rawModalEl) return;
    rawModalEl.hidden = true;
    document.body.style.overflow = '';
  }

  // ─── 이벤트: 탭 클릭 ───
  if (tabsEl) {
    tabsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cat]');
      if (!btn) return;
      state.activeCategory = btn.dataset.cat;
      updateTabs();
      renderList();
    });
  }

  // ─── 이벤트: 카드 액션 위임 ───
  if (listEl) {
    listEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const { action, id: fId, raw } = btn.dataset;

      if (action === 'retry') postAction(fId, 'retry');
      else if (action === 'resolve') postAction(fId, 'resolve');
      else if (action === 'raw') openRawModal(raw || '{}');
    });
  }

  // ─── 이벤트: 모달 닫기 ───
  if (rawCloseEl) rawCloseEl.addEventListener('click', closeRawModal);
  if (rawModalEl) {
    rawModalEl.addEventListener('click', (e) => {
      if (e.target === rawModalEl) closeRawModal();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && rawModalEl && !rawModalEl.hidden) closeRawModal();
  });

  // ─── 새로고침 버튼 ───
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', fetchFailures);
  }

  // ─── 초기 로드 ───
  fetchFailures();
})();
