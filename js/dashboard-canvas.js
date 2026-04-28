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
  }
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
  function renderActionAgents() {
    const stack = document.getElementById('actionAgentStack');
    if (!stack) return;
    const dismissed = JSON.parse(localStorage.getItem('lumi_aa_dismissed') || '[]');
    const visible = ACTION_AGENT_MOCKS.filter((m) => !dismissed.includes(m.id));
    if (visible.length === 0) {
      stack.innerHTML = '';
      stack.style.display = 'none';
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
        const cur = JSON.parse(localStorage.getItem('lumi_aa_dismissed') || '[]');
        if (!cur.includes(id)) cur.push(id);
        localStorage.setItem('lumi_aa_dismissed', JSON.stringify(cur));
        renderActionAgents();
      });
    });
  }

  // ─── 트렌드 카드 (Canvas 풍) ───
  function renderTrends(trend) {
    const wrap = document.getElementById('trendCanvasCards');
    if (!wrap) return;
    const cards = (trend && trend.cards) || [];
    if (cards.length === 0) {
      wrap.innerHTML = '<div class="widget__empty">키워드를 모으는 중이에요</div>';
      return;
    }
    wrap.innerHTML = cards.slice(0, 4).map((c, i) => `
      <article class="trend-card-c" data-keyword="${escapeHtml(c.keyword)}" data-href="${escapeHtml(c.register_href || '/register-product')}">
        <span class="trend-card-c__rank">#${i + 1}</span>
        <h4 class="trend-card-c__keyword">${escapeHtml(c.keyword)}</h4>
        <span class="trend-card-c__velocity">+${c.velocity_pct || 0}% 급상승</span>
        <p class="trend-card-c__reason">${escapeHtml(c.match_reason || '관심 가질 만한 키워드')}</p>
      </article>
    `).join('');
    wrap.querySelectorAll('.trend-card-c').forEach((el) => {
      el.addEventListener('click', () => {
        const href = el.dataset.href;
        if (href) window.location.href = href;
      });
    });
  }

  // ─── Profit ───
  function renderProfit(profit) {
    const amt = document.getElementById('profitCanvasAmount');
    const delta = document.getElementById('profitCanvasDelta');
    if (!profit) {
      if (amt) amt.textContent = '₩—';
      if (delta) delta.textContent = '계산 중…';
      return;
    }
    if (amt) amt.textContent = fmtKR(profit.net_profit);
    if (delta) {
      const dp = profit.delta_pct;
      if (dp === null || dp === undefined) {
        delta.textContent = `${profit.order_count || 0}건 주문`;
        delta.className = 'profit-canvas__delta';
      } else if (dp > 0) {
        delta.textContent = `지난 주 대비 +${dp}%`;
        delta.className = 'profit-canvas__delta profit-canvas__delta--up';
      } else if (dp < 0) {
        delta.textContent = `지난 주 대비 ${dp}%`;
        delta.className = 'profit-canvas__delta profit-canvas__delta--down';
      } else {
        delta.textContent = '지난 주와 비슷해요';
        delta.className = 'profit-canvas__delta';
      }
    }
  }

  // ─── 처리할 일 ───
  function renderTodos(priority) {
    const wrap = document.getElementById('todoList');
    if (!wrap) return;
    const cards = (priority && priority.cards) || [];
    if (cards.length === 0) {
      wrap.innerHTML = '<div class="widget__empty">밀린 작업이 없어요</div>';
      return;
    }
    wrap.innerHTML = cards.slice(0, 5).map((c) => `
      <div class="todo-row">
        <div class="todo-row__icon">!</div>
        <div class="todo-row__title">${escapeHtml(c.title)}</div>
        <div class="todo-row__count">${escapeHtml(c.message || '')}</div>
      </div>
    `).join('');
    const badge = document.getElementById('navTaskBadge');
    const total = (priority && priority.totals && priority.totals.total_tasks) || 0;
    if (badge) {
      if (total > 0) { badge.textContent = total; badge.hidden = false; }
      else { badge.hidden = true; }
    }
  }

  // ─── Live Stream ───
  function renderLive(live) {
    const wrap = document.getElementById('liveStream');
    if (!wrap) return;
    const evts = (live && live.events) || [];
    if (evts.length === 0) {
      wrap.innerHTML = '<div class="widget__empty">최근 알림이 없어요</div>';
      return;
    }
    wrap.innerHTML = evts.slice(0, 8).map((e) => `
      <div class="live-row">
        <span class="live-row__dot live-row__dot--${escapeHtml(e.severity || 'info')}"></span>
        <span class="live-row__msg">${escapeHtml(e.title || e.message || '알림')}</span>
        <span class="live-row__time">${timeAgo(e.created_at)}</span>
      </div>
    `).join('');
  }

  // ─── 카테고리별 상품 카운트 위젯 (필수) ───
  let categoryDataCache = null;
  let currentCatView = 'list'; // list / tree / chart

  async function loadCategoryCounts() {
    const widget = document.getElementById('categoryWidget');
    if (!widget) return;
    try {
      const r = await fetch('/api/category-counts', { headers: authHeaders() });
      if (r.status === 401) {
        renderCategoryEmpty('로그인 후 다시 확인해 주세요');
        return;
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
      // get-product 일괄 응답 활용 (recent=1 X, list)
      const r = await fetch('/api/get-product', { headers: authHeaders() });
      if (!r.ok) throw new Error('fetch fail');
      const data = await r.json();
      const products = (data.products || []).filter((p) => ids.includes(p.id));
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

  // ─── 메인 dashboard-summary 로드 ───
  async function loadDashboard() {
    try {
      const r = await fetch('/api/dashboard-summary', { headers: authHeaders() });
      if (r.status === 401) {
        // 로그인 필요 — 데모 빈 상태 유지 (베타 셀러 가입 X 시나리오 보호)
        renderTrends({ cards: [] });
        renderProfit(null);
        renderTodos(null);
        renderLive(null);
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
      renderTodos(cards.priority);
      renderLive(cards.live);
    } catch (e) {
      console.error('[dashboard-canvas] 로드 실패');
    }
  }

  // ─── 시작 ───
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme();
    bindThemeFab();
    bindCmdK();
    bindSlideOver();
    bindCategoryViewToggle();
    renderActionAgents();
    loadDashboard();
    loadCategoryCounts();
    setInterval(loadDashboard, 30000);
  });
})();
