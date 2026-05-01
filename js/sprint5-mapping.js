// sprint5-mapping.js — 주문서 옵션 매핑 UI 로직
// order-mapping.html 전용
// 기능: 매핑 목록 조회, 추가/수정/삭제, 엑셀 가져오기, 마켓 필터

(function () {
  'use strict';

  // ── 상태 ─────────────────────────────────────────────────────
  var state = {
    market: 'all',      // 현재 필터 마켓
    page: 1,
    limit: 50,
    total: 0,
    mappings: [],       // 현재 로드된 매핑 목록
    products: [],       // 마스터 상품 목록 (드롭다운용)
    editingId: null,    // 수정 중인 매핑 id (null = 신규)
    loading: false,
  };

  var MARKET_LABELS = { coupang: '쿠팡', naver: '네이버', toss: '토스쇼핑' };

  // ── 인증 토큰 ─────────────────────────────────────────────────
  function getToken() {
    return (localStorage.getItem('lumi_seller_jwt') || localStorage.getItem('lumi_seller_token') || '').trim();
  }

  // ── API 공통 fetch ─────────────────────────────────────────────
  async function apiFetch(path, options) {
    var opts = Object.assign({ headers: {} }, options || {});
    opts.headers['Authorization'] = 'Bearer ' + getToken();
    if (opts.body && typeof opts.body === 'object') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    var res = await fetch(path, opts);
    var json = await res.json().catch(function () { return {}; });
    return { ok: res.ok, status: res.status, data: json };
  }

  // ── DOM 헬퍼 ──────────────────────────────────────────────────
  function qs(sel, ctx) { return (ctx || document).querySelector(sel); }
  function qsa(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); }
  function show(el) { if (el) el.hidden = false; }
  function hide(el) { if (el) el.hidden = true; }
  function setText(id, text) { var el = document.getElementById(id); if (el) el.textContent = text; }
  function setHTML(id, html) { var el = document.getElementById(id); if (el) el.innerHTML = html; }

  // ── 토스트 알림 ───────────────────────────────────────────────
  function toast(msg, type) {
    var el = document.getElementById('toastMsg');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast toast--' + (type || 'info') + ' toast--show';
    clearTimeout(el._timer);
    el._timer = setTimeout(function () { el.className = el.className.replace(' toast--show', ''); }, 3000);
  }

  // ── 마스터 상품 목록 로드 ────────────────────────────────────
  async function loadProducts() {
    var res = await apiFetch('/api/get-product');
    if (res.ok && Array.isArray(res.data.products)) {
      state.products = res.data.products;
    } else {
      state.products = [];
    }
  }

  // ── 매핑 목록 로드 ────────────────────────────────────────────
  async function loadMappings() {
    if (state.loading) return;
    state.loading = true;
    showTableSkeleton();

    var qs_params = '?page=' + state.page + '&limit=' + state.limit;
    if (state.market !== 'all') qs_params += '&market=' + state.market;

    var res = await apiFetch('/api/list-mappings' + qs_params);
    state.loading = false;

    if (!res.ok) {
      toast(res.data.error || '매핑 목록을 불러오지 못했어요.', 'error');
      renderTableEmpty('목록을 불러오지 못했어요.');
      return;
    }

    state.mappings = res.data.mappings || [];
    state.total = res.data.total || 0;
    renderTable();
    renderPagination();
    updateTotalCount();
  }

  // ── 테이블 스켈레톤 ──────────────────────────────────────────
  function showTableSkeleton() {
    var tbody = document.getElementById('mappingTbody');
    if (!tbody) return;
    var rows = '';
    for (var i = 0; i < 5; i++) {
      rows += '<tr class="skeleton-row"><td colspan="7"><div class="skeleton-line"></div></td></tr>';
    }
    tbody.innerHTML = rows;
  }

  // ── 빈 테이블 ────────────────────────────────────────────────
  function renderTableEmpty(msg) {
    var tbody = document.getElementById('mappingTbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="7" class="table-empty">' + escHtml(msg || '매핑이 없어요. 위 버튼으로 추가해보세요.') + '</td></tr>';
  }

  // ── 테이블 렌더링 ─────────────────────────────────────────────
  function renderTable() {
    var tbody = document.getElementById('mappingTbody');
    if (!tbody) return;
    if (!state.mappings.length) {
      renderTableEmpty();
      return;
    }
    var rows = state.mappings.map(function (m) {
      var marketLabel = MARKET_LABELS[m.market] || m.market;
      var productTitle = (m.products && m.products.title) ? escHtml(m.products.title) : '<span class="text-muted">—</span>';
      var masterOption = m.master_option_name ? escHtml(m.master_option_name) : '<span class="text-muted">—</span>';
      var useCount = typeof m.use_count === 'number' ? m.use_count.toLocaleString() : '0';
      var lastApplied = m.last_applied_at ? formatDate(m.last_applied_at) : '—';
      return '<tr data-id="' + escHtml(m.id) + '">' +
        '<td><span class="market-badge market-badge--' + escHtml(m.market) + '">' + marketLabel + '</span></td>' +
        '<td class="option-cell">' + escHtml(m.market_option_name) + '</td>' +
        '<td>' + productTitle + '</td>' +
        '<td>' + masterOption + '</td>' +
        '<td class="num-cell">' + useCount + '</td>' +
        '<td class="date-cell">' + lastApplied + '</td>' +
        '<td class="action-cell">' +
          '<button type="button" class="btn-icon btn-edit" data-id="' + escHtml(m.id) + '" aria-label="수정" title="수정">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
          '</button>' +
          '<button type="button" class="btn-icon btn-delete" data-id="' + escHtml(m.id) + '" aria-label="삭제" title="삭제">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>' +
          '</button>' +
        '</td>' +
        '</tr>';
    });
    tbody.innerHTML = rows.join('');
  }

  // ── 페이지네이션 렌더링 ──────────────────────────────────────
  function renderPagination() {
    var el = document.getElementById('pagination');
    if (!el) return;
    var totalPages = Math.max(1, Math.ceil(state.total / state.limit));
    if (totalPages <= 1) { el.innerHTML = ''; return; }

    var html = '';
    if (state.page > 1) {
      html += '<button type="button" class="page-btn" data-page="' + (state.page - 1) + '">이전</button>';
    }
    var start = Math.max(1, state.page - 2);
    var end = Math.min(totalPages, state.page + 2);
    for (var i = start; i <= end; i++) {
      html += '<button type="button" class="page-btn' + (i === state.page ? ' page-btn--active' : '') + '" data-page="' + i + '">' + i + '</button>';
    }
    if (state.page < totalPages) {
      html += '<button type="button" class="page-btn" data-page="' + (state.page + 1) + '">다음</button>';
    }
    el.innerHTML = html;
  }

  function updateTotalCount() {
    setText('totalCount', state.total.toLocaleString() + '개');
  }

  // ── 슬라이드오버 열기/닫기 ────────────────────────────────────
  function openSlideOver(mappingId) {
    state.editingId = mappingId || null;
    var panel = document.getElementById('slideOver');
    var title = document.getElementById('slideOverTitle');
    if (title) title.textContent = mappingId ? '매핑 수정' : '매핑 추가';
    populateSlideOverForm(mappingId);
    if (panel) {
      panel.classList.add('slide-over--open');
      panel.removeAttribute('aria-hidden');
    }
    var overlay = document.getElementById('slideOverlay');
    if (overlay) overlay.hidden = false;
    // 마스터 상품 드롭다운 채우기
    populateProductSelect();
  }

  function closeSlideOver() {
    var panel = document.getElementById('slideOver');
    if (panel) {
      panel.classList.remove('slide-over--open');
      panel.setAttribute('aria-hidden', 'true');
    }
    var overlay = document.getElementById('slideOverlay');
    if (overlay) overlay.hidden = true;
    state.editingId = null;
    resetForm();
  }

  function populateSlideOverForm(mappingId) {
    resetForm();
    if (!mappingId) return;
    var m = state.mappings.find(function (x) { return x.id === mappingId; });
    if (!m) return;
    var f = document.getElementById('mappingForm');
    if (!f) return;
    var mktSel = f.querySelector('[name="market"]');
    var optInput = f.querySelector('[name="market_option_name"]');
    var masterOptInput = f.querySelector('[name="master_option_name"]');
    if (mktSel) mktSel.value = m.market;
    if (optInput) optInput.value = m.market_option_name;
    if (masterOptInput) masterOptInput.value = m.master_option_name || '';
  }

  function populateProductSelect() {
    var sel = document.getElementById('masterProductSelect');
    if (!sel) return;
    var currentVal = sel.value;
    sel.innerHTML = '<option value="">— 마스터 상품 선택 (선택사항) —</option>';
    state.products.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.title || p.id;
      sel.appendChild(opt);
    });
    if (currentVal) sel.value = currentVal;

    // 수정 모드에서 기존 상품 선택
    if (state.editingId) {
      var m = state.mappings.find(function (x) { return x.id === state.editingId; });
      if (m && m.master_product_id) sel.value = m.master_product_id;
    }
  }

  function resetForm() {
    var f = document.getElementById('mappingForm');
    if (f) f.reset();
    var errEl = document.getElementById('formError');
    if (errEl) { errEl.textContent = ''; errEl.hidden = true; }
  }

  // ── 매핑 저장 ─────────────────────────────────────────────────
  async function saveMapping() {
    var f = document.getElementById('mappingForm');
    if (!f) return;
    var errEl = document.getElementById('formError');
    var fd = new FormData(f);
    var market = fd.get('market');
    var market_option_name = (fd.get('market_option_name') || '').trim();
    var master_option_name = (fd.get('master_option_name') || '').trim() || null;
    var master_product_id = document.getElementById('masterProductSelect')?.value || null;

    if (!market) {
      showFormError(errEl, '마켓을 선택해주세요.');
      return;
    }
    if (!market_option_name) {
      showFormError(errEl, '마켓 옵션명을 입력해주세요.');
      return;
    }

    var saveBtn = document.getElementById('saveBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '저장 중…'; }

    var payload = { market, market_option_name, master_option_name, master_product_id: master_product_id || null };
    if (state.editingId) payload.id = state.editingId;

    var res = await apiFetch('/api/save-mapping', { method: 'POST', body: payload });

    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '저장'; }

    if (!res.ok) {
      showFormError(errEl, res.data.error || '저장 중 오류가 발생했어요.');
      return;
    }

    toast(state.editingId ? '매핑이 수정됐어요.' : '매핑이 추가됐어요.', 'success');
    closeSlideOver();
    await loadMappings();
  }

  function showFormError(el, msg) {
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
  }

  // ── 매핑 삭제 ─────────────────────────────────────────────────
  async function deleteMapping(id) {
    if (!confirm('이 매핑을 삭제할까요?')) return;
    var res = await apiFetch('/api/delete-mapping', { method: 'DELETE', body: { id } });
    if (!res.ok) {
      toast(res.data.error || '삭제 중 오류가 발생했어요.', 'error');
      return;
    }
    toast('매핑이 삭제됐어요.', 'success');
    await loadMappings();
  }

  // ── 엑셀 가져오기 ─────────────────────────────────────────────
  function handleExcelImport(file) {
    if (!file) return;
    // SheetJS CDN이 없으면 안내
    if (typeof XLSX === 'undefined') {
      toast('엑셀 파싱 라이브러리가 로드되지 않았어요. 잠시 후 다시 시도해주세요.', 'error');
      return;
    }
    var reader = new FileReader();
    reader.onload = async function (e) {
      try {
        var wb = XLSX.read(e.target.result, { type: 'array' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        // 헤더 행 건너뜀 (첫 번째 행 = 헤더)
        var dataRows = rows.slice(1).filter(function (r) { return r[0] && r[1] && r[2]; });
        if (!dataRows.length) { toast('유효한 데이터 행이 없어요. 헤더: 마켓 | 마켓옵션명 | 마스터옵션명', 'error'); return; }

        var progress = document.getElementById('importProgress');
        if (progress) { progress.textContent = '0 / ' + dataRows.length + ' 처리 중…'; progress.hidden = false; }

        var success = 0, failed = 0;
        for (var i = 0; i < dataRows.length; i++) {
          var row = dataRows[i];
          var market = String(row[0]).trim().toLowerCase();
          var market_option_name = String(row[1]).trim();
          var master_option_name = String(row[2]).trim() || null;
          var master_product_id = row[3] ? String(row[3]).trim() : null;
          if (!['coupang', 'naver', 'toss'].includes(market)) { failed++; continue; }
          var res = await apiFetch('/api/save-mapping', {
            method: 'POST',
            body: { market, market_option_name, master_option_name, master_product_id },
          });
          if (res.ok) success++; else failed++;
          if (progress) progress.textContent = (i + 1) + ' / ' + dataRows.length + ' 처리 중…';
        }

        if (progress) progress.hidden = true;
        toast('가져오기 완료: ' + success + '개 성공' + (failed ? ', ' + failed + '개 실패' : ''), success ? 'success' : 'error');
        await loadMappings();
      } catch (err) {
        toast('엑셀 파싱 오류: ' + err.message, 'error');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // ── 유틸 ──────────────────────────────────────────────────────
  function escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatDate(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      return d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (_) { return iso.slice(0, 10); }
  }

  // ── 다크/라이트 토글 ──────────────────────────────────────────
  function initThemeToggle() {
    var btn = document.getElementById('themeToggleBtn');
    if (!btn) return;
    var stored = localStorage.getItem('lumi_dark_mode');
    if (stored === '1') {
      document.body.classList.add('dark-mode');
      btn.textContent = '☀';
    } else {
      btn.textContent = '☾';
    }
    btn.addEventListener('click', function () {
      var isDark = document.body.classList.toggle('dark-mode');
      localStorage.setItem('lumi_dark_mode', isDark ? '1' : '0');
      btn.textContent = isDark ? '☀' : '☾';
    });
  }

  // ── 이벤트 바인딩 ─────────────────────────────────────────────
  function bindEvents() {
    // 마켓 필터 탭
    qsa('.filter-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        qsa('.filter-tab').forEach(function (t) { t.classList.remove('filter-tab--active'); });
        tab.classList.add('filter-tab--active');
        state.market = tab.dataset.market || 'all';
        state.page = 1;
        loadMappings();
      });
    });

    // 매핑 추가 버튼
    var addBtn = document.getElementById('addMappingBtn');
    if (addBtn) addBtn.addEventListener('click', function () { openSlideOver(null); });

    // 슬라이드오버 닫기
    var closeBtn = document.getElementById('slideOverClose');
    if (closeBtn) closeBtn.addEventListener('click', closeSlideOver);
    var overlay = document.getElementById('slideOverlay');
    if (overlay) overlay.addEventListener('click', closeSlideOver);

    // 저장 버튼
    var saveBtn = document.getElementById('saveBtn');
    if (saveBtn) saveBtn.addEventListener('click', saveMapping);

    // 폼 엔터키 제출
    var form = document.getElementById('mappingForm');
    if (form) form.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); saveMapping(); }
    });

    // 테이블 이벤트 위임 (수정/삭제)
    var tbody = document.getElementById('mappingTbody');
    if (tbody) {
      tbody.addEventListener('click', function (e) {
        var editBtn = e.target.closest('.btn-edit');
        var delBtn = e.target.closest('.btn-delete');
        if (editBtn) openSlideOver(editBtn.dataset.id);
        if (delBtn) deleteMapping(delBtn.dataset.id);
      });
    }

    // 페이지네이션 이벤트 위임
    var pagination = document.getElementById('pagination');
    if (pagination) {
      pagination.addEventListener('click', function (e) {
        var btn = e.target.closest('.page-btn');
        if (btn && btn.dataset.page) {
          state.page = parseInt(btn.dataset.page, 10);
          loadMappings();
        }
      });
    }

    // 엑셀 업로드
    var xlsxInput = document.getElementById('xlsxInput');
    if (xlsxInput) {
      xlsxInput.addEventListener('change', function (e) {
        var file = e.target.files && e.target.files[0];
        if (file) { handleExcelImport(file); xlsxInput.value = ''; }
      });
    }
    var xlsxBtn = document.getElementById('xlsxBtn');
    if (xlsxBtn) xlsxBtn.addEventListener('click', function () {
      var inp = document.getElementById('xlsxInput');
      if (inp) inp.click();
    });

    // ESC로 슬라이드오버 닫기
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeSlideOver();
    });
  }

  // ── 초기화 ────────────────────────────────────────────────────
  async function init() {
    // 인증 가드
    if (window.lumiAuthGuard) {
      var ok = await window.lumiAuthGuard.ensureOnboarded();
      if (!ok) return;
    }

    initThemeToggle();
    bindEvents();

    // 병렬 로드
    await Promise.all([loadProducts(), loadMappings()]);
  }

  // DOM 준비 후 실행
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
