// Sprint 5 — 상품 마스터 대량 수정 (bulk-products.html)
// 엑셀 다운로드 → 편집 → 업로드 → 미리보기 → 확정 패턴
(function () {
  'use strict';

  // ── 토큰 & 인증 ────────────────────────────────────────────────
  function getToken() { return (localStorage.getItem('lumi_seller_jwt') || '').trim(); }
  function authHeaders() { return { Authorization: 'Bearer ' + getToken() }; }
  function authFetch(url, opts) {
    return fetch(url, { ...opts, headers: { ...(opts?.headers || {}), ...authHeaders() } });
  }

  // ── 인증 가드 ────────────────────────────────────────────────
  function authGuard() {
    if (!getToken()) {
      window.location.href = '/signup.html?redirect=' + encodeURIComponent(window.location.pathname);
    }
  }

  // ── 유틸 ────────────────────────────────────────────────────
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function fmtPrice(n) {
    const v = Number(n);
    return Number.isFinite(v) ? v.toLocaleString() + '원' : '-';
  }
  function statusLabel(s) {
    return { draft: '초안', approved: '검수완료', registering: '등록중', live: '판매중', failed: '실패' }[s] || s || '-';
  }
  function showToast(msg, type = 'info') {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast toast--' + type + ' toast--show';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = 'toast'; }, 3500);
  }
  function setLoading(id, on) {
    const el = document.getElementById(id);
    if (el) el.disabled = on;
  }

  // ── 상태 ────────────────────────────────────────────────────
  let allProducts = [];
  let filteredProducts = [];
  let selectedIds = new Set();
  let previewData = null;
  let currentPage = 1;
  const PAGE_SIZE = 50;

  // ── 필터 상태 ────────────────────────────────────────────────
  const filter = { status: '', search: '' };

  // ── 상품 목록 로드 ────────────────────────────────────────────
  async function loadProducts() {
    const tableBody = document.getElementById('productTableBody');
    const mobileList = document.getElementById('productMobileList');
    if (tableBody) tableBody.innerHTML = '<tr><td colspan="15" class="bp-loading">불러오는 중…</td></tr>';
    if (mobileList) mobileList.innerHTML = '<div class="bp-loading">불러오는 중…</div>';

    try {
      const qs = new URLSearchParams({ limit: '1000' });
      if (filter.status) qs.set('status', filter.status);
      const res = await authFetch('/api/get-product?' + qs.toString());
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '상품 목록을 불러오지 못했어요.');
      allProducts = data.products || (data.product ? [data.product] : []);
    } catch (e) {
      showToast(e.message, 'error');
      if (tableBody) tableBody.innerHTML = '<tr><td colspan="15" class="bp-empty">상품을 불러오지 못했어요.</td></tr>';
      if (mobileList) mobileList.innerHTML = '<div class="bp-empty">상품을 불러오지 못했어요.</div>';
      return;
    }

    applyFilter();
  }

  function applyFilter() {
    const q = filter.search.toLowerCase();
    filteredProducts = allProducts.filter((p) => {
      if (filter.status && p.status !== filter.status) return false;
      if (q && !p.title.toLowerCase().includes(q) &&
          !(p.market_overrides?.brand || '').toLowerCase().includes(q) &&
          !(p.id || '').toLowerCase().includes(q)) return false;
      return true;
    });
    currentPage = 1;
    selectedIds = new Set();
    renderTable();
    renderMobile();
    updateSelectionBar();
  }

  // ── 테이블 렌더 (PC) ─────────────────────────────────────────
  function renderTable() {
    const tbody = document.getElementById('productTableBody');
    const countEl = document.getElementById('productCount');
    if (!tbody) return;

    const total = filteredProducts.length;
    if (countEl) countEl.textContent = `총 ${total.toLocaleString()}개`;

    const start = (currentPage - 1) * PAGE_SIZE;
    const page = filteredProducts.slice(start, start + PAGE_SIZE);

    if (page.length === 0) {
      tbody.innerHTML = '<tr><td colspan="15" class="bp-empty">조건에 맞는 상품이 없어요.</td></tr>';
      renderPager(total);
      return;
    }

    tbody.innerHTML = page.map((p) => {
      const ov = p.market_overrides || {};
      const code = p.id ? p.id.split('-')[0].toUpperCase() : '';
      const chk = selectedIds.has(p.id) ? 'checked' : '';
      return `<tr data-id="${esc(p.id)}" class="${selectedIds.has(p.id) ? 'bp-row--selected' : ''}">
        <td class="bp-col-check"><input type="checkbox" class="bp-row-check" data-id="${esc(p.id)}" ${chk} /></td>
        <td class="bp-col-code">${esc(code)}</td>
        <td class="bp-col-scode">${esc(ov.seller_code || '')}</td>
        <td class="bp-col-title"><span class="bp-title-text">${esc(p.title)}</span></td>
        <td class="bp-col">${esc(ov.model_name || '')}</td>
        <td class="bp-col">${esc(ov.brand || '')}</td>
        <td class="bp-col">${esc(ov.manufacturer || '')}</td>
        <td class="bp-col">${esc(ov.origin || '')}</td>
        <td class="bp-col">${esc(ov.season || '')}</td>
        <td class="bp-col"><span class="bp-status bp-status--${esc(p.status)}">${statusLabel(p.status)}</span></td>
        <td class="bp-col">${esc(ov.shipping_type || '')}</td>
        <td class="bp-col-price">${fmtPrice(ov.shipping_fee)}</td>
        <td class="bp-col-price">${fmtPrice(ov.price_cost)}</td>
        <td class="bp-col-price"><strong>${fmtPrice(p.price_suggested)}</strong></td>
        <td class="bp-col-price">${fmtPrice(ov.price_tag)}</td>
      </tr>`;
    }).join('');

    // 행 체크박스 이벤트
    tbody.querySelectorAll('.bp-row-check').forEach((chk) => {
      chk.addEventListener('change', () => {
        if (chk.checked) selectedIds.add(chk.dataset.id);
        else selectedIds.delete(chk.dataset.id);
        const row = chk.closest('tr');
        if (row) row.classList.toggle('bp-row--selected', chk.checked);
        updateSelectionBar();
        updateHeaderCheck();
      });
    });

    renderPager(total);
    updateHeaderCheck();
  }

  // ── 페이저 ────────────────────────────────────────────────────
  function renderPager(total) {
    const pager = document.getElementById('pager');
    if (!pager) return;
    const pages = Math.ceil(total / PAGE_SIZE);
    if (pages <= 1) { pager.innerHTML = ''; return; }

    let html = '';
    if (currentPage > 1) html += `<button class="bp-page-btn" data-page="${currentPage - 1}">이전</button>`;
    const start = Math.max(1, currentPage - 2);
    const end = Math.min(pages, currentPage + 2);
    for (let i = start; i <= end; i++) {
      html += `<button class="bp-page-btn ${i === currentPage ? 'bp-page-btn--active' : ''}" data-page="${i}">${i}</button>`;
    }
    if (currentPage < pages) html += `<button class="bp-page-btn" data-page="${currentPage + 1}">다음</button>`;
    pager.innerHTML = html;

    pager.querySelectorAll('.bp-page-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentPage = parseInt(btn.dataset.page, 10);
        renderTable();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
  }

  // ── 모바일 카드 렌더 ─────────────────────────────────────────
  function renderMobile() {
    const list = document.getElementById('productMobileList');
    if (!list) return;
    if (filteredProducts.length === 0) {
      list.innerHTML = '<div class="bp-empty">조건에 맞는 상품이 없어요.</div>';
      return;
    }
    const page = filteredProducts.slice(0, PAGE_SIZE);
    list.innerHTML = page.map((p) => {
      const ov = p.market_overrides || {};
      const code = p.id ? p.id.split('-')[0].toUpperCase() : '';
      return `<article class="bp-card" data-id="${esc(p.id)}">
        <div class="bp-card__head">
          <span class="bp-card__code">${esc(code)}</span>
          <span class="bp-status bp-status--${esc(p.status)}">${statusLabel(p.status)}</span>
        </div>
        <h3 class="bp-card__title">${esc(p.title)}</h3>
        ${ov.brand ? `<p class="bp-card__meta">${esc(ov.brand)}${ov.model_name ? ' · ' + esc(ov.model_name) : ''}</p>` : ''}
        <div class="bp-card__prices">
          <span class="bp-card__price-label">판매가</span>
          <span class="bp-card__price">${fmtPrice(p.price_suggested)}</span>
          ${ov.price_cost ? `<span class="bp-card__price-label">원가</span><span class="bp-card__price">${fmtPrice(ov.price_cost)}</span>` : ''}
        </div>
        ${ov.origin || ov.season ? `<p class="bp-card__meta">${[ov.origin, ov.season].filter(Boolean).map(esc).join(' · ')}</p>` : ''}
      </article>`;
    }).join('');
  }

  // ── 헤더 전체선택 체크박스 ──────────────────────────────────
  function updateHeaderCheck() {
    const hChk = document.getElementById('headerCheck');
    if (!hChk) return;
    const total = filteredProducts.length;
    const sel = filteredProducts.filter((p) => selectedIds.has(p.id)).length;
    hChk.checked = total > 0 && sel === total;
    hChk.indeterminate = sel > 0 && sel < total;
  }

  // ── 선택 바 업데이트 ────────────────────────────────────────
  function updateSelectionBar() {
    const bar = document.getElementById('selectionBar');
    const countEl = document.getElementById('selectedCount');
    if (!bar) return;
    const count = selectedIds.size;
    bar.hidden = count === 0;
    if (countEl) countEl.textContent = count.toLocaleString();
  }

  // ── 엑셀 다운로드 ────────────────────────────────────────────
  async function downloadExcel() {
    setLoading('btnExcelDown', true);
    showToast('엑셀 파일을 생성하는 중이에요…', 'info');
    try {
      const qs = new URLSearchParams({ limit: '5000' });
      if (filter.status) qs.set('status', filter.status);
      const res = await authFetch('/api/bulk-products-export?' + qs.toString());
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || '다운로드에 실패했어요.');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      a.href = url;
      a.download = `lumi_products_${today}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast('엑셀 파일이 다운로드되었어요.', 'success');
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setLoading('btnExcelDown', false);
    }
  }

  // ── 엑셀 업로드 (미리보기) ───────────────────────────────────
  async function uploadExcelForPreview(file) {
    if (!file) return;
    showToast('파일을 분석하는 중이에요…', 'info');
    setLoading('btnExcelUp', true);

    const fd = new FormData();
    fd.append('file', file);

    try {
      const res = await fetch('/api/bulk-products-preview', {
        method: 'POST',
        headers: authHeaders(),
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '미리보기에 실패했어요.');
      previewData = data;
      openPreviewModal(data, file.name);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setLoading('btnExcelUp', false);
      // 파일 input 초기화
      const fi = document.getElementById('fileInput');
      if (fi) fi.value = '';
    }
  }

  // ── 미리보기 모달 ────────────────────────────────────────────
  function openPreviewModal(data, filename) {
    const modal = document.getElementById('previewModal');
    const summary = document.getElementById('previewSummary');
    const tableBody = document.getElementById('previewTableBody');
    if (!modal) return;

    // 요약
    if (summary) {
      summary.innerHTML = `
        <span class="bp-badge bp-badge--info">전체 ${data.total}행</span>
        <span class="bp-badge bp-badge--success">매칭 ${data.matched}개</span>
        <span class="bp-badge bp-badge--warn">변경 ${data.with_changes}개</span>
        ${data.with_errors > 0 ? `<span class="bp-badge bp-badge--error">오류 ${data.with_errors}행</span>` : ''}
      `;
    }

    // 테이블
    if (tableBody) {
      tableBody.innerHTML = (data.rows || []).map((row) => {
        const hasErr = row.errors && row.errors.length > 0;
        const hasChanges = row.changes && row.changes.length > 0;
        return `<tr class="${hasErr ? 'bp-preview-row--error' : hasChanges ? 'bp-preview-row--changed' : ''}">
          <td>${row.excel_row}</td>
          <td>${esc(row.product_code)}</td>
          <td class="bp-preview-title">${esc(row.title)}</td>
          <td>
            ${hasErr
              ? `<ul class="bp-err-list">${row.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`
              : hasChanges
                ? `<ul class="bp-change-list">${row.changes.map((c) => `<li><strong>${esc(c.field)}</strong>: ${esc(String(c.old))} → <em>${esc(String(c.new))}</em></li>`).join('')}</ul>`
                : '<span class="bp-no-change">변경 없음</span>'
            }
          </td>
          <td>${row.matched ? '<span class="bp-match">매칭</span>' : '<span class="bp-no-match">미매칭</span>'}</td>
        </tr>`;
      }).join('');
    }

    // 파일명 저장
    modal.dataset.filename = filename;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closePreviewModal() {
    const modal = document.getElementById('previewModal');
    if (modal) modal.hidden = true;
    document.body.style.overflow = '';
  }

  // ── 일괄 적용 확정 ────────────────────────────────────────────
  async function confirmImport() {
    if (!previewData) return;
    const modal = document.getElementById('previewModal');
    const filename = modal?.dataset.filename || '';

    const validRows = (previewData.rows || []).filter((r) => r.matched && r.changes.length > 0 && (!r.errors || r.errors.length === 0));
    if (validRows.length === 0) {
      showToast('적용할 변경 사항이 없어요.', 'warn');
      return;
    }

    setLoading('btnConfirmImport', true);
    showToast(`${validRows.length}개 상품을 저장하는 중이에요…`, 'info');

    // import payload 구성
    const rows = validRows.map((r) => {
      // previewData의 row에서 변경 필드 재조합
      const row = { product_id: r.product_id };
      const ov = {};
      for (const c of r.changes) {
        switch (c.field) {
          case '상품명':     row.title = c.new; break;
          case '판매가':     row.price_suggested = Number(c.new); break;
          case '상품상태':   row.status = c.new; break;
          case '자체상품코드': ov.seller_code = c.new; break;
          case '모델명':     ov.model_name = c.new; break;
          case '브랜드':     ov.brand = c.new; break;
          case '제조사':     ov.manufacturer = c.new; break;
          case '원산지':     ov.origin = c.new; break;
          case '시즌':       ov.season = c.new; break;
          case '배송비구분': ov.shipping_type = c.new; break;
          case '배송비':     ov.shipping_fee = Number(c.new); break;
          case '원가':       ov.price_cost = Number(c.new); break;
          case 'TAG가':      ov.price_tag = Number(c.new); break;
        }
      }
      if (Object.keys(ov).length > 0) row.market_overrides = ov;
      return row;
    });

    try {
      const res = await authFetch('/api/bulk-products-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows, excel_filename: filename }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '저장에 실패했어요.');

      closePreviewModal();
      showToast(`${data.applied}개 상품이 저장되었어요.${data.failed > 0 ? ` (${data.failed}개 실패)` : ''}`, data.failed > 0 ? 'warn' : 'success');
      previewData = null;
      await loadProducts();
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setLoading('btnConfirmImport', false);
    }
  }

  // ── 일괄 필드 변경 (선택된 행에 같은 값 적용) ─────────────────
  async function bulkApplyField(field, value) {
    if (selectedIds.size === 0) {
      showToast('먼저 상품을 선택해주세요.', 'warn');
      return;
    }

    const DIRECT = new Set(['title', 'price_suggested', 'status']);
    const OV = new Set(['seller_code', 'model_name', 'brand', 'manufacturer', 'origin', 'season', 'shipping_type', 'shipping_fee', 'price_cost', 'price_tag']);

    const rows = [...selectedIds].map((id) => {
      if (DIRECT.has(field)) {
        return { product_id: id, [field]: value };
      } else if (OV.has(field)) {
        return { product_id: id, market_overrides: { [field]: value } };
      }
      return null;
    }).filter(Boolean);

    if (rows.length === 0) return;

    try {
      const res = await authFetch('/api/bulk-products-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '저장에 실패했어요.');
      showToast(`${data.applied}개 상품이 저장되었어요.`, 'success');
      closeBulkEditModal();
      await loadProducts();
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  // ── 일괄 편집 모달 ────────────────────────────────────────────
  function openBulkEditModal() {
    if (selectedIds.size === 0) { showToast('먼저 상품을 선택해주세요.', 'warn'); return; }
    const modal = document.getElementById('bulkEditModal');
    const countEl = document.getElementById('bulkEditCount');
    if (!modal) return;
    if (countEl) countEl.textContent = selectedIds.size;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeBulkEditModal() {
    const modal = document.getElementById('bulkEditModal');
    if (modal) modal.hidden = true;
    document.body.style.overflow = '';
  }

  // ── 이벤트 바인딩 ────────────────────────────────────────────
  function bindEvents() {
    // 전체 선택
    const hChk = document.getElementById('headerCheck');
    if (hChk) {
      hChk.addEventListener('change', () => {
        if (hChk.checked) filteredProducts.forEach((p) => selectedIds.add(p.id));
        else selectedIds.clear();
        renderTable();
        updateSelectionBar();
      });
    }

    // 필터
    const filterStatus = document.getElementById('filterStatus');
    if (filterStatus) {
      filterStatus.addEventListener('change', () => {
        filter.status = filterStatus.value;
        applyFilter();
      });
    }

    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
      let debounceT;
      searchInput.addEventListener('input', () => {
        clearTimeout(debounceT);
        debounceT = setTimeout(() => {
          filter.search = searchInput.value.trim();
          applyFilter();
        }, 250);
      });
    }

    // 엑셀 다운
    const btnDown = document.getElementById('btnExcelDown');
    if (btnDown) btnDown.addEventListener('click', downloadExcel);

    // 엑셀 업로드 버튼 → 파일 input 클릭
    const btnUp = document.getElementById('btnExcelUp');
    const fileInput = document.getElementById('fileInput');
    if (btnUp && fileInput) {
      btnUp.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        if (fileInput.files && fileInput.files[0]) {
          uploadExcelForPreview(fileInput.files[0]);
        }
      });
    }

    // 드래그 앤 드롭
    const dropZone = document.getElementById('dropZone');
    if (dropZone) {
      dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('bp-drop--active'); });
      dropZone.addEventListener('dragleave', () => dropZone.classList.remove('bp-drop--active'));
      dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('bp-drop--active');
        const f = e.dataTransfer?.files?.[0];
        if (f) uploadExcelForPreview(f);
      });
    }

    // 미리보기 모달 닫기 / 확정
    const btnClose = document.getElementById('btnClosePreview');
    if (btnClose) btnClose.addEventListener('click', closePreviewModal);
    const btnConfirm = document.getElementById('btnConfirmImport');
    if (btnConfirm) btnConfirm.addEventListener('click', confirmImport);

    // 모달 backdrop 클릭 닫기
    const previewModal = document.getElementById('previewModal');
    if (previewModal) {
      previewModal.addEventListener('click', (e) => {
        if (e.target === previewModal) closePreviewModal();
      });
    }

    // 일괄 편집
    const btnBulkEdit = document.getElementById('btnBulkEdit');
    if (btnBulkEdit) btnBulkEdit.addEventListener('click', openBulkEditModal);
    const btnCloseBulk = document.getElementById('btnCloseBulkEdit');
    if (btnCloseBulk) btnCloseBulk.addEventListener('click', closeBulkEditModal);
    const bulkEditModal = document.getElementById('bulkEditModal');
    if (bulkEditModal) {
      bulkEditModal.addEventListener('click', (e) => {
        if (e.target === bulkEditModal) closeBulkEditModal();
      });
    }

    const btnApplyBulk = document.getElementById('btnApplyBulk');
    if (btnApplyBulk) {
      btnApplyBulk.addEventListener('click', () => {
        const fieldSel = document.getElementById('bulkEditField');
        const valInput = document.getElementById('bulkEditValue');
        if (!fieldSel || !valInput) return;
        const field = fieldSel.value;
        const value = valInput.value.trim();
        if (!field || !value) { showToast('필드와 값을 모두 입력해주세요.', 'warn'); return; }
        bulkApplyField(field, value);
      });
    }

    // 다크 모드 토글
    const themeBtn = document.getElementById('themeBtn');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        const isDark = document.body.classList.toggle('dark-mode');
        localStorage.setItem('lumi_dark_mode', isDark ? '1' : '0');
        themeBtn.textContent = isDark ? '☀' : '☾';
      });
    }

    // ESC 키로 모달 닫기
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closePreviewModal(); closeBulkEditModal(); }
    });
  }

  // ── 진행률 표시 (1000건 대용량) ──────────────────────────────
  function showProgress(current, total) {
    const bar = document.getElementById('progressBar');
    const text = document.getElementById('progressText');
    const wrap = document.getElementById('progressWrap');
    if (!wrap) return;
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    if (wrap) wrap.hidden = false;
    if (bar) bar.style.width = pct + '%';
    if (text) text.textContent = `${current} / ${total}`;
  }

  function hideProgress() {
    const wrap = document.getElementById('progressWrap');
    if (wrap) wrap.hidden = true;
  }

  // ── 초기화 ────────────────────────────────────────────────────
  function init() {
    authGuard();

    // 다크 모드 복원
    const isDark = localStorage.getItem('lumi_dark_mode') === '1';
    if (isDark) document.body.classList.add('dark-mode');
    const themeBtn = document.getElementById('themeBtn');
    if (themeBtn) themeBtn.textContent = isDark ? '☀' : '☾';

    bindEvents();
    loadProducts();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
