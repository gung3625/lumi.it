// Sprint 3 — order-detail.html
(function () {
  'use strict';

  function getToken() { return localStorage.getItem('lumi_seller_token') || ''; }
  function authFetch(url, options) {
    return fetch(url, { ...options, headers: { ...(options?.headers || {}), Authorization: 'Bearer ' + getToken() } });
  }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }
  function marketLabel(m) { return { coupang: '쿠팡', naver: '네이버', toss: '토스' }[m] || m; }
  function statusLabel(s) {
    return { paid: '송장 대기', shipping: '배송 중', delivered: '완료', returned: '반품', exchanged: '교환', cancelled: '취소' }[s] || s;
  }

  async function load() {
    const orderId = new URLSearchParams(location.search).get('id');
    if (!orderId) {
      document.getElementById('orderSummary').innerHTML = '<p>주문 ID가 없어요.</p>';
      return;
    }
    try {
      const res = await authFetch('/api/orders?id=' + encodeURIComponent(orderId));
      if (res.status === 401) { location.href = '/signup'; return; }
      const data = await res.json();
      if (!data.success) {
        document.getElementById('orderSummary').innerHTML = `<p>${escapeHtml(data.error || '주문을 찾을 수 없어요.')}</p>`;
        return;
      }
      renderOrder(data.order);
      renderTracking(data.tracking_events || []);
      bindActions(data.order);
    } catch {
      document.getElementById('orderSummary').innerHTML = '<p>네트워크 오류예요.</p>';
    }
  }

  function renderOrder(o) {
    document.getElementById('orderSummary').innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <span class="order-card__market" data-market="${escapeHtml(o.market)}">${marketLabel(o.market)}</span>
        <span class="order-card__status" data-status="${escapeHtml(o.status)}">${statusLabel(o.status)}</span>
      </div>
      <h2 style="margin:0 0 8px;font-size:18px">${escapeHtml(o.product_title || '-')}</h2>
      <p class="muted" style="margin:0 0 4px">${escapeHtml(o.option_text || '')} · ${o.quantity}개</p>
      <p style="font-size:18px;font-weight:700;margin:0 0 12px">${(o.total_price || 0).toLocaleString()}원</p>
      <div style="font-size:13px;color:#555;line-height:1.7">
        <div>구매자: ${escapeHtml(o.buyer_name_masked || '-')}</div>
        <div>전화: ${escapeHtml(o.buyer_phone_masked || '-')}</div>
        <div>주소: ${escapeHtml(o.buyer_address_masked || '-')}</div>
        ${o.tracking_number ? `<div>송장: ${escapeHtml(o.courier_code || '')} ${escapeHtml(o.tracking_number)}</div>` : ''}
      </div>
    `;
  }

  function renderTracking(events) {
    const wrap = document.getElementById('trackingStepper');
    if (!events || events.length === 0) { wrap.hidden = true; return; }
    wrap.hidden = false;
    document.getElementById('stepperList').innerHTML = events.map((e) => `
      <li>
        <span class="stepper__dot"></span>
        <div>
          <p class="stepper__title">${escapeHtml(e.description || e.status || '-')}</p>
          <p class="stepper__meta">${escapeHtml(e.location || '')} · ${escapeHtml(formatTime(e.occurred_at))}</p>
        </div>
      </li>
    `).join('');
  }

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function bindActions(o) {
    const trackingBtn = document.getElementById('actionTrackingBtn');
    const returnBtn = document.getElementById('actionReturnBtn');
    trackingBtn.disabled = !(o.status === 'paid' && !o.tracking_number);
    returnBtn.disabled = !(o.status === 'returned' && !o.stock_restored);

    document.getElementById('refreshTrackingBtn').addEventListener('click', async () => {
      try {
        const res = await authFetch('/api/track-shipment', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order_id: o.id }),
        });
        const data = await res.json();
        if (data.success) load();
        else alert(data.error || '추적 실패');
      } catch { alert('네트워크 오류'); }
    });

    returnBtn.addEventListener('click', async () => {
      if (!confirm('반품 처리하면 재고가 자동 가산돼요. 계속할까요?')) return;
      try {
        const res = await authFetch('/api/process-return', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order_id: o.id }),
        });
        const data = await res.json();
        if (data.success) { alert('반품을 처리했어요.'); load(); }
        else alert(data.error || '실패');
      } catch { alert('네트워크 오류'); }
    });
  }

  document.addEventListener('DOMContentLoaded', load);
})();
