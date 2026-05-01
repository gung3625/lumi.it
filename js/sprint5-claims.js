// Sprint 5 — claims.html (클레임 처리 분리: 취소 / 반품 / 교환 / 문의)
(function () {
  'use strict';

  // ── 상수 ─────────────────────────────────────────────────────────────
  const TABS = ['cancel', 'return', 'exchange', 'inquiry'];
  const TAB_LABELS = { cancel: '취소', return: '반품', exchange: '교환', inquiry: '문의' };
  const STATUS_LABELS = {
    pending: '대기',
    in_progress: '처리 중',
    approved: '승인',
    rejected: '거부',
    completed: '완료',
  };
  const STATUS_COLORS = {
    pending: '#b45309',       // 노랑
    in_progress: '#1d4ed8',   // 파랑
    approved: '#15803d',      // 초록
    rejected: '#b91c1c',      // 빨강
    completed: '#15803d',     // 초록
  };
  const MARKET_LABELS = { coupang: '쿠팡', naver: '네이버', toss: '토스' };

  // ── 상태 ─────────────────────────────────────────────────────────────
  let currentTab = 'cancel';
  let currentPage = 1;
  let allClaims = [];
  let counts = { cancel: 0, return: 0, exchange: 0, inquiry: 0 };
  let pendingCounts = { cancel: 0, return: 0, exchange: 0, inquiry: 0 };
  let activeSlideover = null; // 현재 열린 클레임 객체

  // ── 인증 ─────────────────────────────────────────────────────────────
  function getToken() { return localStorage.getItem('lumi_seller_token') || ''; }
  function authFetch(url, options) {
    return fetch(url, {
      ...options,
      headers: { ...(options?.headers || {}), 'Authorization': 'Bearer ' + getToken() },
    });
  }

  // ── 유틸 ─────────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function badge(status) {
    const label = STATUS_LABELS[status] || status;
    const color = STATUS_COLORS[status] || '#6b7280';
    return `<span class="claims-badge" style="background:${color}20;color:${color};border:1px solid ${color}40;">${escapeHtml(label)}</span>`;
  }

  // ── 탭 렌더 ──────────────────────────────────────────────────────────
  function renderTabs() {
    const container = document.getElementById('claimsTabs');
    if (!container) return;
    container.innerHTML = TABS.map((t) => {
      const n = pendingCounts[t] || 0;
      const active = t === currentTab ? ' claims-tab--active' : '';
      return `<button class="claims-tab${active}" data-tab="${t}" type="button">
        ${TAB_LABELS[t]}${n > 0 ? `<span class="claims-tab__badge">${n}</span>` : ''}
      </button>`;
    }).join('');

    container.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentTab = btn.dataset.tab;
        currentPage = 1;
        renderTabs();
        loadClaims();
      });
    });
  }

  // ── 카드 리스트 렌더 ─────────────────────────────────────────────────
  function renderCards(claims) {
    const root = document.getElementById('claimsList');
    if (!root) return;

    if (claims.length === 0) {
      root.innerHTML = `<div class="claims-empty"><p>처리할 클레임이 없어요.</p></div>`;
      return;
    }

    root.innerHTML = claims.map((c) => `
      <article class="claims-card" data-claim-id="${escapeHtml(c.id)}" tabindex="0" role="button" aria-label="${escapeHtml(TAB_LABELS[c.claim_type])} 클레임 상세 보기">
        <div class="claims-card__head">
          <span class="claims-card__market">${escapeHtml(MARKET_LABELS[c.market] || c.market)}</span>
          ${badge(c.status)}
        </div>
        <p class="claims-card__reason">${escapeHtml(c.reason || c.buyer_message || '사유 미입력')}</p>
        <div class="claims-card__meta">
          <span>클레임 ID: ${escapeHtml(c.market_claim_id)}</span>
          <span>${formatDate(c.created_at)}</span>
        </div>
      </article>
    `).join('');

    root.querySelectorAll('.claims-card').forEach((card) => {
      const openCard = () => {
        const claim = claims.find((c) => c.id === card.dataset.claimId);
        if (claim) openSlideover(claim);
      };
      card.addEventListener('click', openCard);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(); } });
    });
  }

  // ── API 호출 ─────────────────────────────────────────────────────────
  async function loadClaims() {
    const root = document.getElementById('claimsList');
    if (root) root.innerHTML = `<div class="claims-loading">불러오는 중…</div>`;

    try {
      const params = new URLSearchParams({ type: currentTab, page: currentPage, limit: 20 });
      const res = await authFetch(`/api/list-claims?${params}`);
      if (res.status === 401) { window.location.href = '/'; return; }
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '조회 실패');

      allClaims = data.claims || [];
      counts = data.counts || counts;
      pendingCounts = data.pendingCounts || pendingCounts;

      renderTabs();
      renderCards(allClaims);
      renderPagination(data.total, data.page, data.limit);
    } catch (e) {
      console.error('[claims] loadClaims error:', e.message);
      if (root) root.innerHTML = `<div class="claims-empty"><p>클레임을 불러오지 못했어요. 잠시 후 다시 시도해주세요.</p></div>`;
    }
  }

  // ── 페이지네이션 ─────────────────────────────────────────────────────
  function renderPagination(total, page, limit) {
    const container = document.getElementById('claimsPagination');
    if (!container) return;
    const totalPages = Math.ceil((total || 0) / (limit || 20));
    if (totalPages <= 1) { container.innerHTML = ''; return; }

    container.innerHTML = `
      <button class="claims-page-btn" ${page <= 1 ? 'disabled' : ''} data-dir="-1">← 이전</button>
      <span class="claims-page-info">${page} / ${totalPages}</span>
      <button class="claims-page-btn" ${page >= totalPages ? 'disabled' : ''} data-dir="1">다음 →</button>
    `;
    container.querySelectorAll('[data-dir]').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentPage += parseInt(btn.dataset.dir, 10);
        loadClaims();
      });
    });
  }

  // ── 슬라이드오버 ─────────────────────────────────────────────────────
  function openSlideover(claim) {
    activeSlideover = claim;
    const panel = document.getElementById('claimsSlideover');
    const overlay = document.getElementById('claimsOverlay');
    if (!panel) return;

    document.getElementById('slideoverTitle').textContent =
      `${TAB_LABELS[claim.claim_type]} 클레임 — ${MARKET_LABELS[claim.market] || claim.market}`;

    const body = document.getElementById('slideoverBody');
    body.innerHTML = `
      <dl class="claims-dl">
        <dt>클레임 ID</dt><dd>${escapeHtml(claim.market_claim_id)}</dd>
        <dt>상태</dt><dd>${badge(claim.status)}</dd>
        <dt>접수일</dt><dd>${formatDate(claim.created_at)}</dd>
        ${claim.reason ? `<dt>사유</dt><dd>${escapeHtml(claim.reason)}</dd>` : ''}
        ${claim.buyer_message ? `<dt>구매자 메시지</dt><dd>${escapeHtml(claim.buyer_message)}</dd>` : ''}
        ${claim.refund_amount != null ? `<dt>환불 금액</dt><dd>${Number(claim.refund_amount).toLocaleString()}원</dd>` : ''}
        ${claim.return_tracking_number ? `<dt>반품 송장</dt><dd>${escapeHtml(claim.return_tracking_number)}</dd>` : ''}
        ${claim.exchange_tracking_number ? `<dt>교환 새 송장</dt><dd>${escapeHtml(claim.exchange_tracking_number)}</dd>` : ''}
        ${claim.seller_response ? `<dt>처리 메모</dt><dd>${escapeHtml(claim.seller_response)}</dd>` : ''}
        ${claim.resolved_at ? `<dt>처리 완료일</dt><dd>${formatDate(claim.resolved_at)}</dd>` : ''}
      </dl>
      ${renderActionArea(claim)}
    `;

    // 액션 버튼 이벤트 바인딩
    bindActionButtons(body, claim);

    panel.classList.add('claims-slideover--open');
    if (overlay) overlay.classList.add('claims-overlay--visible');
    panel.focus();
  }

  function closeSlideover() {
    const panel = document.getElementById('claimsSlideover');
    const overlay = document.getElementById('claimsOverlay');
    if (panel) panel.classList.remove('claims-slideover--open');
    if (overlay) overlay.classList.remove('claims-overlay--visible');
    activeSlideover = null;
  }

  function renderActionArea(claim) {
    if (['completed', 'rejected'].includes(claim.status)) {
      return `<p class="claims-action-done">이미 처리된 클레임이에요.</p>`;
    }

    if (claim.claim_type === 'cancel') {
      return `
        <div class="claims-actions">
          <textarea class="claims-reason-input" placeholder="거부 사유 (선택)" id="actionReason" rows="2"></textarea>
          <div class="claims-action-btns">
            <button class="btn btn--primary" data-action="approve">승인</button>
            <button class="btn btn--ghost" data-action="reject">거부</button>
          </div>
        </div>`;
    }

    if (claim.claim_type === 'return') {
      const showRefund = claim.status === 'in_progress';
      return `
        <div class="claims-actions">
          ${showRefund ? `<input class="claims-input" type="number" id="refundAmount" placeholder="환불 금액 (원)" value="${claim.refund_amount || ''}" />` : ''}
          <input class="claims-input" type="text" id="returnTracking" placeholder="반품 송장번호 (선택)" value="${escapeHtml(claim.return_tracking_number || '')}" />
          <div class="claims-action-btns">
            ${!showRefund ? `<button class="btn btn--secondary" data-action="received">수령 확인</button>` : ''}
            ${showRefund ? `<button class="btn btn--primary" data-action="refund">환불 처리</button>` : ''}
            <button class="btn btn--ghost" data-action="reject">거부</button>
          </div>
        </div>`;
    }

    if (claim.claim_type === 'exchange') {
      const showReship = claim.status === 'in_progress';
      return `
        <div class="claims-actions">
          <input class="claims-input" type="text" id="exchangeTracking" placeholder="교환 새 송장번호" value="${escapeHtml(claim.exchange_tracking_number || '')}" />
          <div class="claims-action-btns">
            ${!showReship ? `<button class="btn btn--secondary" data-action="received">수령 확인</button>` : ''}
            <button class="btn btn--primary" data-action="reship">재배송 송장 입력</button>
            ${showReship ? `<button class="btn btn--secondary" data-action="complete">교환 완료</button>` : ''}
            <button class="btn btn--ghost" data-action="reject">거부</button>
          </div>
        </div>`;
    }

    if (claim.claim_type === 'inquiry') {
      return `
        <div class="claims-actions">
          <textarea class="claims-reason-input" placeholder="답변 내용을 입력해주세요" id="inquiryReply" rows="4"></textarea>
          <div class="claims-action-btns">
            <button class="btn btn--primary" data-action="reply">답변 전송</button>
          </div>
        </div>`;
    }

    return '';
  }

  function bindActionButtons(body, claim) {
    body.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => handleAction(claim, btn.dataset.action));
    });
  }

  async function handleAction(claim, action) {
    const btnEls = document.querySelectorAll('#slideoverBody [data-action]');
    btnEls.forEach((b) => { b.disabled = true; });

    const reasonEl = document.getElementById('actionReason');
    const refundEl = document.getElementById('refundAmount');
    const returnTrackingEl = document.getElementById('returnTracking');
    const exchangeTrackingEl = document.getElementById('exchangeTracking');
    const inquiryReplyEl = document.getElementById('inquiryReply');

    try {
      let endpoint, bodyPayload;

      if (claim.claim_type === 'cancel') {
        endpoint = '/api/process-cancel-claim';
        bodyPayload = {
          claim_id: claim.id,
          action,
          reason: reasonEl?.value.trim() || undefined,
        };
      } else if (claim.claim_type === 'return') {
        endpoint = '/api/process-return-claim';
        const refundAmt = refundEl ? parseFloat(refundEl.value) : undefined;
        bodyPayload = {
          claim_id: claim.id,
          action,
          refund_amount: !isNaN(refundAmt) ? refundAmt : undefined,
          tracking_number: returnTrackingEl?.value.trim() || undefined,
        };
      } else if (claim.claim_type === 'exchange') {
        endpoint = '/api/process-exchange-claim';
        bodyPayload = {
          claim_id: claim.id,
          action,
          exchange_tracking: exchangeTrackingEl?.value.trim() || undefined,
        };
        if (action === 'reship' && !bodyPayload.exchange_tracking) {
          showToast('재배송 시 송장번호를 입력해주세요.', 'error');
          btnEls.forEach((b) => { b.disabled = false; });
          return;
        }
      } else if (claim.claim_type === 'inquiry') {
        // 문의 답변은 cs-send-reply API 사용 (cs-inbox 동일 흐름)
        const replyText = inquiryReplyEl?.value.trim();
        if (!replyText) {
          showToast('답변 내용을 입력해주세요.', 'error');
          btnEls.forEach((b) => { b.disabled = false; });
          return;
        }
        const res = await authFetch('/api/cs-send-reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thread_id: claim.market_claim_id, reply: replyText }),
        });
        const data = await res.json();
        if (data.success) {
          showToast('답변이 전송됐어요.');
          closeSlideover();
          loadClaims();
        } else {
          showToast(data.error || '답변 전송에 실패했어요.', 'error');
          btnEls.forEach((b) => { b.disabled = false; });
        }
        return;
      }

      const res = await authFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload),
      });
      const data = await res.json();

      if (data.success) {
        showToast('처리가 완료됐어요.');
        closeSlideover();
        loadClaims();
      } else {
        showToast(data.error || '처리에 실패했어요.', 'error');
        btnEls.forEach((b) => { b.disabled = false; });
      }
    } catch (e) {
      console.error('[claims] handleAction error:', e.message);
      showToast('서버 오류가 발생했어요.', 'error');
      btnEls.forEach((b) => { b.disabled = false; });
    }
  }

  // ── 토스트 ────────────────────────────────────────────────────────────
  function showToast(msg, type = 'success') {
    let toast = document.getElementById('claimsToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'claimsToast';
      toast.className = 'claims-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.className = `claims-toast claims-toast--${type} claims-toast--show`;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.classList.remove('claims-toast--show'); }, 3000);
  }

  // ── 다크모드 ──────────────────────────────────────────────────────────
  function applyDarkMode() {
    const saved = localStorage.getItem('lumi_dark_mode');
    const isDark = saved === '1';
    document.body.classList.toggle('dark-mode', isDark);
  }

  function setupDarkModeToggle() {
    const btn = document.getElementById('darkModeToggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const isDark = document.body.classList.toggle('dark-mode');
      localStorage.setItem('lumi_dark_mode', isDark ? '1' : '0');
    });
  }

  // ── 초기화 ────────────────────────────────────────────────────────────
  function init() {
    applyDarkMode();

    // 인증 가드
    if (!getToken()) {
      window.location.href = '/?redirect=' + encodeURIComponent('/claims.html');
      return;
    }

    setupDarkModeToggle();

    // 탭 초기 렌더
    renderTabs();

    // 슬라이드오버 닫기
    const closeBtn = document.getElementById('slideoverClose');
    if (closeBtn) closeBtn.addEventListener('click', closeSlideover);
    const overlay = document.getElementById('claimsOverlay');
    if (overlay) overlay.addEventListener('click', closeSlideover);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSlideover(); });

    // URL hash → 탭 초기값
    const hash = location.hash.replace('#', '');
    if (TABS.includes(hash)) currentTab = hash;

    // 데이터 로드
    loadClaims();

    // URL 탭 변경 반영
    window.addEventListener('hashchange', () => {
      const h = location.hash.replace('#', '');
      if (TABS.includes(h) && h !== currentTab) {
        currentTab = h;
        currentPage = 1;
        renderTabs();
        loadClaims();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
