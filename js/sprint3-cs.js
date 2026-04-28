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
    // 메모리 project_ai_capability_boundary.md — AI 자동 답변 X.
    // 분류·우선순위·1탭 빠른 답장 템플릿까지만, 답변은 사장님이 직접.
    root.innerHTML = threads.map((t) => `
      <article class="cs-card" data-thread-id="${escapeHtml(t.id)}">
        <div class="cs-card__head">
          <span class="cs-card__category">${categoryLabel(t.category)}</span>
          <span class="cs-card__buyer">${escapeHtml(t.buyer_name_masked || '')} · ${escapeHtml(t.market || '')}</span>
        </div>
        <p class="cs-card__message">${escapeHtml(t.preview_text || '')}</p>
        <textarea class="cs-card__editor" data-editor data-thread-id="${escapeHtml(t.id)}" placeholder="사장님이 직접 답장해주세요"></textarea>
        <div class="cs-card__actions">
          <button class="btn btn--primary" data-action="send" data-thread-id="${escapeHtml(t.id)}">전송하기</button>
        </div>
      </article>
    `).join('');

    root.querySelectorAll('[data-action="send"]').forEach((btn) => {
      btn.addEventListener('click', () => sendReply(btn.dataset.threadId));
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
    // AI 자동 답변 X — 사장님이 직접 작성. 1탭 템플릿만 보조.
    const templates = [
      { label: '발송 안내', text: '안녕하세요 사장님이에요. 주문하신 상품 오늘 발송할게요. 송장번호 곧 보내드릴게요.' },
      { label: '환불 안내', text: '불편 드려 죄송해요. 반품 절차 안내해 드릴게요. 회수 후 영업일 1-2일 내 환불 처리됩니다.' },
      { label: '재고 확인', text: '문의 감사합니다. 재고 확인해 보고 빠르게 답 드릴게요.' },
      { label: '교환 절차', text: '교환 도와드릴게요. 회수 → 검수 → 재발송 순서로 진행됩니다.' },
    ];
    root.innerHTML = `
      <h2 style="margin:0 0 4px">${escapeHtml(t.buyer_name_masked || '')} · ${categoryLabel(t.category)}</h2>
      <p class="muted" style="margin:0 0 16px">${escapeHtml(t.market || '')} · ${escapeHtml(t.preview_text || '').slice(0, 200)}</p>
      <div class="cs-card__message" style="margin:0 0 16px">${escapeHtml(t.preview_text || '')}</div>
      <p class="quick-reply-hint">1탭 빠른 답장 템플릿 — 답장은 사장님이 직접 보내주세요.</p>
      <div class="quick-reply-chips" data-tpl-chips data-thread-id="${escapeHtml(t.id)}">
        ${templates.map((tpl, i) => `<button type="button" class="quick-reply-chip" data-tpl="${i}">${escapeHtml(tpl.label)}</button>`).join('')}
      </div>
      <textarea class="cs-card__editor" data-editor data-thread-id="${escapeHtml(t.id)}" placeholder="사장님이 직접 답장해주세요"></textarea>
      <div class="cs-card__actions">
        <button class="btn btn--primary" data-action="send" data-thread-id="${escapeHtml(t.id)}">전송</button>
      </div>
    `;
    root.querySelectorAll('[data-action="send"]').forEach((b) => b.addEventListener('click', () => sendReply(b.dataset.threadId)));
    root.querySelectorAll('[data-tpl]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const idx = parseInt(chip.getAttribute('data-tpl'), 10);
        const editor = root.querySelector(`textarea[data-editor][data-thread-id="${threadId}"]`);
        if (editor) editor.value = templates[idx].text;
      });
    });
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

  // regenerateSuggest 제거 (메모리 project_ai_capability_boundary.md — AI 자동 답변 X)

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
