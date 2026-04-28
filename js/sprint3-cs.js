// Sprint 3 — cs-inbox.html (모바일 카드 + PC 분할 뷰)
(function () {
  'use strict';

  let currentFilter = 'pending';
  let allThreads = [];

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
  function categoryLabel(c) {
    return { shipping: '배송', exchange: '교환', refund: '환불', product: '상품', other: '기타' }[c] || '기타';
  }

  function renderMobile(threads) {
    const root = document.getElementById('csMobile');
    if (threads.length === 0) {
      root.innerHTML = `<div class="empty-state"><p>대기 중인 문의가 없어요.</p></div>`;
      return;
    }
    root.innerHTML = threads.map((t) => `
      <article class="cs-card" data-thread-id="${escapeHtml(t.id)}">
        <div class="cs-card__head">
          <span class="cs-card__category">${categoryLabel(t.category)}</span>
          <span class="cs-card__buyer">${escapeHtml(t.buyer_name_masked || '')} · ${escapeHtml(t.market || '')}</span>
        </div>
        <p class="cs-card__message">${escapeHtml(t.preview_text || '')}</p>
        ${t.ai_suggested_response ? `
          <div class="cs-card__ai-suggestion">
            <span class="cs-card__ai-label">루미가 미리 만들었어요</span>
            <div>${escapeHtml(t.ai_suggested_response).replace(/\n/g, '<br>')}</div>
          </div>
          <textarea class="cs-card__editor" data-editor data-thread-id="${escapeHtml(t.id)}">${escapeHtml(t.ai_suggested_response)}</textarea>
        ` : `
          <textarea class="cs-card__editor" data-editor data-thread-id="${escapeHtml(t.id)}" placeholder="답변을 작성해주세요"></textarea>
        `}
        <div class="cs-card__actions">
          <button class="btn btn--primary" data-action="send" data-thread-id="${escapeHtml(t.id)}">전송하기</button>
          <button class="btn btn--ghost" data-action="suggest" data-thread-id="${escapeHtml(t.id)}">다시 제안</button>
        </div>
      </article>
    `).join('');

    root.querySelectorAll('[data-action="send"]').forEach((btn) => {
      btn.addEventListener('click', () => sendReply(btn.dataset.threadId));
    });
    root.querySelectorAll('[data-action="suggest"]').forEach((btn) => {
      btn.addEventListener('click', () => regenerateSuggest(btn.dataset.threadId));
    });
  }

  function renderDesktopList(threads) {
    const ul = document.getElementById('csList');
    ul.innerHTML = threads.map((t) => `
      <li data-thread-id="${escapeHtml(t.id)}">
        <strong>${escapeHtml(t.buyer_name_masked || '-')}</strong>
        <div style="font-size:13px;color:#555;margin-top:2px">${escapeHtml(t.preview_text || '').slice(0, 60)}</div>
        <div style="font-size:11px;color:#888;margin-top:4px">${categoryLabel(t.category)} · ${escapeHtml(t.market || '')}</div>
      </li>
    `).join('');
    ul.querySelectorAll('li').forEach((li) => {
      li.addEventListener('click', () => {
        ul.querySelectorAll('li').forEach((x) => x.classList.remove('active'));
        li.classList.add('active');
        renderDesktopDetail(li.dataset.threadId);
      });
    });
  }

  function renderDesktopDetail(threadId) {
    const t = allThreads.find((x) => x.id === threadId);
    const root = document.getElementById('csDesktopDetail');
    if (!t) { root.innerHTML = '<p class="muted">선택된 문의가 없어요.</p>'; return; }
    root.innerHTML = `
      <h2 style="margin:0 0 4px">${escapeHtml(t.buyer_name_masked || '')} · ${categoryLabel(t.category)}</h2>
      <p class="muted" style="margin:0 0 16px">${escapeHtml(t.market || '')} · ${escapeHtml(t.preview_text || '').slice(0, 200)}</p>
      <div class="cs-card__message" style="margin:0 0 16px">${escapeHtml(t.preview_text || '')}</div>
      ${t.ai_suggested_response ? `<div class="cs-card__ai-suggestion"><span class="cs-card__ai-label">루미가 미리 만들었어요</span><div>${escapeHtml(t.ai_suggested_response).replace(/\n/g, '<br>')}</div></div>` : ''}
      <textarea class="cs-card__editor" data-editor data-thread-id="${escapeHtml(t.id)}">${escapeHtml(t.ai_suggested_response || '')}</textarea>
      <div class="cs-card__actions">
        <button class="btn btn--primary" data-action="send" data-thread-id="${escapeHtml(t.id)}">전송</button>
        <button class="btn btn--ghost" data-action="suggest" data-thread-id="${escapeHtml(t.id)}">다시 제안</button>
      </div>
    `;
    root.querySelectorAll('[data-action="send"]').forEach((b) => b.addEventListener('click', () => sendReply(b.dataset.threadId)));
    root.querySelectorAll('[data-action="suggest"]').forEach((b) => b.addEventListener('click', () => regenerateSuggest(b.dataset.threadId)));
  }

  async function sendReply(threadId) {
    const editor = document.querySelector(`textarea[data-editor][data-thread-id="${threadId}"]`);
    const content = editor ? editor.value.trim() : '';
    if (!content) { alert('답변 내용을 입력해주세요.'); return; }
    try {
      const res = await authFetch('/api/cs-send-reply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thread_id: threadId, content }),
      });
      const data = await res.json();
      if (data.success) {
        alert('답변을 보냈어요.');
        load();
      } else {
        alert((data.results || [])[0]?.error?.title || '전송 실패');
      }
    } catch { alert('네트워크 오류'); }
  }

  async function regenerateSuggest(threadId) {
    try {
      const res = await authFetch('/api/cs-suggest-reply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thread_id: threadId }),
      });
      const data = await res.json();
      if (data.success) {
        const editor = document.querySelector(`textarea[data-editor][data-thread-id="${threadId}"]`);
        if (editor) editor.value = data.response;
      }
    } catch { /* */ }
  }

  async function load() {
    const root = document.getElementById('csMobile');
    root.innerHTML = `<div class="empty-state"><div class="empty-state__spinner"></div><p>문의를 가져오는 중…</p></div>`;
    try {
      const res = await authFetch(`/api/cs-threads?filter=${encodeURIComponent(currentFilter)}&limit=50`);
      if (res.status === 401) { location.href = '/signup'; return; }
      const data = await res.json();
      allThreads = data.threads || [];
      bind('cs_summary', `${currentFilter === 'pending' ? '대기' : currentFilter === 'resolved' ? '처리 완료' : '전체'} ${data.total || 0}건`);
      renderMobile(allThreads);
      renderDesktopList(allThreads);
      if (allThreads.length > 0) renderDesktopDetail(allThreads[0].id);
    } catch {
      root.innerHTML = `<div class="empty-state"><p>문의를 불러오지 못했어요.</p></div>`;
    }
  }

  function setupChips() {
    document.querySelectorAll('.chip').forEach((c) => {
      c.addEventListener('click', () => {
        document.querySelectorAll('.chip').forEach((x) => x.classList.remove('chip--active'));
        c.classList.add('chip--active');
        currentFilter = c.dataset.filter;
        load();
      });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    setupChips();
    load();
  });
})();
