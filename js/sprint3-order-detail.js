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
      renderMemo(data.order);
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

  function renderMemo(o) {
    const wrap = document.getElementById('memoSection');
    if (!wrap) return;
    const memo = o.seller_memo || '';
    wrap.innerHTML = `
      <div class="memo-block" id="memoBlock">
        <div class="memo-block__header">
          <span class="memo-block__label">
            <i data-lucide="notebook-pen" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px"></i>내부 메모
          </span>
          <button class="btn btn--ghost btn--sm" id="memoEditBtn">
            <i data-lucide="pencil" style="width:13px;height:13px"></i>
          </button>
        </div>
        <p class="memo-block__text" id="memoText">${memo ? escapeHtml(memo) : '<span class="muted">메모 없음</span>'}</p>
        <div class="memo-block__edit" id="memoEditArea" hidden>
          <textarea id="memoTextarea" maxlength="2000" rows="3" placeholder="포장 요청, CS 인계 맥락 등 내부 메모를 입력하세요.">${escapeHtml(memo)}</textarea>
          <div class="memo-block__edit-actions">
            <button class="btn btn--ghost btn--sm" id="memoCancelBtn">취소</button>
            <button class="btn btn--primary btn--sm" id="memoSaveBtn">저장</button>
          </div>
        </div>
      </div>
    `;
    if (typeof lucide !== 'undefined') lucide.createIcons();

    const editBtn = document.getElementById('memoEditBtn');
    const editArea = document.getElementById('memoEditArea');
    const memoText = document.getElementById('memoText');
    const textarea = document.getElementById('memoTextarea');
    const cancelBtn = document.getElementById('memoCancelBtn');
    const saveBtn = document.getElementById('memoSaveBtn');

    editBtn.addEventListener('click', () => {
      editArea.hidden = false;
      editBtn.hidden = true;
      textarea.value = o.seller_memo || '';
      textarea.focus();
    });

    cancelBtn.addEventListener('click', () => {
      editArea.hidden = true;
      editBtn.hidden = false;
    });

    saveBtn.addEventListener('click', async () => {
      const newMemo = textarea.value.trim() || null;
      // Optimistic UI
      memoText.innerHTML = newMemo ? escapeHtml(newMemo) : '<span class="muted">메모 없음</span>';
      editArea.hidden = true;
      editBtn.hidden = false;
      try {
        const res = await authFetch('/api/update-order-memo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: o.id, memo: newMemo }),
        });
        const data = await res.json();
        if (data.success) {
          o.seller_memo = data.seller_memo;
        } else {
          showMemoToast(data.error || '메모 저장에 실패했어요.');
          memoText.innerHTML = o.seller_memo ? escapeHtml(o.seller_memo) : '<span class="muted">메모 없음</span>';
        }
      } catch {
        showMemoToast('네트워크 오류로 메모를 저장하지 못했어요.');
        memoText.innerHTML = o.seller_memo ? escapeHtml(o.seller_memo) : '<span class="muted">메모 없음</span>';
      }
    });
  }

  function showMemoToast(msg) {
    let toast = document.getElementById('memoToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'memoToast';
      toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 18px;border-radius:980px;font-size:13px;z-index:9999;opacity:0;transition:opacity .2s';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    setTimeout(() => { toast.style.opacity = '0'; }, 3000);
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
