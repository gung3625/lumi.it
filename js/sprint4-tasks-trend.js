// sprint4-tasks-trend.js — 모바일 tasks.html 트렌드 카드 전용
// 시장 중심 피벗 = 메인 카드 (메모리 project_market_centric_pivot_0428.md)
(function () {
  'use strict';

  function getToken() { return (localStorage.getItem('lumi_seller_jwt') || '').trim(); }
  function authHeaders() { const t = getToken(); return t ? { 'Authorization': `Bearer ${t}` } : {}; }
  function fmt(n) { return Number(n || 0).toLocaleString('ko-KR'); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  async function loadTrend() {
    const wrap = document.getElementById('trendCards');
    const headline = document.querySelector('[data-bind="trend_headline"]');
    if (!wrap) return;
    try {
      const r = await fetch('/api/trend-recommendations?limit=3', { headers: authHeaders() });
      if (!r.ok) {
        wrap.innerHTML = '<div class="empty-trend">트렌드를 가져오지 못했어요</div>';
        return;
      }
      const data = await r.json();
      if (headline && data.headline) headline.textContent = data.headline;

      const cards = data.cards || [];
      if (cards.length === 0) {
        wrap.innerHTML = '<div class="empty-trend">아직 키워드를 모으는 중이에요</div>';
        return;
      }

      wrap.innerHTML = cards.map((c, i) => {
        const seasonBadge = c.season_event
          ? `<span class="trend-card__season-badge">${escapeHtml(c.season_event)} 임박</span>` : '';
        const velocityClass = c.signal_tier === 'season' ? 'trend-card__velocity--season' : '';
        const velocityText = c.signal_tier === 'season'
          ? `시즌 임박 · +${c.velocity_pct}%`
          : `+${c.velocity_pct}% 급상승`;
        const priceRange = (c.estimated_revenue_min && c.estimated_revenue_max)
          ? `평균가 ₩${fmt(c.estimated_revenue_min)}~₩${fmt(c.estimated_revenue_max)}` : '';
        return `
          <article class="trend-card" data-keyword="${escapeHtml(c.keyword)}" data-category="${escapeHtml(c.category)}">
            ${seasonBadge}
            <span class="trend-card__rank">${i + 1}</span>
            <h3 class="trend-card__keyword">${escapeHtml(c.keyword)}</h3>
            <span class="trend-card__velocity ${velocityClass}">${velocityText}</span>
            <p class="trend-card__reason">${escapeHtml(c.match_reason || '관심 가질 만한 키워드')}</p>
            ${priceRange ? `<p class="trend-card__price-range">${priceRange}</p>` : ''}
            <div class="trend-card__actions">
              <a href="${escapeHtml(c.register_href)}" class="trend-card__cta">${escapeHtml(c.cta_label || '내 매장에 등록')}</a>
              <button class="trend-card__dismiss" type="button" data-action="dismiss-trend">관심 없어요</button>
            </div>
          </article>`;
      }).join('');

      wrap.querySelectorAll('[data-action="dismiss-trend"]').forEach(btn => {
        btn.addEventListener('click', async (ev) => {
          const card = ev.target.closest('.trend-card');
          if (!card) return;
          try {
            await fetch('/api/dismiss-trend', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeaders() },
              body: JSON.stringify({
                keyword: card.dataset.keyword,
                category: card.dataset.category,
                reason: 'not_interested',
              }),
            });
            card.style.opacity = '0.4';
            card.style.pointerEvents = 'none';
          } catch (_) {}
        });
      });
    } catch (e) {
      wrap.innerHTML = '<div class="empty-trend">잠시 후 다시 확인해 주세요</div>';
    }
  }

  document.addEventListener('DOMContentLoaded', loadTrend);
})();
