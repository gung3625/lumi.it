// Sprint 3 — orders.html (모바일 카드 + PC 테이블)
(function () {
  'use strict';

  let currentFilter = 'all';
  let allOrders = [];
  let couriers = [];
  let selectedOrderId = null;

  function getToken() { return localStorage.getItem('lumi_seller_token') || ''; }
  function authFetch(url, options) {
    return fetch(url, { ...options, headers: { ...(options?.headers || {}), Authorization: 'Bearer ' + getToken() } });
  }
  function bind(name, value) {
    document.querySelectorAll(`[data-bind="${name}"]`).forEach((el) => { el.textContent = value; });
  }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }
  function statusLabel(s) {
    return { paid: '송장 대기', shipping: '배송 중', delivered: '완료', returned: '반품', exchanged: '교환', cancelled: '취소', received: '접수' }[s] || s;
  }
  function marketLabel(m) {
    return { coupang: '쿠팡', naver: '네이버', toss: '토스' }[m] || m;
  }

  function renderMobile(orders) {
    const root = document.getElementById('ordersMobile');
    if (orders.length === 0) {
      root.innerHTML = `<div class="empty-state"><p>이 필터에 해당하는 주문이 없어요.</p></div>`;
      return;
    }
    root.innerHTML = orders.map((o) => `
      <article class="order-card" data-order-id="${escapeHtml(o.id)}">
        <div class="order-card__head">
          <div>
            <span class="order-card__market" data-market="${escapeHtml(o.market)}">${marketLabel(o.market)}</span>
          </div>
          <span class="order-card__status" data-status="${escapeHtml(o.status)}">${statusLabel(o.status)}</span>
        </div>
        <h3 class="order-card__title">${escapeHtml(o.product_title || '-')}</h3>
        <p class="order-card__meta">${escapeHtml(o.option_text || '-')} · ${o.quantity}개</p>
        <p class="order-card__price">${(o.total_price || 0).toLocaleString()}원</p>
        <p class="order-card__buyer">${escapeHtml(o.buyer_name_masked || '')} · ${escapeHtml(o.buyer_phone_masked || '')} · ${escapeHtml(o.buyer_address_masked || '')}</p>
        <div class="order-card__actions">
          ${o.status === 'paid' && !o.tracking_number
            ? `<button class="btn btn--primary btn--sm" data-action="tracking" data-order-id="${escapeHtml(o.id)}">송장 입력</button>`
            : ''}
          ${o.status === 'returned' && !o.stock_restored
            ? `<button class="btn btn--primary btn--sm" data-action="return" data-order-id="${escapeHtml(o.id)}">반품 처리</button>`
            : ''}
          ${o.status === 'shipping' || o.status === 'delivered'
            ? `<button class="btn btn--ghost btn--sm" data-action="track-view" data-order-id="${escapeHtml(o.id)}">추적 보기</button>`
            : ''}
          <a class="btn btn--ghost btn--sm" href="/order-detail?id=${encodeURIComponent(o.id)}">상세</a>
        </div>
      </article>
    `).join('');

    root.querySelectorAll('[data-action="tracking"]').forEach((btn) => {
      btn.addEventListener('click', () => openTrackingSheet(btn.dataset.orderId));
    });
    root.querySelectorAll('[data-action="return"]').forEach((btn) => {
      btn.addEventListener('click', () => processReturn(btn.dataset.orderId));
    });
  }

  function renderDesktop(orders) {
    const tbody = document.getElementById('ordersTableBody');
    if (orders.length === 0) {
      tbody.innerHTML = `<tr><td colspan="11" class="loading">주문이 없어요.</td></tr>`;
      return;
    }
    tbody.innerHTML = orders.map((o) => `
      <tr data-order-id="${escapeHtml(o.id)}">
        <td><input type="checkbox" class="order-checkbox" data-order-id="${escapeHtml(o.id)}" data-status="${o.status}" /></td>
        <td>${marketLabel(o.market)}</td>
        <td>${escapeHtml(o.market_order_id || '')}</td>
        <td>${escapeHtml(o.product_title || '')}</td>
        <td>${escapeHtml(o.option_text || '')}</td>
        <td>${o.quantity}</td>
        <td>${(o.total_price || 0).toLocaleString()}원</td>
        <td><span class="order-card__status" data-status="${o.status}">${statusLabel(o.status)}</span></td>
        <td>${escapeHtml(o.tracking_number || '-')}</td>
        <td>${escapeHtml(o.buyer_name_masked || '')}</td>
        <td>
          ${o.status === 'paid' && !o.tracking_number
            ? `<button class="btn btn--primary btn--sm" data-action="tracking" data-order-id="${escapeHtml(o.id)}">송장</button>`
            : `<a class="btn btn--ghost btn--sm" href="/order-detail?id=${encodeURIComponent(o.id)}">상세</a>`}
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('[data-action="tracking"]').forEach((btn) => {
      btn.addEventListener('click', () => openTrackingSheet(btn.dataset.orderId));
    });

    bindCheckboxes();
  }

  function bindCheckboxes() {
    const checks = document.querySelectorAll('.order-checkbox');
    const bar = document.getElementById('batchBar');
    checks.forEach((c) => c.addEventListener('change', () => updateBatchBar()));
    document.getElementById('selectAllOrders').addEventListener('change', (e) => {
      checks.forEach((c) => { c.checked = e.target.checked; });
      updateBatchBar();
    });
  }

  function updateBatchBar() {
    const checked = Array.from(document.querySelectorAll('.order-checkbox:checked'));
    bind('selected_count', `${checked.length}개 선택됨`);
    document.getElementById('batchTrackBtn').disabled = checked.length === 0 || checked.some((c) => c.dataset.status !== 'paid');
    document.getElementById('batchReturnBtn').disabled = checked.length === 0 || checked.some((c) => c.dataset.status !== 'returned');
  }

  async function loadCouriers() {
    try {
      const res = await fetch('/api/list-couriers');
      const data = await res.json();
      couriers = data.couriers || [];
      const sel = document.getElementById('courierSelect');
      sel.innerHTML = '<option value="">선택해주세요</option>' + couriers.map((c) => `<option value="${c.code}">${c.display_name}</option>`).join('');
    } catch { /* */ }
  }

  function openTrackingSheet(orderId) {
    selectedOrderId = orderId;
    const order = allOrders.find((o) => o.id === orderId);
    bind('tracking_target', order ? `${marketLabel(order.market)} · ${order.product_title}` : '선택한 주문');
    document.getElementById('trackingNumberInput').value = '';
    document.getElementById('courierSelect').value = '';
    document.getElementById('trackingSheet').hidden = false;
  }

  function closeTrackingSheet() {
    document.getElementById('trackingSheet').hidden = true;
    selectedOrderId = null;
  }

  /**
   * 송장 전송 결과 토스트 (success/warn/error)
   * success=초록, warn=노랑, error=빨강
   */
  function showTrackingToast(type, message) {
    const colors = { success: '#2e7d32', warn: '#e65100', error: '#c62828' };
    const existing = document.getElementById('trackingToast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.id = 'trackingToast';
    el.textContent = message;
    Object.assign(el.style, {
      position: 'fixed', bottom: '80px', left: '50%', transform: 'translateX(-50%)',
      background: colors[type] || colors.error, color: '#fff',
      padding: '12px 20px', borderRadius: '8px', fontSize: '14px',
      maxWidth: '90vw', textAlign: 'center', zIndex: '9999',
      boxShadow: '0 4px 12px rgba(0,0,0,.3)',
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), type === 'warn' ? 6000 : 3000);
  }

  async function submitTracking() {
    const courier = document.getElementById('courierSelect').value;
    const number = document.getElementById('trackingNumberInput').value.trim();
    if (!courier) { alert('택배사를 선택해주세요.'); return; }
    if (!number) { alert('송장번호를 입력해주세요.'); return; }
    try {
      const res = await authFetch('/api/submit-tracking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: selectedOrderId, courier_code: courier, tracking_number: number }),
      });
      const data = await res.json();
      const results = data.results || [];
      const failed = results.filter((r) => !r.success);
      const succeeded = results.filter((r) => r.success);
      if (failed.length === 0) {
        // 전체 성공
        showTrackingToast('success', '송장을 보냈어요!');
        closeTrackingSheet();
        load();
      } else if (succeeded.length === 0) {
        // 전체 실패
        const r = failed[0];
        const msg = r?.error?.title ? `${r.error.title}\n${r.error.action}` : (r?.error || '송장 전송에 실패했어요.');
        showTrackingToast('error', msg);
      } else {
        // 일부 실패
        const detail = failed.map((r) => r.error?.title || r.error || '알 수 없는 오류').join(', ');
        showTrackingToast('warn', `${results.length}건 중 ${failed.length}건 실패: ${detail}`);
        closeTrackingSheet();
        load();
      }
    } catch {
      alert('네트워크 오류예요. 잠시 후 다시 시도해주세요.');
    }
  }

  async function processReturn(orderId) {
    if (!confirm('반품 처리하면 재고를 자동 가산해요. 계속할까요?')) return;
    try {
      const res = await authFetch('/api/process-return', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: orderId }),
      });
      const data = await res.json();
      if (data.success) {
        alert('반품을 처리했어요. 재고가 갱신됐어요.');
        load();
      } else {
        alert(data.error || '반품 처리에 실패했어요.');
      }
    } catch {
      alert('네트워크 오류예요.');
    }
  }

  async function load() {
    const root = document.getElementById('ordersMobile');
    root.innerHTML = `<div class="empty-state"><div class="empty-state__spinner"></div><p>주문을 가져오는 중…</p></div>`;
    try {
      const res = await authFetch(`/api/orders?filter=${encodeURIComponent(currentFilter)}&limit=50`);
      if (res.status === 401) {
        location.href = '/signup'; return;
      }
      const data = await res.json();
      allOrders = data.orders || [];
      bind('orders_summary', `${currentFilter === 'all' ? '전체' : ''} ${data.total || 0}건`);
      renderMobile(allOrders);
      renderDesktop(allOrders);
    } catch {
      root.innerHTML = `<div class="empty-state"><p>주문을 불러오지 못했어요.</p></div>`;
    }
  }

  function setupChips() {
    const params = new URLSearchParams(location.search);
    if (params.get('filter')) {
      currentFilter = params.get('filter');
      document.querySelectorAll('.chip').forEach((c) => {
        c.classList.toggle('chip--active', c.dataset.filter === currentFilter);
      });
    }
    document.querySelectorAll('.chip').forEach((c) => {
      c.addEventListener('click', () => {
        document.querySelectorAll('.chip').forEach((x) => x.classList.remove('chip--active'));
        c.classList.add('chip--active');
        currentFilter = c.dataset.filter;
        load();
      });
    });
  }

  function setupSheet() {
    const sheet = document.getElementById('trackingSheet');
    sheet.querySelectorAll('[data-sheet-close]').forEach((el) => el.addEventListener('click', closeTrackingSheet));
    document.getElementById('submitTrackingBtn').addEventListener('click', submitTracking);
  }

  function setupBatchActions() {
    document.getElementById('batchTrackBtn').addEventListener('click', () => {
      alert('PC 일괄 입력 화면은 다음 단계에서 열려요. 모바일에서는 카드별로 1탭씩 입력해주세요.');
    });
    document.getElementById('batchReturnBtn').addEventListener('click', async () => {
      const ids = Array.from(document.querySelectorAll('.order-checkbox:checked')).map((c) => c.dataset.orderId);
      if (ids.length === 0) return;
      if (!confirm(`${ids.length}개 반품을 일괄 처리할까요?`)) return;
      const items = ids.map((id) => ({ order_id: id }));
      try {
        const res = await authFetch('/api/process-return', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        });
        const data = await res.json();
        alert(`${(data.results || []).filter((r) => r.success).length}건 처리 완료`);
        load();
      } catch { alert('네트워크 오류'); }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    setupChips();
    setupSheet();
    setupBatchActions();
    loadCouriers();
    load();
  });
})();
