// Sprint 3 — tasks.html (우선순위 큐 메인 화면)
(function () {
  'use strict';

  function getToken() {
    return localStorage.getItem('lumi_seller_token') || '';
  }

  function authFetch(url, options) {
    const token = getToken();
    return fetch(url, {
      ...options,
      headers: {
        ...(options && options.headers || {}),
        Authorization: 'Bearer ' + token,
      },
    });
  }

  function bind(name, value) {
    document.querySelectorAll(`[data-bind="${name}"]`).forEach((el) => { el.textContent = value; });
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function renderCard(card) {
    return `
      <article class="priority-card" data-card-id="${escapeHtml(card.id)}">
        <div class="priority-card__icon" aria-hidden="true">
          ${iconFor(card.type)}
        </div>
        <div class="priority-card__body">
          <h3 class="priority-card__title">${escapeHtml(card.title)} <span class="priority-card__count">${card.count}</span></h3>
          <p class="priority-card__hint">${escapeHtml(card.message || '')}</p>
          ${card.ai_hint ? `<p class="priority-card__hint" style="color:#A23A60">${escapeHtml(card.ai_hint)}</p>` : ''}
        </div>
        <a class="priority-card__cta" href="${card.href || '#'}">${escapeHtml(card.cta || '보기')}</a>
      </article>
    `;
  }

  function iconFor(type) {
    switch (type) {
      case 'shipping': return '📦';
      case 'cs': return '💬';
      case 'return': return '↩';
      case 'tracking': return '🚚';
      case 'price': return '₩';
      default: return '✓';
    }
  }

  function showEmpty(message) {
    const root = document.getElementById('priorityCards');
    root.innerHTML = `<div class="empty-state"><p>${escapeHtml(message)}</p></div>`;
  }

  async function load() {
    try {
      const res = await authFetch('/api/priority-queue');
      if (res.status === 401) {
        showEmpty('로그인이 필요해요. 잠시 후 가입 화면으로 이동할게요.');
        setTimeout(() => { location.href = '/signup'; }, 1500);
        return;
      }
      const data = await res.json();
      if (!data.cards || data.cards.length === 0) {
        bind('ai_message', data.ai_message || '오늘 처리할 일이 없어요.');
        bind('totals_summary', '잠시 쉬셔도 돼요.');
        showEmpty('모두 처리됐어요. 사장님 잠시 쉬세요.');
        document.getElementById('batchActions').hidden = true;
        return;
      }

      bind('ai_message', data.ai_message || '');
      const t = data.totals || {};
      bind('totals_summary', `총 ${t.total_tasks || 0}건이 기다려요`);

      const root = document.getElementById('priorityCards');
      root.innerHTML = data.cards.map(renderCard).join('');

      // AI 일괄 제안 (송장 5건+ 이상이면 노출)
      if ((t.pending_shipping || 0) >= 3) {
        const batch = document.getElementById('batchActions');
        batch.hidden = false;
        bind('batch_title', `송장 미입력 ${t.pending_shipping}건`);
        bind('batch_message', '하나하나 입력하기 부담스러우시죠? PC에서 일괄 입력하시면 1분이면 끝나요.');
        document.getElementById('batchYes').onclick = () => { location.href = '/orders?filter=pending_shipping'; };
        document.getElementById('batchSkip').onclick = () => { batch.hidden = true; };
      }
    } catch (e) {
      showEmpty('우선순위를 가져오지 못했어요. 잠시 후 다시 시도해주세요.');
    }
  }

  // Kill switch
  function setupKillSwitch() {
    const btn = document.getElementById('killSwitchBtn');
    const modal = document.getElementById('killModal');
    if (!btn || !modal) return;
    btn.addEventListener('click', () => { modal.hidden = false; });
    modal.querySelectorAll('[data-modal-close]').forEach((el) => {
      el.addEventListener('click', () => { modal.hidden = true; });
    });
    document.getElementById('killConfirm').addEventListener('click', async () => {
      const sel = (document.querySelector('input[name="killScope"]:checked') || {}).value || 'market:all';
      const [scope, target] = sel.split(':');
      const markets = target === 'all' ? ['coupang', 'naver'] : [target];
      try {
        for (const m of markets) {
          const res = await authFetch('/api/kill-switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scope: 'market', market: m, action: 'stop', reason: '셀러 긴급 차단' }),
          });
          await res.json();
        }
        modal.hidden = true;
        alert('판매를 즉시 중지했어요.');
      } catch {
        alert('차단에 실패했어요. 다시 시도해주세요.');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    load();
    setupKillSwitch();
  });
})();
