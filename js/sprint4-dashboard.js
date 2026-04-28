// sprint4-dashboard.js — Sprint 4 통합 대시보드 클라이언트
// 모바일 + PC 동일 응답 사용 (시장 중심 피벗 = 트렌드 1번 카드)

(function () {
  'use strict';

  const SUPABASE_URL = window.SUPABASE_URL || 'https://kfacacxqshpnipngdsuk.supabase.co';
  const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || '';

  // 토큰 (Sprint 1 가입 후 localStorage 저장)
  function getToken() {
    return (localStorage.getItem('lumi_seller_jwt') || '').trim();
  }

  function authHeaders() {
    const t = getToken();
    return t ? { 'Authorization': `Bearer ${t}` } : {};
  }

  function fmt(n) {
    return Number(n || 0).toLocaleString('ko-KR');
  }
  function fmtKR(n) { return '₩' + fmt(n); }

  function timeAgo(iso) {
    if (!iso) return '';
    const ms = Date.now() - new Date(iso).getTime();
    const m = Math.round(ms / 60000);
    if (m < 1) return '방금';
    if (m < 60) return `${m}분 전`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}시간 전`;
    return `${Math.round(h / 24)}일 전`;
  }

  // ─── 1. 트렌드 카드 렌더 ───
  function renderTrendCards(trend) {
    const headline = document.querySelector('[data-bind="trend_headline"]');
    const sub = document.querySelector('[data-bind="trend_sub"]');
    const wrap = document.getElementById('trendCards');
    if (!wrap) return;

    if (headline && trend?.headline) headline.textContent = trend.headline;
    if (sub) sub.textContent = trend?.cards?.length
      ? '시장에서 지금 뜨고 있는 상품을 골라봤어요'
      : '잠시 후 다시 확인해 주세요';

    const cards = (trend && trend.cards) || [];
    if (cards.length === 0) {
      wrap.innerHTML = '<div class="empty-trend">아직 키워드를 모으는 중이에요</div>';
      return;
    }

    wrap.innerHTML = cards.map((c, i) => {
      const seasonBadge = c.season_event
        ? `<span class="trend-card__season-badge">${escapeHtml(c.season_event)} 임박</span>`
        : '';
      const velocityClass = c.signal_tier === 'season' ? 'trend-card__velocity--season' : '';
      const velocityText = c.signal_tier === 'season'
        ? `시즌 임박 · +${c.velocity_pct}%`
        : `+${c.velocity_pct}% 급상승`;
      const priceRange = (c.estimated_revenue_min && c.estimated_revenue_max)
        ? `평균가 ₩${fmt(c.estimated_revenue_min)}~₩${fmt(c.estimated_revenue_max)}`
        : '';
      return `
        <article class="trend-card" data-keyword="${escapeAttr(c.keyword)}" data-category="${escapeAttr(c.category)}">
          ${seasonBadge}
          <span class="trend-card__rank">${i + 1}</span>
          <h3 class="trend-card__keyword">${escapeHtml(c.keyword)}</h3>
          <span class="trend-card__velocity ${velocityClass}">${velocityText}</span>
          <p class="trend-card__reason">${escapeHtml(c.match_reason || '관심 가질 만한 키워드')}</p>
          ${priceRange ? `<p class="trend-card__price-range">${priceRange}</p>` : ''}
          <div class="trend-card__actions">
            <a href="${escapeAttr(c.register_href)}" class="trend-card__cta">${escapeHtml(c.cta_label || '내 매장에 등록')}</a>
            <button class="trend-card__dismiss" type="button" data-action="dismiss-trend">관심 없어요</button>
          </div>
        </article>
      `;
    }).join('');

    // 거절 핸들러
    wrap.querySelectorAll('[data-action="dismiss-trend"]').forEach(btn => {
      btn.addEventListener('click', async (ev) => {
        const card = ev.target.closest('.trend-card');
        if (!card) return;
        const keyword = card.dataset.keyword;
        const category = card.dataset.category;
        try {
          const r = await fetch('/api/dismiss-trend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ keyword, category, reason: 'not_interested' }),
          });
          const data = await r.json();
          if (r.ok) {
            card.style.opacity = '0.4';
            card.style.pointerEvents = 'none';
            const msg = card.querySelector('.trend-card__reason');
            if (msg) msg.textContent = data.message || '알겠어요';
          }
        } catch (_) {}
      });
    });
  }

  // ─── 2. Profit ───
  function renderProfit(profit) {
    if (!profit) return;
    const amt = document.getElementById('profitAmount');
    const delta = document.getElementById('profitDelta');
    if (amt) amt.textContent = fmtKR(profit.net_profit);

    if (delta) {
      if (profit.delta_pct === null || profit.delta_pct === undefined) {
        delta.textContent = `${profit.order_count || 0}건 주문`;
        delta.className = 'profit-card__delta';
      } else if (profit.delta_pct > 0) {
        delta.textContent = `지난 주 대비 +${profit.delta_pct}%`;
        delta.className = 'profit-card__delta profit-card__delta--up';
      } else if (profit.delta_pct < 0) {
        delta.textContent = `지난 주 대비 ${profit.delta_pct}%`;
        delta.className = 'profit-card__delta profit-card__delta--down';
      } else {
        delta.textContent = '지난 주와 비슷해요';
        delta.className = 'profit-card__delta';
      }
    }

    // PC 풀 분해
    const breakdown = document.getElementById('profitBreakdown');
    if (breakdown && window.matchMedia('(min-width: 768px)').matches) {
      breakdown.hidden = false;
      const map = {
        gross: profit.gross_revenue,
        market_fees: profit.breakdown?.market_fees,
        ad_spend: profit.breakdown?.ad_spend,
        logistics: (profit.breakdown?.packaging || 0) + (profit.breakdown?.shipping || 0),
      };
      Object.entries(map).forEach(([k, v]) => {
        const el = breakdown.querySelector(`[data-bind="${k}"]`);
        if (el) el.textContent = fmtKR(v);
      });
    }
  }

  // ─── 3. Sync ───
  function renderSync(sync) {
    if (!sync) return;
    const headline = document.getElementById('syncHeadline');
    const rows = document.getElementById('syncRows');
    if (headline) {
      headline.textContent = sync.headline || '마켓 동기화 상태';
      headline.className = `sync-card__headline sync-card__headline--${sync.tone || 'ok'}`;
    }
    if (rows) {
      const markets = sync.markets || [];
      if (markets.length === 0) {
        rows.innerHTML = '<div class="sync-row"><span class="sync-row__msg">연결된 마켓이 없어요. 설정에서 추가해 주세요.</span></div>';
      } else {
        rows.innerHTML = markets.map(m => `
          <div class="sync-row">
            <span class="sync-row__market">${escapeHtml(m.market_label)}</span>
            <span class="sync-row__msg">${escapeHtml(m.message)}</span>
          </div>
        `).join('');
      }
    }
  }

  // ─── 4. 처리할 일 ───
  function renderPriority(p) {
    if (!p) return;
    const headline = document.getElementById('priorityHeadline');
    const rows = document.getElementById('priorityRows');
    const cards = (p.cards || []);
    const total = (p.totals && p.totals.total_tasks) || 0;
    if (headline) headline.textContent = total === 0 ? '오늘 처리할 일이 없어요' : `오늘 처리할 일 ${total}건`;
    if (rows) {
      rows.innerHTML = cards.length === 0
        ? '<div class="sync-row"><span class="sync-row__msg">밀린 작업이 없어요</span></div>'
        : cards.slice(0, 4).map(c => `
            <div class="sync-row">
              <span class="sync-row__market">${escapeHtml(c.title)}</span>
              <span class="sync-row__msg">${escapeHtml(c.message)}</span>
            </div>
          `).join('');
    }

    // 사이드바 뱃지
    const badge = document.getElementById('navTaskCount');
    if (badge) {
      if (total > 0) { badge.textContent = total; badge.hidden = false; }
      else { badge.hidden = true; }
    }
  }

  // ─── 5. Live Feed ───
  function renderLive(live) {
    if (!live) return;
    const wrap = document.getElementById('liveEvents');
    const headline = document.getElementById('liveHeadline');
    if (headline) headline.textContent = live.headline || '실시간 알림';
    if (!wrap) return;
    const evts = live.events || [];
    if (evts.length === 0) {
      wrap.innerHTML = '<div class="live-feed__empty">최근 알림이 없어요</div>';
      return;
    }
    wrap.innerHTML = evts.map(e => `
      <div class="live-event">
        <div class="live-event__icon live-event__icon--${e.severity}" aria-hidden="true">${escapeHtml(initialOf(e.title))}</div>
        <div class="live-event__body">
          <p class="live-event__title">${escapeHtml(e.title)}</p>
          <p class="live-event__msg">${escapeHtml(e.message || '')}</p>
        </div>
        <span class="live-event__time">${timeAgo(e.created_at)}</span>
      </div>
    `).join('');
  }

  function initialOf(s) {
    return (s || '·').slice(0, 1);
  }

  // ─── 6. PC 풀 차트 ───
  async function loadProfitChart() {
    if (!window.matchMedia('(min-width: 768px)').matches) return;
    try {
      const r = await fetch('/api/profit-summary?period=week&series=true', { headers: authHeaders() });
      if (!r.ok) return;
      const data = await r.json();
      const series = data.series || [];
      const bars = document.getElementById('chartBars');
      if (!bars || series.length === 0) return;
      const max = Math.max(1, ...series.map(s => s.gross_revenue || 0));
      bars.innerHTML = series.map(s => {
        const pct = (s.gross_revenue / max) * 100;
        const day = s.date.slice(5).replace('-', '/');
        return `<div class="pc-chart__bar" style="height:${pct}%;" title="${day}: ${fmtKR(s.gross_revenue)}">
          <span class="pc-chart__bar-label">${day}</span>
        </div>`;
      }).join('');
    } catch (_) {}
  }

  // ─── 7. Realtime 구독 (Live Feed) ───
  function subscribeRealtime(sellerId) {
    if (!window.supabase || !SUPABASE_URL || !SUPABASE_ANON_KEY) return;
    try {
      const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      const ch = client.channel(`seller:${sellerId}:live_events`);
      ch.on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'live_events',
        filter: `seller_id=eq.${sellerId}`,
      }, (payload) => {
        // 즉시 피드 prepend
        const wrap = document.getElementById('liveEvents');
        if (!wrap) return;
        const e = payload.new;
        const html = `
          <div class="live-event live-event--new" style="background:rgba(200,80,122,0.06);">
            <div class="live-event__icon live-event__icon--${e.severity}">${initialOf(e.title)}</div>
            <div class="live-event__body">
              <p class="live-event__title">${escapeHtml(e.title)}</p>
              <p class="live-event__msg">${escapeHtml(e.message || '')}</p>
            </div>
            <span class="live-event__time">방금</span>
          </div>`;
        const empty = wrap.querySelector('.live-feed__empty');
        if (empty) empty.remove();
        wrap.insertAdjacentHTML('afterbegin', html);
      });
      ch.subscribe();
    } catch (_) {}
  }

  // ─── 메인 로드 ───
  async function loadDashboard() {
    try {
      const r = await fetch('/api/dashboard-summary', { headers: authHeaders() });
      if (r.status === 401) {
        location.href = '/signup';
        return;
      }
      if (!r.ok) {
        const t = document.getElementById('greetTitle');
        if (t) t.textContent = '잠시 후 다시 시도해 주세요';
        return;
      }
      const data = await r.json();

      // 인사
      const greetTitle = document.getElementById('greetTitle');
      const greetHello = document.getElementById('greetHello');
      if (greetTitle) greetTitle.textContent = data.greeting || '오늘도 좋은 하루 되세요';
      if (greetHello) greetHello.textContent = '오늘 사장님의 시장';

      const cards = data.cards || {};
      renderTrendCards(cards.trend);
      renderProfit(cards.profit);
      renderSync(cards.sync);
      renderPriority(cards.priority);
      renderLive(cards.live);

      // PC 풀 차트
      loadProfitChart();

      // Realtime 구독 (sellerId가 토큰 안에 있다는 가정 — backend에서 보내주거나 직접 디코드)
      try {
        const tok = getToken();
        if (tok) {
          const parts = tok.split('.');
          if (parts.length === 3) {
            const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
            if (payload.seller_id) subscribeRealtime(payload.seller_id);
          }
        }
      } catch (_) {}
    } catch (e) {
      console.error('[dashboard] 로드 실패:', e.message);
    }
  }

  // ─── Kill Switch (Sprint 3 동일 패턴) ───
  function bindKillSwitch() {
    const btn = document.getElementById('killSwitchBtn');
    const modal = document.getElementById('killModal');
    const confirm = document.getElementById('killConfirm');
    if (!btn || !modal) return;
    btn.addEventListener('click', () => { modal.hidden = false; });
    modal.addEventListener('click', (ev) => {
      if (ev.target.matches('[data-modal-close]')) modal.hidden = true;
    });
    if (confirm) {
      confirm.addEventListener('click', async () => {
        const scope = (modal.querySelector('input[name="killScope"]:checked') || {}).value || 'market:all';
        const [scopeType, scopeValue] = scope.split(':');
        try {
          const r = await fetch('/api/kill-switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({
              scope: scopeType,
              market: scopeValue === 'all' ? undefined : scopeValue,
              action: 'stop',
              reason: '대시보드 긴급 차단',
            }),
          });
          const data = await r.json();
          if (r.ok) {
            alert(data.message || '판매를 즉시 중지했어요');
            modal.hidden = true;
            loadDashboard();
          } else {
            alert(data.error || '차단 실패. 잠시 후 다시 시도해 주세요.');
          }
        } catch (e) {
          alert('네트워크 오류. 잠시 후 다시 시도해 주세요.');
        }
      });
    }
  }

  // 보안 — XSS 방어
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // 시작
  document.addEventListener('DOMContentLoaded', () => {
    bindKillSwitch();
    loadDashboard();
    // 30초마다 자동 갱신 (Realtime 외 fallback)
    setInterval(loadDashboard, 30000);
  });
})();
