// dashboard-canvas.js — Linear/Canvas UI 도그마 4축 구현
// 메모리 project_linear_canvas_ui_doctrine_0428.md
// - A. Command Palette (⌘K · Ctrl+K)
// - B. Progressive Detail (SlideOver)
// - C. Card View (List/Board/Chart 토글)
// - D. Action Agent TopBar (mock data 베타)
// + 카테고리별 상품 카운트 위젯 (Supabase products)
//
// 베타 단계 = LLM 호출 선언만 미작동 (project_agent_architecture_0428.md Phase 1)

(function () {
  'use strict';

  // ─── 토큰 / 헬퍼 ───
  function getToken() {
    return (localStorage.getItem('lumi_seller_jwt') || '').trim();
  }
  function authHeaders() {
    const t = getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }
  function fmt(n) { return Number(n || 0).toLocaleString('ko-KR'); }
  function fmtKR(n) { return '₩' + fmt(n); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
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

  // ─── 다크모드 (frontend.md 룰: localStorage lumi_dark_mode) ───
  function applyTheme() {
    const dark = localStorage.getItem('lumi_dark_mode') === '1';
    document.body.classList.toggle('dark-mode', dark);
    const fab = document.getElementById('themeFab');
    if (fab) fab.textContent = dark ? '☀' : '☾';
    // 모바일 테마 버튼 동기화 (#7)
    const mobileBtn = document.getElementById('mobileThemeBtn');
    if (mobileBtn) mobileBtn.textContent = dark ? '☀' : '☾';
  }
  // 전역 등록 — chat.js 모바일 버튼에서 호출 (#7)
  window.applyTheme = applyTheme;
  function bindThemeFab() {
    const fab = document.getElementById('themeFab');
    if (!fab) return;
    fab.addEventListener('click', () => {
      const cur = localStorage.getItem('lumi_dark_mode') === '1';
      localStorage.setItem('lumi_dark_mode', cur ? '0' : '1');
      applyTheme();
    });
  }

  // ─── A. Command Palette ───
  const CMD_REGISTRY = [
    { id: 'register-product', group: '명령', title: '상품 등록', desc: '사진 1장으로 멀티마켓 등록', tag: 'register', href: '/register-product', icon: '+' },
    { id: 'view-orders', group: '명령', title: '오늘 주문 보기', desc: '오늘 들어온 주문', tag: 'orders', href: '/orders', icon: 'O' },
    { id: 'cs-inbox', group: '명령', title: 'CS 인박스', desc: '문의·반품·환불 모음', tag: 'cs', href: '/cs-inbox', icon: 'C' },
    { id: 'trends', group: '명령', title: '트렌드 분석', desc: '오늘 뜨는 키워드', tag: 'trends', href: '/trends', icon: 'T' },
    { id: 'tasks', group: '명령', title: '처리할 일', desc: '송장·반품·우선순위', tag: 'tasks', href: '/tasks', icon: '!' },
    { id: 'settings', group: '명령', title: '설정', desc: '계정·마켓·결제', tag: 'settings', href: '/settings', icon: 'S' },
    { id: 'migration', group: '명령', title: '마이그레이션', desc: '타 솔루션에서 가져오기', tag: 'migration', href: '/migration-wizard', icon: 'M' },
    // Phase 2 = LLM 호출 (베타 단계 미작동, 검색만)
    { id: 'price-down', group: '루미에게 명령 (곧 작동)', title: '쿠팡 가격 500원 내려', desc: '베타 — 정식 출시 시 작동', tag: 'soon', soon: true, icon: '↓' },
    { id: 'register-from-photo', group: '루미에게 명령 (곧 작동)', title: '사진 한 장으로 등록', desc: '베타 — 정식 출시 시 작동', tag: 'soon', soon: true, icon: 'P' },
    { id: 'find-trend', group: '루미에게 명령 (곧 작동)', title: '오늘 뜨는 상품 추천', desc: '베타 — 정식 출시 시 작동', tag: 'soon', soon: true, icon: '?' },
  ];

  function openCmdK() {
    const el = document.getElementById('cmdk');
    if (!el) return;
    el.classList.add('is-open');
    const input = document.getElementById('cmdkInput');
    if (input) {
      input.value = '';
      setTimeout(() => input.focus(), 30);
    }
    renderCmdList('');
    document.body.style.overflow = 'hidden';
  }
  function closeCmdK() {
    const el = document.getElementById('cmdk');
    if (!el) return;
    el.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  let cmdActiveIdx = 0;
  let cmdLastResults = [];

  function renderCmdList(q) {
    const list = document.getElementById('cmdkList');
    if (!list) return;
    const query = (q || '').toLowerCase().trim();
    const filtered = query
      ? CMD_REGISTRY.filter((c) =>
          c.title.toLowerCase().includes(query) ||
          (c.desc || '').toLowerCase().includes(query) ||
          (c.tag || '').toLowerCase().includes(query)
        )
      : CMD_REGISTRY;
    cmdLastResults = filtered;
    cmdActiveIdx = 0;
    if (filtered.length === 0) {
      list.innerHTML = '<div class="cmdk__empty">결과가 없어요. 다른 키워드를 시도해 보세요.</div>';
      return;
    }
    const groups = {};
    filtered.forEach((c) => {
      if (!groups[c.group]) groups[c.group] = [];
      groups[c.group].push(c);
    });
    let html = '';
    let runningIdx = 0;
    Object.entries(groups).forEach(([gName, items]) => {
      html += `<div class="cmdk__group-label">${escapeHtml(gName)}</div>`;
      items.forEach((c) => {
        const isActive = runningIdx === 0;
        const tagBadge = c.soon ? '<span class="cmdk__item-tag">곧 작동</span>' : '';
        html += `
          <div class="cmdk__item${isActive ? ' is-active' : ''}" data-cmd-id="${escapeHtml(c.id)}" data-idx="${runningIdx}">
            <span class="cmdk__item-icon">${escapeHtml(c.icon || '·')}</span>
            <div class="cmdk__item-body">
              <p class="cmdk__item-title">${escapeHtml(c.title)}</p>
              <p class="cmdk__item-desc">${escapeHtml(c.desc || '')}</p>
            </div>
            ${tagBadge}
          </div>`;
        runningIdx += 1;
      });
    });
    list.innerHTML = html;

    list.querySelectorAll('[data-cmd-id]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.dataset.cmdId;
        executeCmd(id);
      });
      el.addEventListener('mousemove', () => {
        list.querySelectorAll('.cmdk__item').forEach((n) => n.classList.remove('is-active'));
        el.classList.add('is-active');
        cmdActiveIdx = parseInt(el.dataset.idx, 10) || 0;
      });
    });
  }

  function moveCmdActive(dir) {
    if (cmdLastResults.length === 0) return;
    cmdActiveIdx = (cmdActiveIdx + dir + cmdLastResults.length) % cmdLastResults.length;
    const list = document.getElementById('cmdkList');
    if (!list) return;
    list.querySelectorAll('.cmdk__item').forEach((n) => n.classList.remove('is-active'));
    const target = list.querySelector(`[data-idx="${cmdActiveIdx}"]`);
    if (target) {
      target.classList.add('is-active');
      target.scrollIntoView({ block: 'nearest' });
    }
  }

  function executeCmd(id) {
    const cmd = CMD_REGISTRY.find((c) => c.id === id);
    if (!cmd) return;
    if (cmd.soon) {
      // 베타 단계 = 토스트만, LLM 호출 X
      flash('정식 출시 시 작동해요. 베타에서는 메뉴를 사용해 주세요.');
      return;
    }
    if (cmd.href) {
      window.location.href = cmd.href;
      return;
    }
  }

  function flash(msg) {
    let el = document.getElementById('canvasFlash');
    if (!el) {
      el = document.createElement('div');
      el.id = 'canvasFlash';
      el.style.cssText =
        'position:fixed;bottom:84px;left:50%;transform:translateX(-50%);background:#18181b;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;z-index:300;box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:90vw;text-align:center';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(window.__lumiFlashT);
    window.__lumiFlashT = setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2500);
  }

  function bindCmdK() {
    const heroInput = document.getElementById('cmdHeroTrigger');
    if (heroInput) heroInput.addEventListener('click', openCmdK);

    const cmdkInput = document.getElementById('cmdkInput');
    if (cmdkInput) {
      cmdkInput.addEventListener('input', (e) => renderCmdList(e.target.value));
      cmdkInput.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveCmdActive(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); moveCmdActive(-1); }
        else if (e.key === 'Enter') {
          e.preventDefault();
          const target = cmdLastResults[cmdActiveIdx];
          if (target) executeCmd(target.id);
        } else if (e.key === 'Escape') {
          closeCmdK();
        }
      });
    }

    const closeBtn = document.getElementById('cmdkClose');
    if (closeBtn) closeBtn.addEventListener('click', closeCmdK);

    const backdrop = document.querySelector('#cmdk .cmdk__panel');
    const wrap = document.getElementById('cmdk');
    if (wrap) {
      wrap.addEventListener('click', (e) => {
        if (e.target === wrap) closeCmdK();
      });
    }

    document.addEventListener('keydown', (e) => {
      const isMac = navigator.platform.toUpperCase().includes('MAC');
      const cmdKey = (isMac && e.metaKey) || (!isMac && e.ctrlKey);
      if (cmdKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const el = document.getElementById('cmdk');
        if (el && el.classList.contains('is-open')) closeCmdK();
        else openCmdK();
      } else if (e.key === 'Escape') {
        const el = document.getElementById('cmdk');
        if (el && el.classList.contains('is-open')) closeCmdK();
        const so = document.getElementById('slideover');
        if (so && so.classList.contains('is-open')) closeSlideOver();
      }
    });

    document.querySelectorAll('[data-suggest]').forEach((el) => {
      el.addEventListener('click', () => {
        openCmdK();
        const cmdkInput = document.getElementById('cmdkInput');
        if (cmdkInput) {
          cmdkInput.value = el.dataset.suggest || '';
          renderCmdList(cmdkInput.value);
        }
      });
    });
  }

  // ─── B. SlideOver (Progressive Detail) ───
  function openSlideOver({ title, body, footer }) {
    const so = document.getElementById('slideover');
    if (!so) return;
    const t = document.getElementById('slideoverTitle');
    const b = document.getElementById('slideoverBody');
    const f = document.getElementById('slideoverFooter');
    if (t) t.textContent = title || '상세';
    if (b) b.innerHTML = body || '';
    if (f) f.innerHTML = footer || '';
    so.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }
  function closeSlideOver() {
    const so = document.getElementById('slideover');
    if (!so) return;
    so.classList.remove('is-open');
    document.body.style.overflow = '';
  }
  function bindSlideOver() {
    const close = document.getElementById('slideoverClose');
    if (close) close.addEventListener('click', closeSlideOver);
    const backdrop = document.querySelector('#slideover .slideover__backdrop');
    if (backdrop) backdrop.addEventListener('click', closeSlideOver);
  }

  // ─── D. Action Agent (mock 3개, 베타) ───
  const ACTION_AGENT_MOCKS = [
    {
      id: 'price-diff',
      title: '루미가 발견: 가격 차이',
      msg: '쿠팡 판매가가 네이버보다 ₩500 비쌉니다.',
      cta: '일괄 수정 검토',
      onCta: () => flash('베타 단계 — 정식 출시 시 1탭으로 일괄 수정해요'),
    },
    {
      id: 'low-stock',
      title: '루미가 발견: 재고 5개 이하',
      msg: '재고 부족 상품 3개. 재발주 시점이에요.',
      cta: '재발주 검토',
      onCta: () => { window.location.href = '/orders'; },
    },
    {
      id: 'trend-gap',
      title: '루미가 발견: 트렌드 +400%',
      msg: '뜨는 카테고리에 등록된 상품이 0개에요.',
      cta: '관련 상품 등록',
      onCta: () => { window.location.href = '/register-product'; },
    },
  ];
  // #4: 통합 키 상수 (구 키 lumi_aa_dismissed·lumi_top_agent_dismissed → 단일 키로 마이그레이션)
  const AA_DISMISSED_KEY = 'lumi_action_agent_dismissed';
  (function migrateAaDismissed() {
    const legacyKeys = ['lumi_aa_dismissed', 'lumi_top_agent_dismissed'];
    let merged = JSON.parse(localStorage.getItem(AA_DISMISSED_KEY) || '[]');
    legacyKeys.forEach((k) => {
      const old = JSON.parse(localStorage.getItem(k) || '[]');
      old.forEach((id) => { if (!merged.includes(id)) merged.push(id); });
      localStorage.removeItem(k);
    });
    localStorage.setItem(AA_DISMISSED_KEY, JSON.stringify(merged));
  })();

  function renderActionAgents() {
    const stack = document.getElementById('actionAgentStack');
    if (!stack) return;
    const dismissed = JSON.parse(localStorage.getItem(AA_DISMISSED_KEY) || '[]');
    const visible = ACTION_AGENT_MOCKS.filter((m) => !dismissed.includes(m.id));
    if (visible.length === 0) {
      // M11: 모든 제안이 닫혔거나 없을 때 — 빈 상태 정직 표기
      stack.innerHTML = '<div class="action-agent action-agent--empty"><p class="action-agent__msg" style="color:var(--text-secondary,#888);font-size:13px;padding:12px 16px;">아직 제안할 게 없어요. 명령창에 입력해 주세요</p></div>';
      stack.style.display = '';
      return;
    }
    stack.style.display = '';
    stack.innerHTML = visible.map((m) => `
      <div class="action-agent" data-aa-id="${escapeHtml(m.id)}">
        <div class="action-agent__avatar">
          <img src="/assets/logo-cloud.png" alt="루미" onerror="this.style.display='none';this.parentNode.style.background='var(--canvas-gradient-cta)'" />
        </div>
        <div class="action-agent__body">
          <p class="action-agent__title">${escapeHtml(m.title)}</p>
          <p class="action-agent__msg">${escapeHtml(m.msg)}</p>
        </div>
        <div class="action-agent__actions">
          <button class="action-agent__cta" type="button" data-aa-cta="${escapeHtml(m.id)}">${escapeHtml(m.cta)}</button>
          <button class="action-agent__dismiss" type="button" aria-label="닫기" data-aa-dismiss="${escapeHtml(m.id)}">×</button>
        </div>
      </div>
    `).join('');

    stack.querySelectorAll('[data-aa-cta]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.aaCta;
        const item = ACTION_AGENT_MOCKS.find((m) => m.id === id);
        if (item && item.onCta) item.onCta();
      });
    });
    stack.querySelectorAll('[data-aa-dismiss]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.aaDismiss;
        const cur = JSON.parse(localStorage.getItem(AA_DISMISSED_KEY) || '[]');
        if (!cur.includes(id)) cur.push(id);
        localStorage.setItem(AA_DISMISSED_KEY, JSON.stringify(cur));
        renderActionAgents();
      });
    });
  }

  // ─── 트렌드 카드 (Canvas 풍, 시장 중심 카드 양식) ───
  // 메모리 project_market_centric_pivot_0428.md: 키워드 + 증가율 + 카테고리 + 타겟 + 평균가 + CTA
  function renderTrends(trend) {
    const wrap = document.getElementById('trendCanvasCards');
    if (!wrap) return;
    const cards = (trend && trend.cards) || [];
    if (cards.length === 0) {
      wrap.innerHTML = `
        <div class="canvas-empty">
          <div class="canvas-empty__icon">↗</div>
          <p class="canvas-empty__title">아직 트렌드가 모이지 않았어요</p>
          <p>잠시 후 자동으로 갱신돼요</p>
        </div>`;
      return;
    }
    wrap.innerHTML = cards.slice(0, 4).map((c, i) => {
      const velocity = c.velocity_pct || 0;
      const category = c.category_label || c.category || '';
      const target = c.target_demo || c.audience || '';
      const minP = c.estimated_revenue_min || c.avg_price_min || 0;
      const maxP = c.estimated_revenue_max || c.avg_price_max || 0;
      const priceRange = (minP && maxP) ? `평균가 ₩${fmt(minP)}~₩${fmt(maxP)}` : '';
      const href = c.register_href || (`/register-product?from=trend&keyword=${encodeURIComponent(c.keyword)}` + (c.category ? `&category=${encodeURIComponent(c.category)}` : ''));
      return `
        <article class="trend-card-c" data-href="${escapeHtml(href)}">
          <span class="trend-card-c__rank">#${i + 1}</span>
          <h4 class="trend-card-c__keyword">${escapeHtml(c.keyword)}</h4>
          <span class="trend-card-c__velocity">+${velocity}% 급상승</span>
          ${category ? `<p class="trend-card-c__meta">${escapeHtml(category)}${target ? ` · ${escapeHtml(target)}` : ''}</p>` : ''}
          ${priceRange ? `<p class="trend-card-c__price">${escapeHtml(priceRange)}</p>` : ''}
          <p class="trend-card-c__reason">${escapeHtml(c.match_reason || '관심 가질 만한 키워드')}</p>
          <button type="button" class="trend-card-c__cta" data-href="${escapeHtml(href)}">이 상품 등록하기 →</button>
        </article>
      `;
    }).join('');
    wrap.querySelectorAll('[data-href]').forEach((el) => {
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const href = el.dataset.href;
        if (href) window.location.href = href;
      });
    });
  }

  // ─── Profit (period toggle + breakdown) ───
  let _profitPeriod = 'week';
  let _profitLastResp = null;

  const PERIOD_LABEL = { day: '오늘', week: '이번 주', month: '이번 달' };
  const PERIOD_COMPARE_LABEL = { day: '어제 대비', week: '지난 주 대비', month: '지난 달 대비' };

  function renderProfit(profit) {
    const amt = document.getElementById('profitCanvasAmount');
    const delta = document.getElementById('profitCanvasDelta');
    const sub = document.getElementById('profitSubtitle');
    const breakdownEl = document.getElementById('profitBreakdownList');
    if (sub) sub.textContent = `${PERIOD_LABEL[_profitPeriod] || '이번 주'} · 수수료·광고·포장 차감`;

    if (!profit) {
      if (amt) amt.textContent = '₩0';
      if (delta) {
        delta.textContent = '아직 주문이 없어요';
        delta.className = 'profit-canvas__delta';
      }
      if (breakdownEl) { breakdownEl.hidden = true; breakdownEl.innerHTML = ''; }
      return;
    }
    const net = profit.net_profit ?? profit.netProfit ?? 0;
    if (amt) amt.textContent = fmtKR(net);
    if (delta) {
      const dp = profit.delta_pct;
      const compareLabel = PERIOD_COMPARE_LABEL[_profitPeriod] || '지난 기간 대비';
      if (dp === null || dp === undefined) {
        delta.textContent = `${profit.order_count || 0}건 주문`;
        delta.className = 'profit-canvas__delta';
      } else if (dp > 0) {
        delta.textContent = `${compareLabel} +${dp}%`;
        delta.className = 'profit-canvas__delta profit-canvas__delta--up';
      } else if (dp < 0) {
        delta.textContent = `${compareLabel} ${dp}%`;
        delta.className = 'profit-canvas__delta profit-canvas__delta--down';
      } else {
        delta.textContent = `${compareLabel} 비슷해요`;
        delta.className = 'profit-canvas__delta';
      }
    }

    if (breakdownEl) {
      const b = profit.breakdown || {};
      const gross = profit.gross_revenue ?? profit.grossRevenue ?? 0;
      const items = [
        { label: '총 매출', value: gross, kind: 'plus' },
        { label: '마켓 수수료', value: -(b.market_fees || 0), kind: 'minus' },
        { label: '광고비', value: -(b.ad_spend || 0), kind: 'minus' },
        { label: '포장·배송비', value: -((b.packaging || 0) + (b.shipping || 0)), kind: 'minus' },
      ];
      const hasAny = gross > 0 || (b.market_fees || 0) > 0 || (b.ad_spend || 0) > 0;
      if (!hasAny) {
        breakdownEl.hidden = true;
        breakdownEl.innerHTML = '';
      } else {
        breakdownEl.hidden = false;
        breakdownEl.innerHTML = items.map((it) => `
          <div class="profit-breakdown__row">
            <span class="profit-breakdown__label">${escapeHtml(it.label)}</span>
            <span class="profit-breakdown__value profit-breakdown__value--${it.kind}">${it.value < 0 ? '-' : ''}${fmtKR(Math.abs(it.value))}</span>
          </div>
        `).join('');
      }
    }
  }

  async function loadProfitForPeriod(period) {
    _profitPeriod = period;
    try {
      const r = await fetch(`/api/profit-summary?period=${encodeURIComponent(period)}`, { headers: authHeaders() });
      if (!r.ok) {
        // 401/500: 빈 상태
        renderProfit(null);
        return;
      }
      const data = await r.json();
      _profitLastResp = data;
      const t = data.totals || {};
      const profit = {
        net_profit: t.netProfit || 0,
        gross_revenue: t.grossRevenue || 0,
        delta_pct: data.deltaPct ?? null,
        order_count: t.orderCount || 0,
        breakdown: {
          market_fees: t.marketFees || 0,
          ad_spend: t.adSpend || 0,
          packaging: t.packagingCost || 0,
          shipping: t.shippingCost || 0,
          payment_fees: t.paymentFees || 0,
          vat: t.vat || 0,
        },
      };
      renderProfit(profit);
    } catch (_) {
      renderProfit(null);
    }
  }

  function bindProfitPeriod() {
    const toggle = document.getElementById('profitPeriodToggle');
    if (!toggle) return;
    toggle.querySelectorAll('[data-period]').forEach((btn) => {
      btn.addEventListener('click', () => {
        toggle.querySelectorAll('[data-period]').forEach((n) => n.classList.remove('view-toggle__btn--active'));
        btn.classList.add('view-toggle__btn--active');
        loadProfitForPeriod(btn.dataset.period);
      });
    });
  }

  // ─── 정산 위젯 (이달 매출·수수료·VAT·순이익) ───
  function currentPeriod() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  function renderSettlement(data) {
    const grossEl = document.getElementById('settlementGross');
    const feesEl = document.getElementById('settlementFees');
    const vatEl = document.getElementById('settlementVat');
    const netEl = document.getElementById('settlementNet');
    const subEl = document.getElementById('settlementSubtitle');
    const deltaEl = document.getElementById('settlementDelta');
    const hintEl = document.getElementById('settlementHint');
    const period = data?.period || currentPeriod();
    const monthLabel = period.replace('-', '년 ') + '월';
    if (subEl) subEl.textContent = `${monthLabel} · 매출·수수료·VAT·순이익`;

    if (!data || !data.summary) {
      if (grossEl) grossEl.textContent = '₩0';
      if (feesEl) feesEl.textContent = '-₩0';
      if (vatEl) vatEl.textContent = '-₩0';
      if (netEl) netEl.textContent = '₩0';
      if (deltaEl) {
        deltaEl.textContent = '아직 거래가 없어요';
        deltaEl.className = 'settlement-canvas__delta';
      }
      if (hintEl) hintEl.hidden = true;
      return;
    }
    const s = data.summary;
    if (grossEl) grossEl.textContent = fmtKR(s.gross_revenue || 0);
    if (feesEl) feesEl.textContent = '-' + fmtKR(s.marketplace_fees_total || 0);
    if (vatEl) vatEl.textContent = '-' + fmtKR(s.vat_payable || 0);
    if (netEl) netEl.textContent = fmtKR(s.net_profit || 0);

    if (deltaEl) {
      const dp = data.previous?.delta_pct;
      if (dp === null || dp === undefined) {
        deltaEl.textContent = `${s.order_count || 0}건 거래`;
        deltaEl.className = 'settlement-canvas__delta';
      } else if (dp > 0) {
        deltaEl.textContent = `전월 대비 +${dp}%`;
        deltaEl.className = 'settlement-canvas__delta settlement-canvas__delta--up';
      } else if (dp < 0) {
        deltaEl.textContent = `전월 대비 ${dp}%`;
        deltaEl.className = 'settlement-canvas__delta settlement-canvas__delta--down';
      } else {
        deltaEl.textContent = '전월과 비슷해요';
        deltaEl.className = 'settlement-canvas__delta';
      }
    }

    if (hintEl) {
      const refundable = s.vat_refundable || 0;
      const disclaimer = data.summary?.vat_disclaimer || s.vat_disclaimer || '';
      const parts = [];
      if (refundable > 0) parts.push(`매입세액 환급 가능 ₩${fmt(refundable)} (마켓 수수료·광고비 부가세)`);
      if (disclaimer) parts.push(disclaimer);
      if (parts.length > 0) {
        hintEl.textContent = parts.join(' · ');
        hintEl.hidden = false;
      } else {
        hintEl.hidden = true;
      }
    }
  }

  async function loadSettlement() {
    try {
      const period = currentPeriod();
      const r = await fetch(`/api/settlement-monthly?period=${encodeURIComponent(period)}`, { headers: authHeaders() });
      if (!r.ok) {
        renderSettlement(null);
        return;
      }
      const data = await r.json();
      renderSettlement(data);
    } catch (_) {
      renderSettlement(null);
    }
  }

  function bindSettlementCsv() {
    const btn = document.getElementById('settlementCsvBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const period = currentPeriod();
      const token = getToken();
      if (!token) {
        alert('로그인이 필요해요.');
        return;
      }
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = '내려받는 중…';
      try {
        const r = await fetch(`/api/settlement-csv?period=${encodeURIComponent(period)}`, {
          headers: authHeaders(),
        });
        if (!r.ok) throw new Error('CSV 받기 실패');
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `lumi-settlement-${period}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) {
        alert('CSV를 받지 못했어요. 다시 시도해 주세요.');
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  }

  // ─── 우선순위 큐 (긴급·VIP·일반 3-column) ───
  // 긴급: priority>=90 (송장·CS) 또는 type∈(shipping,return,cs)
  // VIP: card.vip || metadata.is_vip
  // 일반: 그 외
  function classifyPriority(card) {
    if (card.bucket) return card.bucket;
    if (card.vip || (card.metadata && card.metadata.is_vip)) return 'vip';
    if ((card.priority || 0) >= 90) return 'urgent';
    if (['shipping', 'return', 'cs'].includes(card.type)) return 'urgent';
    return 'normal';
  }

  function renderPriorityQueue(priority) {
    const buckets = { urgent: [], vip: [], normal: [] };
    const cards = (priority && priority.cards) || [];
    cards.forEach((c) => {
      const b = classifyPriority(c);
      buckets[b].push(c);
    });

    function paint(targetId, list) {
      const el = document.getElementById(targetId);
      if (!el) return;
      if (list.length === 0) {
        el.innerHTML = '<div class="widget__empty">없음</div>';
        return;
      }
      el.innerHTML = list.slice(0, 5).map((c) => `
        <a class="priority-row" href="${escapeHtml(c.href || '/tasks')}">
          <span class="priority-row__icon">!</span>
          <div class="priority-row__body">
            <p class="priority-row__title">${escapeHtml(c.title || '처리할 일')}</p>
            <p class="priority-row__msg">${escapeHtml(c.message || '')}</p>
          </div>
          ${c.count ? `<span class="priority-row__count">${escapeHtml(String(c.count))}</span>` : ''}
        </a>
      `).join('');
    }

    paint('priorityUrgent', buckets.urgent);
    paint('priorityVip', buckets.vip);
    paint('priorityNormal', buckets.normal);

    const setNum = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = String(n); };
    setNum('priorityUrgentCount', buckets.urgent.length);
    setNum('priorityVipCount', buckets.vip.length);
    setNum('priorityNormalCount', buckets.normal.length);

    const badge = document.getElementById('navTaskBadge');
    const total = (priority && priority.totals && priority.totals.total_tasks) || cards.length;
    if (badge) {
      if (total > 0) { badge.textContent = total; badge.hidden = false; }
      else { badge.hidden = true; }
    }

    const hint = document.getElementById('priorityHint');
    if (hint) {
      if (cards.length === 0) hint.textContent = '처리할 일이 없어요. 잠시 쉬셔도 돼요';
      else hint.textContent = `긴급 ${buckets.urgent.length} · VIP ${buckets.vip.length} · 일반 ${buckets.normal.length}`;
    }
  }

  // ─── Live Stream (Realtime + 최근 이벤트) ───
  let _realtimeChannel = null;

  function renderLive(live) {
    const wrap = document.getElementById('liveStream');
    if (!wrap) return;
    const evts = (live && live.events) || [];
    if (evts.length === 0) {
      wrap.innerHTML = '<div class="widget__empty">최근 알림이 없어요. 새 주문·반품·CS가 들어오면 여기에 바로 표시돼요</div>';
      return;
    }
    wrap.innerHTML = evts.slice(0, 12).map((e) => liveRowHtml(e)).join('');
  }

  function liveRowHtml(e, isFresh) {
    const sev = (e.severity || 'info').toLowerCase();
    const title = e.title || e.message || '알림';
    const market = (e.metadata && e.metadata.market) || e.market || '';
    return `
      <div class="live-row${isFresh ? ' live-row--fresh' : ''}" data-id="${escapeHtml(String(e.id || ''))}">
        <span class="live-row__dot live-row__dot--${escapeHtml(sev)}"></span>
        <span class="live-row__msg">${escapeHtml(title)}${market ? ` · ${escapeHtml(market)}` : ''}</span>
        <span class="live-row__time">${timeAgo(e.created_at)}</span>
      </div>`;
  }

  function setLiveStatus(text, ok) {
    const status = document.getElementById('liveStatus');
    const indicator = document.getElementById('liveIndicator');
    if (status) status.textContent = text;
    if (indicator) indicator.classList.toggle('live-stream__indicator--on', !!ok);
  }

  function decodeJwtPayload(tok) {
    try {
      const parts = tok.split('.');
      if (parts.length !== 3) return null;
      return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    } catch (_) { return null; }
  }

  function subscribeRealtime() {
    if (_realtimeChannel) return;
    const SUPABASE_URL = window.SUPABASE_URL || 'https://kfacacxqshpnipngdsuk.supabase.co';
    const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || '';
    if (!window.supabase || !SUPABASE_ANON_KEY) {
      setLiveStatus('대기 중', false);
      return;
    }
    const tok = getToken();
    const payload = tok ? decodeJwtPayload(tok) : null;
    const sellerId = payload && payload.seller_id;
    if (!sellerId) {
      setLiveStatus('대기 중', false);
      return;
    }
    try {
      const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      const ch = client.channel(`seller:${sellerId}:dashboard-live`);
      const onInsert = (table) => (payload) => {
        const ev = payload.new || {};
        // 표준화: 테이블별 표시 텍스트
        let title = '';
        let severity = 'info';
        if (table === 'live_events') { title = ev.title || ev.message || '새 알림'; severity = ev.severity || 'info'; }
        else if (table === 'marketplace_orders') { title = `새 주문 · ${(ev.market || '').toUpperCase()}`; severity = 'success'; }
        else if (table === 'cs_messages') { title = '새 CS 메시지'; severity = 'warning'; }
        else if (table === 'returns') { title = '반품 요청'; severity = 'error'; }

        const row = { id: ev.id, title, severity, created_at: ev.created_at || new Date().toISOString(), metadata: { market: ev.market } };
        const wrap = document.getElementById('liveStream');
        if (!wrap) return;
        const empty = wrap.querySelector('.widget__empty');
        if (empty) empty.remove();
        wrap.insertAdjacentHTML('afterbegin', liveRowHtml(row, true));
        // 12개 초과 시 트림
        const rows = wrap.querySelectorAll('.live-row');
        if (rows.length > 12) rows[rows.length - 1].remove();
      };

      ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'live_events', filter: `seller_id=eq.${sellerId}` }, onInsert('live_events'));
      ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'marketplace_orders', filter: `seller_id=eq.${sellerId}` }, onInsert('marketplace_orders'));
      ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'cs_messages', filter: `seller_id=eq.${sellerId}` }, onInsert('cs_messages'));

      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') setLiveStatus('실시간 연결됨', true);
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setLiveStatus('재연결 중', false);
      });
      _realtimeChannel = ch;
    } catch (_) {
      setLiveStatus('대기 중', false);
    }
  }

  // ─── Kill Switch ───
  function bindKillSwitch() {
    const open = document.getElementById('killSwitchOpen');
    const modal = document.getElementById('killModal');
    if (!open || !modal) return;
    const result = document.getElementById('killResult');

    function setHidden(hidden) {
      modal.hidden = hidden;
      document.body.style.overflow = hidden ? '' : 'hidden';
      if (hidden && result) { result.hidden = true; result.innerHTML = ''; }
    }

    open.addEventListener('click', () => setHidden(false));
    modal.querySelectorAll('[data-kill-close]').forEach((el) => el.addEventListener('click', () => setHidden(true)));

    const confirm = document.getElementById('killConfirmBtn');
    if (!confirm) return;
    confirm.addEventListener('click', async () => {
      const scopeRaw = (modal.querySelector('input[name="killScope"]:checked') || {}).value || 'market:all';
      const [scopeType, scopeValue] = scopeRaw.split(':');
      const reason = (document.getElementById('killReason') || {}).value || '';
      confirm.disabled = true;
      confirm.textContent = '처리 중…';
      try {
        const body = {
          scope: scopeType,
          action: 'stop',
          reason: reason || '대시보드 긴급 차단',
        };
        if (scopeValue && scopeValue !== 'all') body.market = scopeValue;
        const r = await fetch('/api/kill-switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify(body),
        });
        const data = await r.json().catch(() => ({}));
        if (result) {
          result.hidden = false;
          if (r.ok) {
            const lines = [`<p class="kill-modal__result-msg">${escapeHtml(data.message || '판매를 즉시 중지했어요')}</p>`];
            const rs = Array.isArray(data.results) ? data.results : [];
            if (rs.length > 0) {
              lines.push('<ul class="kill-modal__result-list">');
              rs.forEach((row) => {
                const ok = row.ok;
                lines.push(`<li class="${ok ? 'is-ok' : 'is-fail'}">${escapeHtml(row.market || '')} · ${ok ? '성공' : '실패'}${row.error ? ` (${escapeHtml(row.error)})` : ''}${row.mocked ? ' (모킹)' : ''}</li>`);
              });
              lines.push('</ul>');
            }
            result.innerHTML = lines.join('');
            confirm.textContent = '완료';
          } else {
            result.innerHTML = `<p class="kill-modal__result-msg kill-modal__result-msg--err">${escapeHtml(data.error || '차단에 실패했어요. 잠시 후 다시 시도해 주세요')}</p>`;
            confirm.textContent = '다시 시도';
            confirm.disabled = false;
          }
        }
      } catch (_) {
        if (result) {
          result.hidden = false;
          result.innerHTML = '<p class="kill-modal__result-msg kill-modal__result-msg--err">네트워크 오류. 잠시 후 다시 시도해 주세요</p>';
        }
        confirm.textContent = '다시 시도';
        confirm.disabled = false;
      }
    });
  }

  // ─── 카테고리별 상품 카운트 위젯 (필수) ───
  let categoryDataCache = null;
  let currentCatView = 'list'; // list / tree / chart

  async function loadCategoryCounts() {
    const widget = document.getElementById('categoryWidget');
    if (!widget) return;
    try {
      let r = await fetch('/api/category-counts', { headers: authHeaders() });
      if (r.status === 401) {
        // sellerToken 재동기화 후 1회 재시도
        renderCategoryEmpty('잠깐 데이터를 다시 불러오는 중이에요');
        try {
          const tok = localStorage.getItem('lumi_token');
          if (tok) {
            const meRes = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + tok } });
            if (meRes.ok) {
              const me = await meRes.json();
              if (me && me.sellerToken) {
                localStorage.setItem('lumi_seller_jwt', me.sellerToken);
                localStorage.setItem('lumi_seller_token', me.sellerToken);
              }
            }
          }
          r = await fetch('/api/category-counts', { headers: authHeaders() });
        } catch (_) {}
        if (r.status === 401) {
          renderCategoryEmpty('다시 로그인이 필요해요');
          return;
        }
      }
      if (!r.ok) {
        renderCategoryEmpty('카테고리를 불러오지 못했어요');
        return;
      }
      const data = await r.json();
      categoryDataCache = data;
      renderCategoryWidget();
    } catch (e) {
      renderCategoryEmpty('네트워크 오류');
    }
  }

  function renderCategoryEmpty(msg) {
    const totalNum = document.getElementById('catTotalNum');
    const body = document.getElementById('catBody');
    if (totalNum) totalNum.textContent = '0';
    if (body) body.innerHTML = `<div class="widget__empty">${escapeHtml(msg)}</div>`;
  }

  function renderCategoryWidget() {
    if (!categoryDataCache) return;
    const { total, categories, marketTotals } = categoryDataCache;

    const totalNum = document.getElementById('catTotalNum');
    if (totalNum) totalNum.textContent = fmt(total);

    const marketRow = document.getElementById('catMarketRow');
    if (marketRow) {
      marketRow.innerHTML = `
        <div class="cat-market"><span class="cat-market__dot cat-market__dot--coupang"></span><span class="cat-market__label">쿠팡</span><span class="cat-market__count">${fmt(marketTotals?.coupang || 0)}</span></div>
        <div class="cat-market"><span class="cat-market__dot cat-market__dot--naver"></span><span class="cat-market__label">네이버</span><span class="cat-market__count">${fmt(marketTotals?.naver || 0)}</span></div>
        <div class="cat-market"><span class="cat-market__dot cat-market__dot--toss"></span><span class="cat-market__label">토스</span><span class="cat-market__count">${fmt(marketTotals?.toss || 0)}</span></div>
      `;
    }

    const body = document.getElementById('catBody');
    if (!body) return;

    if (!categories || categories.length === 0) {
      body.innerHTML = `
        <div class="canvas-empty">
          <div class="canvas-empty__icon">+</div>
          <p class="canvas-empty__title">아직 등록된 상품이 없어요</p>
          <p>사진 1장으로 첫 상품을 등록해 보세요</p>
          <a href="/register-product" class="action-agent__cta" style="display:inline-block;margin-top:14px;text-decoration:none;">상품 등록하러 가기</a>
        </div>`;
      return;
    }

    if (currentCatView === 'list') renderCatList(body, categories);
    else if (currentCatView === 'tree') renderCatTree(body, categories);
    else if (currentCatView === 'chart') renderCatChart(body, categories);
  }

  function renderCatList(body, categories) {
    body.innerHTML = `<div class="cat-list">${categories.map((c) => `
      <div class="cat-list__row${c.count === 0 ? ' cat-list__row--zero' : ''}" data-cat-path="${escapeHtml(c.path)}" tabindex="0" role="button">
        <div class="cat-list__path">${escapeHtml(c.path)}</div>
        ${c.count === 0 ? '<a href="/trends" class="cat-list__zero-cta">트렌드 추천</a>' : ''}
        <div class="cat-list__count">${fmt(c.count)}</div>
      </div>
    `).join('')}</div>`;
    bindCatRows(body, categories);
  }

  function renderCatTree(body, categories) {
    // 카테고리 path를 트리로 그룹핑 (대>중>소)
    const tree = {};
    categories.forEach((c) => {
      const segs = c.path.split(' > ');
      let cursor = tree;
      segs.forEach((seg, i) => {
        if (!cursor[seg]) cursor[seg] = { __count: 0, __children: {}, __path: segs.slice(0, i + 1).join(' > ') };
        if (i === segs.length - 1) cursor[seg].__count += c.count;
        cursor = cursor[seg].__children;
      });
    });

    function renderNode(node, depth) {
      let html = '';
      Object.keys(node).sort().forEach((k) => {
        const child = node[k];
        const indent = '─'.repeat(Math.max(0, depth));
        const arrow = depth > 0 ? '└' : '';
        html += `
          <div class="cat-tree__node" data-cat-path="${escapeHtml(child.__path)}" tabindex="0" role="button">
            <span class="cat-tree__indent">${arrow}${indent}</span>
            <span class="cat-tree__label">${escapeHtml(k)}</span>
            <span class="cat-tree__count">${fmt(child.__count || 0)}</span>
          </div>`;
        if (Object.keys(child.__children).length > 0) {
          html += renderNode(child.__children, depth + 1);
        }
      });
      return html;
    }

    body.innerHTML = `<div class="cat-tree">${renderNode(tree, 0)}</div>`;
    bindCatRows(body, categories);
  }

  function renderCatChart(body, categories) {
    const max = Math.max(1, ...categories.map((c) => c.count));
    body.innerHTML = `<div class="cat-bars">${categories.slice(0, 10).map((c) => {
      const pct = (c.count / max) * 100;
      return `
        <div class="cat-bar" data-cat-path="${escapeHtml(c.path)}" tabindex="0" role="button">
          <div class="cat-bar__label-row">
            <span class="cat-bar__label">${escapeHtml(c.path)}</span>
            <span class="cat-bar__count">${fmt(c.count)}</span>
          </div>
          <div class="cat-bar__track"><div class="cat-bar__fill" style="width:${pct}%"></div></div>
        </div>`;
    }).join('')}</div>`;
    bindCatRows(body, categories);
  }

  function bindCatRows(body, categories) {
    body.querySelectorAll('[data-cat-path]').forEach((row) => {
      const handler = () => openCategoryDetail(row.dataset.catPath, categories);
      row.addEventListener('click', handler);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
      });
    });
  }

  async function openCategoryDetail(path, categories) {
    const cat = categories.find((c) => c.path === path);
    if (!cat) return;
    if (cat.count === 0) {
      // 0개 카테고리는 트렌드 추천으로 안내
      openSlideOver({
        title: escapeHtml(path),
        body: `
          <div class="canvas-empty" style="padding:24px 12px;">
            <p class="canvas-empty__title">이 카테고리에 등록된 상품이 없어요</p>
            <p>지금 뜨는 트렌드 키워드를 확인해 보세요</p>
          </div>`,
        footer: `<a href="/trends" class="action-agent__cta" style="text-decoration:none;">트렌드 추천 보기</a>`,
      });
      return;
    }

    // 상품 ID 리스트로 상세 fetch (lazy)
    openSlideOver({
      title: escapeHtml(path) + ` · ${cat.count}개`,
      body: '<div class="widget__empty">불러오는 중…</div>',
      footer: '',
    });

    try {
      const ids = (cat.productIds || []).slice(0, 20);
      if (ids.length === 0) {
        const b = document.getElementById('slideoverBody');
        if (b) b.innerHTML = '<div class="widget__empty">상품을 불러오지 못했어요</div>';
        return;
      }
      // #5: 서버사이드 ids= 필터 + 세션 캐시로 재호출 방지
      if (!window._productCache) window._productCache = {};
      const cacheKey = ids.slice().sort().join(',');
      let products;
      if (window._productCache[cacheKey]) {
        products = window._productCache[cacheKey];
      } else {
        const r = await fetch(`/api/get-product?ids=${encodeURIComponent(ids.join(','))}`, { headers: authHeaders() });
        if (!r.ok) throw new Error('fetch fail');
        const data = await r.json();
        products = data.products || [];
        window._productCache[cacheKey] = products;
      }
      const b = document.getElementById('slideoverBody');
      if (!b) return;
      if (products.length === 0) {
        b.innerHTML = '<div class="widget__empty">상품 정보가 없어요</div>';
        return;
      }
      b.innerHTML = products.map((p) => `
        <div class="so-product-row">
          <div class="so-product-row__thumb">
            ${p.primary_image_url ? `<img src="${escapeHtml(p.primary_image_url)}" alt="" style="width:100%;height:100%;object-fit:cover;" />` : '◯'}
          </div>
          <div style="flex:1;min-width:0;">
            <p class="so-product-row__title">${escapeHtml(p.title || '제목 없음')}</p>
            <p class="so-product-row__meta">${escapeHtml(p.status || 'draft')}</p>
          </div>
          <span class="so-product-row__price">${fmtKR(p.price_suggested || 0)}</span>
        </div>
      `).join('');
      const f = document.getElementById('slideoverFooter');
      if (f) f.innerHTML = `<a href="/register-product" class="action-agent__dismiss" style="text-decoration:none;">새 상품 등록</a>`;
    } catch (_) {
      const b = document.getElementById('slideoverBody');
      if (b) b.innerHTML = '<div class="widget__empty">상품을 불러오지 못했어요</div>';
    }
  }

  function bindCategoryViewToggle() {
    const toggle = document.getElementById('catViewToggle');
    if (!toggle) return;
    toggle.querySelectorAll('[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentCatView = btn.dataset.view;
        toggle.querySelectorAll('[data-view]').forEach((n) => n.classList.remove('view-toggle__btn--active'));
        btn.classList.add('view-toggle__btn--active');
        renderCategoryWidget();
      });
    });
  }

  // ─── AI 인사이트 위젯 ───
  let _insightType = 'weekly';
  let _insightData = null;

  function renderInsight(data) {
    const periodEl = document.getElementById('insightPeriod');
    const summaryEl = document.getElementById('insightSummary');
    const actionsEl = document.getElementById('insightActions');
    const subEl = document.getElementById('insightSubtitle');

    if (!data || !data.report) {
      if (periodEl) periodEl.textContent = '아직 보고서가 없어요';
      if (summaryEl) summaryEl.textContent = _insightType === 'weekly' ? '주간 보고서는 매주 월요일 자동으로 만들어져요.' : '월간 보고서는 매월 1일 자동으로 만들어져요.';
      if (actionsEl) actionsEl.innerHTML = '';
      return;
    }
    const r = data.report;
    if (periodEl) periodEl.textContent = r.period || '';
    if (summaryEl) summaryEl.textContent = r.summary || '';
    if (subEl) subEl.textContent = (_insightType === 'weekly' ? '주간' : '월간') + ' 자동 보고서' + (data.cached ? ' (캐시)' : '');

    if (actionsEl) {
      const actions = Array.isArray(r.actions) ? r.actions.slice(0, 3) : [];
      if (actions.length === 0) {
        actionsEl.innerHTML = '';
      } else {
        actionsEl.innerHTML = actions.map((a) => {
          const title = typeof a === 'string' ? a : (a.title || '');
          return `<button type="button" class="insight-action-chip" data-insight-action="${escapeHtml(title)}">${escapeHtml(title)}</button>`;
        }).join('');
        actionsEl.querySelectorAll('[data-insight-action]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const chatInput = document.getElementById('chatInput');
            if (chatInput) {
              chatInput.value = btn.dataset.insightAction || '';
              chatInput.dispatchEvent(new Event('input'));
              chatInput.focus();
            }
          });
        });
      }
    }
  }

  function buildInsightSlideoverBody(data) {
    if (!data || !data.report) return '<div class="widget__empty">보고서 데이터가 없어요</div>';
    const r = data.report;
    const parts = [];

    // 요약
    parts.push(`<p style="font-size:15px;line-height:1.6;margin-bottom:16px;">${escapeHtml(r.summary || '')}</p>`);

    // 상위 상품
    if (r.top_performers && r.top_performers.length > 0) {
      parts.push('<h3 style="font-size:13px;font-weight:600;color:var(--text-secondary,#888);letter-spacing:.04em;text-transform:uppercase;margin:0 0 8px;">TOP 상품</h3>');
      parts.push('<div class="insight-so__list">');
      r.top_performers.forEach((p) => {
        parts.push(`<div class="insight-so__row"><span class="insight-so__name">${escapeHtml(p.name || '(상품명)')}</span><span class="insight-so__val">${fmtKR(p.revenue || 0)}</span></div>`);
      });
      parts.push('</div>');
    }

    // 트렌드 매칭
    if (r.trend_match && r.trend_match.length > 0) {
      parts.push('<h3 style="font-size:13px;font-weight:600;color:var(--text-secondary,#888);letter-spacing:.04em;text-transform:uppercase;margin:16px 0 8px;">트렌드 매칭</h3>');
      parts.push('<div class="insight-so__list">');
      r.trend_match.forEach((t) => {
        const badge = t.match_in_store ? '<span style="color:#22c55e;font-size:12px;">보유</span>' : '<span style="color:#f59e0b;font-size:12px;">미보유</span>';
        parts.push(`<div class="insight-so__row"><span class="insight-so__name">${escapeHtml(t.trend || '')}</span>${badge}</div>`);
        if (t.suggestion) parts.push(`<p style="font-size:12px;color:var(--text-secondary,#888);margin:-4px 0 8px 0;">${escapeHtml(t.suggestion)}</p>`);
      });
      parts.push('</div>');
    }

    // 예측
    if (r.predictions) {
      const pred = r.predictions;
      parts.push('<h3 style="font-size:13px;font-weight:600;color:var(--text-secondary,#888);letter-spacing:.04em;text-transform:uppercase;margin:16px 0 8px;">예측</h3>');
      parts.push(`<p style="font-size:14px;margin-bottom:6px;">다음 ${_insightType === 'weekly' ? '주' : '달'} 예상 매출: <strong>${fmtKR(pred.next_week_revenue || 0)}</strong> (신뢰도 ${Math.round((pred.confidence || 0.5) * 100)}%)</p>`);
      if (Array.isArray(pred.risks) && pred.risks.length > 0) {
        parts.push(`<p style="font-size:12px;color:#f59e0b;">위험: ${pred.risks.map(escapeHtml).join(' / ')}</p>`);
      }
    }

    // 액션 전체
    if (r.actions && r.actions.length > 0) {
      parts.push('<h3 style="font-size:13px;font-weight:600;color:var(--text-secondary,#888);letter-spacing:.04em;text-transform:uppercase;margin:16px 0 8px;">액션 제안</h3>');
      parts.push('<ol style="padding-left:18px;margin:0;">');
      r.actions.forEach((a) => {
        const title = typeof a === 'string' ? a : (a.title || '');
        parts.push(`<li style="font-size:14px;line-height:1.7;">${escapeHtml(title)}</li>`);
      });
      parts.push('</ol>');
    }

    return parts.join('');
  }

  async function loadInsight(type) {
    _insightType = type || 'weekly';
    const endpoint = _insightType === 'monthly' ? '/api/insight-monthly' : '/api/insight-weekly';
    try {
      const r = await fetch(endpoint, { headers: authHeaders() });
      if (r.status === 401) { renderInsight(null); return; }
      if (!r.ok) { renderInsight(null); return; }
      const data = await r.json();
      _insightData = data;
      renderInsight(data);
    } catch (_) {
      renderInsight(null);
    }
  }

  function bindInsightWidget() {
    const toggle = document.getElementById('insightPeriodToggle');
    if (toggle) {
      toggle.querySelectorAll('[data-insight]').forEach((btn) => {
        btn.addEventListener('click', () => {
          toggle.querySelectorAll('[data-insight]').forEach((n) => n.classList.remove('view-toggle__btn--active'));
          btn.classList.add('view-toggle__btn--active');
          loadInsight(btn.dataset.insight);
        });
      });
    }
    const expandBtn = document.getElementById('insightExpandBtn');
    if (expandBtn) {
      expandBtn.addEventListener('click', () => {
        openSlideOver({
          title: (_insightType === 'weekly' ? '주간' : '월간') + ' AI 인사이트',
          body: buildInsightSlideoverBody(_insightData),
          footer: `<a href="/api/insight-on-demand" class="action-agent__cta" style="text-decoration:none;font-size:13px;" onclick="return false;">수동 요청은 명령창에 "인사이트 다시 만들어 줘" 입력</a>`,
        });
      });
    }
  }

  // ─── 메인 dashboard-summary 로드 ───
  async function loadDashboard() {
    try {
      const r = await fetch('/api/dashboard-summary', { headers: authHeaders() });
      if (r.status === 401) {
        // 로그인 필요 — 데모 빈 상태 유지 (베타 셀러 가입 X 시나리오 보호)
        renderTrends({ cards: [] });
        renderProfit(null);
        renderPriorityQueue({ cards: [], totals: {} });
        renderLive({ events: [] });
        return;
      }
      if (!r.ok) return;
      const data = await r.json();
      const greetTitle = document.getElementById('greetTitle');
      const greetHello = document.getElementById('greetHello');
      if (greetTitle && data.greeting) greetTitle.textContent = data.greeting;
      if (greetHello) greetHello.textContent = '오늘 사장님의 시장';
      const cards = data.cards || {};
      renderTrends(cards.trend);
      renderProfit(cards.profit);
      renderPriorityQueue(cards.priority);
      renderLive(cards.live);
    } catch (e) {
      console.error('[dashboard-canvas] 로드 실패');
    }
  }

  // ─── 채널별 ROI 위젯 ───
  const PERIOD_LABEL_ROI = { day: '오늘', week: '이번 주', month: '이번 달' };
  let _roiPeriod = 'week';

  function renderRoi(data) {
    const canvas = document.getElementById('roiCanvas');
    const sub = document.getElementById('roiSubtitle');
    if (!canvas) return;

    if (sub) sub.textContent = `${PERIOD_LABEL_ROI[_roiPeriod] || '이번 주'} · 채널별 순이익·ROI`;

    // 마켓 미연결 + 주문 없음
    if (!data || (!data.channels || data.channels.length === 0)) {
      canvas.innerHTML = `
        <div class="roi-empty">
          <p class="roi-empty__msg">마켓 연결 후 ROI가 자동 분석됩니다</p>
          <a href="/settings" class="roi-empty__btn">마켓 연결하기</a>
        </div>`;
      return;
    }

    const { channels, total, connectedMarkets } = data;
    const connected = new Set(connectedMarkets || []);
    const hasData = channels.some((c) => c.orderCount > 0);

    let html = `<div class="roi-table">`;

    // 헤더
    html += `<div class="roi-table__head">
      <span class="roi-table__col roi-table__col--name">채널</span>
      <span class="roi-table__col roi-table__col--num">주문</span>
      <span class="roi-table__col roi-table__col--num">매출</span>
      <span class="roi-table__col roi-table__col--num">수수료+배송</span>
      <span class="roi-table__col roi-table__col--num">순이익</span>
      <span class="roi-table__col roi-table__col--num roi-table__col--roi">ROI</span>
    </div>`;

    for (const c of channels) {
      const roiTxt = c.roi !== null ? `${c.roi > 0 ? '+' : ''}${c.roi}%` : '—';
      const roiCls = c.roi === null ? '' : c.roi >= 0 ? 'roi-table__roi--pos' : 'roi-table__roi--neg';
      const profitCls = c.profit < 0 ? 'roi-table__val--minus' : '';
      const badge = !c.connected
        ? `<span class="roi-badge roi-badge--off">미연결</span>`
        : c.orderCount === 0
          ? `<span class="roi-badge roi-badge--idle">데이터 없음</span>`
          : '';

      html += `<div class="roi-table__row">
        <span class="roi-table__col roi-table__col--name">${escapeHtml(c.name)}${badge}</span>
        <span class="roi-table__col roi-table__col--num">${c.orderCount}건</span>
        <span class="roi-table__col roi-table__col--num">${fmtKR(c.revenue)}</span>
        <span class="roi-table__col roi-table__col--num roi-table__val--minus">${fmtKR(c.fees + c.shippingCost)}</span>
        <span class="roi-table__col roi-table__col--num ${profitCls}">${fmtKR(c.profit)}</span>
        <span class="roi-table__col roi-table__col--num ${roiCls}">${roiTxt}</span>
      </div>`;
    }

    // 합계 행
    if (channels.length > 1) {
      const totalRoiTxt = total.roi !== null ? `${total.roi > 0 ? '+' : ''}${total.roi}%` : '—';
      const totalRoiCls = total.roi === null ? '' : total.roi >= 0 ? 'roi-table__roi--pos' : 'roi-table__roi--neg';
      html += `<div class="roi-table__row roi-table__row--total">
        <span class="roi-table__col roi-table__col--name">합계</span>
        <span class="roi-table__col roi-table__col--num">${total.orderCount}건</span>
        <span class="roi-table__col roi-table__col--num">${fmtKR(total.revenue)}</span>
        <span class="roi-table__col roi-table__col--num roi-table__val--minus">${fmtKR(total.fees + total.shippingCost)}</span>
        <span class="roi-table__col roi-table__col--num">${fmtKR(total.profit)}</span>
        <span class="roi-table__col roi-table__col--num ${totalRoiCls}">${totalRoiTxt}</span>
      </div>`;
    }

    html += `</div>`;

    if (!hasData) {
      html += `<p class="roi-mock-note">※ 예시 데이터 — 마켓 주문 발생 시 실제 수치로 자동 교체</p>`;
    }

    canvas.innerHTML = html;
  }

  async function loadRoiForPeriod(period) {
    _roiPeriod = period;
    const canvas = document.getElementById('roiCanvas');
    if (canvas) canvas.innerHTML = `<div class="widget__empty">불러오는 중…</div>`;
    try {
      const r = await fetch(`/api/channel-roi?period=${encodeURIComponent(period)}`, {
        headers: authHeaders(),
      });
      if (!r.ok) throw new Error('api error');
      const data = await r.json();
      renderRoi(data.ok ? data : null);
    } catch (_) {
      renderRoi(null);
    }
  }

  function bindRoiPeriod() {
    const toggle = document.getElementById('roiPeriodToggle');
    if (!toggle) return;
    toggle.querySelectorAll('[data-period]').forEach((btn) => {
      btn.addEventListener('click', () => {
        toggle.querySelectorAll('[data-period]').forEach((n) => n.classList.remove('view-toggle__btn--active'));
        btn.classList.add('view-toggle__btn--active');
        loadRoiForPeriod(btn.dataset.period);
      });
    });
  }

  // ─── 시작 ───
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme();
    bindThemeFab();
    bindCmdK();
    bindSlideOver();
    bindCategoryViewToggle();
    bindProfitPeriod();
    bindSettlementCsv();
    bindKillSwitch();
    bindInsightWidget();
    bindRoiPeriod();
    renderActionAgents();
    loadDashboard();
    loadCategoryCounts();
    // Profit 위젯은 period 토글에 따라 별도 호출 (초기엔 dashboard-summary의 week값으로 충분, but 통일을 위해 period API 한번 호출)
    setTimeout(() => loadProfitForPeriod('week'), 50);
    // AI 인사이트 위젯 (주간 기본)
    setTimeout(() => loadInsight('weekly'), 120);
    // 정산 위젯 (이달)
    setTimeout(loadSettlement, 80);
    // 채널 ROI 위젯 (이번 주 기본)
    setTimeout(() => loadRoiForPeriod('week'), 100);
    // Realtime 구독 (Live Stream)
    subscribeRealtime();
    setInterval(loadDashboard, 30000);
  });
})();

// ── 로그아웃 ──
(function () {
  var logoutLink = document.getElementById('logoutLink');
  if (!logoutLink) return;
  logoutLink.addEventListener('click', async function (e) {
    e.preventDefault();
    try {
      if (window.lumiSupa && window.lumiSupa.auth) {
        await window.lumiSupa.auth.signOut();
      }
    } catch (_) { /* signOut 실패해도 진행 */ }
    try {
      var keep = ['lumi_dark_mode', 'lumi_storage_pubkey_v1_cleaned'];
      Object.keys(localStorage).forEach(function (k) {
        if (keep.indexOf(k) !== -1) return;
        if (k.indexOf('sb-cldsozdocxpvkbuxwqep-') === 0
          || k.indexOf('lumi_') === 0
          || k === 'lumi-auth') {
          localStorage.removeItem(k);
        }
      });
      sessionStorage.clear();
    } catch (_) {}
    window.location.replace('/?stay=1');
  });
})();
