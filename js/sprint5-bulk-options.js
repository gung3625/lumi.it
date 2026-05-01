/**
 * sprint5-bulk-options.js — 옵션 대량 편집 페이지 로직
 * Sprint 5 / bulk-options.html
 */

/* ── 상태 ─────────────────────────────────────────────────────────────── */
const State = {
  options: [],          // 로드된 옵션 행 배열
  dirty: new Map(),     // option_id → { field → newVal }
  selected: new Set(),  // 선택된 option_id
  page: 1,
  perPage: 100,
  total: 0,
  filters: {
    product_id: '',
    market: '',
    zero_stock: false,
    min_price: '',
    max_price: '',
  },
  previewChanges: [],   // bulk-options-preview 응답
  previewErrors: [],
  loading: false,
};

/* ── 토큰 헬퍼 ───────────────────────────────────────────────────────── */
function getToken() {
  return (localStorage.getItem('lumi_seller_jwt') || localStorage.getItem('lumi_seller_token') || '').trim();
}

function authHeaders() {
  return { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'application/json' };
}

/* ── UI 참조 ─────────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

/* ── 인증 가드 ───────────────────────────────────────────────────────── */
function authGuard() {
  const token = getToken();
  if (!token) {
    window.location.href = '/?redirect=' + encodeURIComponent(window.location.pathname);
    return false;
  }
  return true;
}

/* ── 토스트 ──────────────────────────────────────────────────────────── */
function toast(msg, type = 'info') {
  const container = $('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast toast--' + type;
  el.textContent = msg;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast--visible'));
  setTimeout(() => {
    el.classList.remove('toast--visible');
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

/* ── 로딩 상태 ───────────────────────────────────────────────────────── */
function setLoading(on) {
  State.loading = on;
  const btn = $('btnLoad');
  if (btn) btn.disabled = on;
  const overlay = $('loadingOverlay');
  if (overlay) overlay.hidden = !on;
}

/* ── 필터에서 쿼리스트링 생성 ────────────────────────────────────────── */
function buildFilterQuery() {
  const f = State.filters;
  const params = new URLSearchParams();
  if (f.product_id) params.set('product_id', f.product_id);
  if (f.market)     params.set('market', f.market);
  if (f.zero_stock) params.set('zero_stock', '1');
  if (f.min_price)  params.set('min_price', f.min_price);
  if (f.max_price)  params.set('max_price', f.max_price);
  return params.toString();
}

/* ── 옵션 목록 로드 (API 직접 → 엑셀 기반 fetch) ──────────────────── */
async function loadOptions() {
  if (!authGuard()) return;
  setLoading(true);
  try {
    const qs = buildFilterQuery();
    const url = '/api/bulk-options-list' + (qs ? '?' + qs : '');
    const res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + getToken() },
    });
    if (res.status === 401) { window.location.href = '/?redirect=' + encodeURIComponent(window.location.pathname); return; }
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      toast(d.error || '옵션을 불러오지 못했어요.', 'error');
      return;
    }
    const data = await res.json();
    State.options = data.options || [];
    State.total   = data.total   || State.options.length;
    State.dirty.clear();
    State.selected.clear();
    renderTable();
    updateSelectionUI();
    $('resultCount').textContent = `총 ${State.total.toLocaleString()}개 옵션`;
  } catch (e) {
    toast('네트워크 오류: ' + e.message, 'error');
  } finally {
    setLoading(false);
  }
}

/* ── 테이블 렌더 ─────────────────────────────────────────────────────── */
function renderTable() {
  const tbody = $('optionsTbody');
  if (!tbody) return;

  if (State.options.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="table-empty">조건에 맞는 옵션이 없어요.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  for (const opt of State.options) {
    const tr = document.createElement('tr');
    tr.dataset.optionId = opt.id;
    if (State.selected.has(opt.id)) tr.classList.add('row--selected');

    const isDirtyRow = State.dirty.has(opt.id);
    if (isDirtyRow) tr.classList.add('row--dirty');

    const dirty = State.dirty.get(opt.id) || {};
    const price     = dirty.price       !== undefined ? dirty.price       : (opt.price       ?? opt.product_price ?? 0);
    const stock     = dirty.stock       !== undefined ? dirty.stock       : (opt.stock       ?? 0);
    const extraP    = dirty.extra_price !== undefined ? dirty.extra_price : (opt.extra_price ?? 0);
    const sku       = dirty.sku         !== undefined ? dirty.sku         : (opt.sku         || '');

    tr.innerHTML = `
      <td class="col-check">
        <input type="checkbox" class="row-check" data-id="${opt.id}" ${State.selected.has(opt.id) ? 'checked' : ''} aria-label="선택">
      </td>
      <td class="col-product" title="${esc(opt.product_title)}">${esc(truncate(opt.product_title, 20))}</td>
      <td class="col-option">${esc(opt.option_name)}</td>
      <td class="col-sku">
        <input type="text" class="cell-input" data-field="sku" data-id="${opt.id}"
          value="${esc(sku)}" placeholder="SKU" maxlength="80"
          ${dirty.sku !== undefined ? 'data-changed="1"' : ''}>
      </td>
      <td class="col-price">
        <input type="number" class="cell-input" data-field="price" data-id="${opt.id}"
          value="${price}" min="0" max="10000000" step="1"
          ${dirty.price !== undefined ? 'data-changed="1"' : ''}>
      </td>
      <td class="col-stock">
        <input type="number" class="cell-input" data-field="stock" data-id="${opt.id}"
          value="${stock}" min="0" step="1"
          ${dirty.stock !== undefined ? 'data-changed="1"' : ''}>
      </td>
      <td class="col-extra">
        <input type="number" class="cell-input" data-field="extra_price" data-id="${opt.id}"
          value="${extraP}" min="0" step="1"
          ${dirty.extra_price !== undefined ? 'data-changed="1"' : ''}>
      </td>
      <td class="col-market">${renderMarketBadges(opt.market_mapping)}</td>
      <td class="col-status">${isDirtyRow ? '<span class="badge badge--changed">변경됨</span>' : ''}</td>
    `;
    tbody.appendChild(tr);
  }

  // 이벤트 위임은 tbody에서 처리 (이미 등록됨)
}

function renderMarketBadges(mapping) {
  if (!mapping || typeof mapping !== 'object') return '<span class="text-soft">-</span>';
  const markets = Object.keys(mapping);
  if (markets.length === 0) return '<span class="text-soft">-</span>';
  return markets.map((m) => `<span class="badge badge--market">${esc(m)}</span>`).join(' ');
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── 인라인 편집 핸들러 ──────────────────────────────────────────────── */
function handleCellChange(e) {
  const input = e.target;
  if (!input.classList.contains('cell-input')) return;
  const id    = input.dataset.id;
  const field = input.dataset.field;
  if (!id || !field) return;

  const rawVal = input.value.trim();
  const opt = State.options.find((o) => o.id === id);
  if (!opt) return;

  // 원래 값
  const origVal = field === 'sku'
    ? (opt.sku || '')
    : (field === 'price' ? (opt.price ?? opt.product_price ?? 0)
      : field === 'stock' ? (opt.stock ?? 0)
      : (opt.extra_price ?? 0));

  const newVal = field === 'sku' ? rawVal : (rawVal === '' ? origVal : Number(rawVal));

  if (String(newVal) === String(origVal)) {
    // 원래 값으로 되돌린 경우 dirty 해제
    const d = State.dirty.get(id);
    if (d) {
      delete d[field];
      if (Object.keys(d).length === 0) State.dirty.delete(id);
    }
    input.removeAttribute('data-changed');
  } else {
    if (!State.dirty.has(id)) State.dirty.set(id, {});
    State.dirty.get(id)[field] = newVal;
    input.setAttribute('data-changed', '1');
  }

  // 행 dirty 표시
  const tr = input.closest('tr');
  if (tr) {
    if (State.dirty.has(id)) tr.classList.add('row--dirty');
    else tr.classList.remove('row--dirty');
  }
  updateSaveButton();
}

function updateSaveButton() {
  const btn = $('btnSave');
  if (!btn) return;
  const count = State.dirty.size;
  btn.disabled = count === 0;
  btn.textContent = count > 0 ? `변경 저장 (${count}개)` : '변경 없음';
}

/* ── 행 선택 ─────────────────────────────────────────────────────────── */
function handleRowCheck(e) {
  const cb = e.target;
  if (!cb.classList.contains('row-check')) return;
  const id = cb.dataset.id;
  if (!id) return;
  if (cb.checked) State.selected.add(id);
  else State.selected.delete(id);
  const tr = cb.closest('tr');
  if (tr) tr.classList.toggle('row--selected', cb.checked);
  updateSelectionUI();
}

function handleSelectAll(e) {
  const checked = e.target.checked;
  for (const opt of State.options) {
    if (checked) State.selected.add(opt.id);
    else State.selected.delete(opt.id);
  }
  $$('.row-check').forEach((cb) => { cb.checked = checked; });
  $$('.row--selected').forEach((tr) => tr.classList.toggle('row--selected', checked));
  renderTable(); // re-render to sync
  updateSelectionUI();
}

function updateSelectionUI() {
  const n = State.selected.size;
  const bar = $('batchBar');
  if (bar) bar.hidden = n === 0;
  const label = $('selectedCount');
  if (label) label.textContent = `${n}개 선택됨`;
}

/* ── 일괄 적용 (선택된 행에 같은 값) ────────────────────────────────── */
function applyBatchValue() {
  const field = $('batchField')?.value;
  const val   = $('batchValue')?.value?.trim();
  if (!field || val === '' || val === undefined) { toast('필드와 값을 입력해주세요.', 'error'); return; }
  if (State.selected.size === 0) { toast('행을 먼저 선택해주세요.', 'error'); return; }

  const numericFields = ['price', 'stock', 'extra_price'];
  let parsedVal;
  if (numericFields.includes(field)) {
    parsedVal = Number(val);
    if (!Number.isInteger(parsedVal) || parsedVal < 0) { toast('0 이상 정수를 입력해주세요.', 'error'); return; }
  } else {
    parsedVal = val;
  }

  for (const id of State.selected) {
    if (!State.dirty.has(id)) State.dirty.set(id, {});
    State.dirty.get(id)[field] = parsedVal;
  }

  renderTable();
  updateSaveButton();
  toast(`${State.selected.size}개 행에 적용됐어요.`, 'success');
}

/* ── 인라인 저장 (dirty → /api/bulk-options-import 직접 호출) ────────── */
async function saveInlineChanges() {
  if (State.dirty.size === 0) return;
  if (!confirm(`${State.dirty.size}개 옵션의 변경사항을 저장할까요?`)) return;

  const changes = [];
  for (const [optId, fields] of State.dirty.entries()) {
    for (const [field, newVal] of Object.entries(fields)) {
      const opt = State.options.find((o) => o.id === optId);
      changes.push({
        option_id:   optId,
        product_id:  opt?.product_id || null,
        option_name: opt?.option_name || null,
        field,
        old: null, // inline 저장 시 old 생략
        new: newVal,
      });
    }
  }

  setLoading(true);
  try {
    const res = await fetch('/api/bulk-options-import', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ changes, filename: '' }),
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error || '저장 실패', 'error'); return; }
    toast(`${data.applied}개 저장 완료${data.failed > 0 ? ` (${data.failed}개 실패)` : ''}`, data.failed > 0 ? 'warn' : 'success');
    if (data.errors?.length) {
      console.warn('[bulk-options] save errors:', data.errors);
    }
    State.dirty.clear();
    await loadOptions();
  } catch (e) {
    toast('네트워크 오류: ' + e.message, 'error');
  } finally {
    setLoading(false);
  }
}

/* ── 엑셀 다운로드 ───────────────────────────────────────────────────── */
async function downloadExcel() {
  if (!authGuard()) return;
  const qs = buildFilterQuery();
  const url = '/api/bulk-options-export' + (qs ? '?' + qs : '');

  try {
    const res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + getToken() },
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      toast(d.error || '다운로드 실패', 'error');
      return;
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    const objUrl = URL.createObjectURL(blob);
    a.href = objUrl;
    a.download = `lumi_options_${new Date().toISOString().slice(0,10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objUrl);
    toast('엑셀 파일을 다운로드했어요.', 'success');
  } catch (e) {
    toast('다운로드 오류: ' + e.message, 'error');
  }
}

/* ── 엑셀 업로드 → 미리보기 ─────────────────────────────────────────── */
async function handleExcelUpload(file) {
  if (!file) return;
  if (!file.name.match(/\.xlsx?$/i)) { toast('xlsx 파일만 업로드할 수 있어요.', 'error'); return; }

  setLoading(true);
  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/bulk-options-preview', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + getToken() },
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error || '미리보기 실패', 'error'); return; }

    State.previewChanges = data.changes || [];
    State.previewErrors  = data.errors  || [];
    showPreviewModal(data);
  } catch (e) {
    toast('업로드 오류: ' + e.message, 'error');
  } finally {
    setLoading(false);
  }
}

/* ── 미리보기 모달 ───────────────────────────────────────────────────── */
function showPreviewModal(data) {
  const modal = $('previewModal');
  if (!modal) return;

  const changes = data.changes || [];
  const errors  = data.errors  || [];
  const summary = data.summary || {};

  $('previewSummary').innerHTML = `
    <span class="badge badge--info">${summary.total_rows || 0}행</span>
    <span class="badge badge--success">${changes.length}건 변경</span>
    ${errors.length ? `<span class="badge badge--error">${errors.length}건 오류</span>` : ''}
  `;

  // 변경 내역 테이블
  const tbody = $('previewTbody');
  if (changes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty">변경 내역이 없어요.</td></tr>';
  } else {
    tbody.innerHTML = changes.slice(0, 500).map((c) => `
      <tr>
        <td>${esc(truncate(c.product_title, 16))}</td>
        <td>${esc(c.option_name)}</td>
        <td>${esc(fieldLabel(c.field))}</td>
        <td class="text-soft">${esc(String(c.old ?? ''))}</td>
        <td class="text--changed">${esc(String(c.new ?? ''))}</td>
        <td></td>
      </tr>
    `).join('');
    if (changes.length > 500) {
      tbody.innerHTML += `<tr><td colspan="6" class="table-empty">…외 ${changes.length - 500}건</td></tr>`;
    }
  }

  // 오류 목록
  const errDiv = $('previewErrors');
  if (errors.length > 0) {
    errDiv.hidden = false;
    errDiv.innerHTML = '<strong>검증 오류</strong><ul>' +
      errors.slice(0, 20).map((e) => `<li>행 ${e.row}: ${esc(e.message)}</li>`).join('') +
      (errors.length > 20 ? `<li>…외 ${errors.length - 20}건</li>` : '') +
      '</ul>';
  } else {
    errDiv.hidden = true;
  }

  $('btnApplyPreview').disabled = changes.length === 0;
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
}

function fieldLabel(field) {
  const map = { price: '판매가', stock: '재고', extra_price: '추가금액', sku: 'SKU' };
  return map[field] || field;
}

function closePreviewModal() {
  const modal = $('previewModal');
  if (modal) { modal.hidden = true; modal.setAttribute('aria-hidden', 'true'); }
}

/* ── 미리보기 확정 → 적용 ────────────────────────────────────────────── */
async function applyPreviewChanges() {
  if (State.previewChanges.length === 0) return;

  const uploadInput = $('excelUploadInput');
  const filename = uploadInput?.files?.[0]?.name || '';

  setLoading(true);
  closePreviewModal();
  try {
    const res = await fetch('/api/bulk-options-import', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ changes: State.previewChanges, filename }),
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error || '적용 실패', 'error'); return; }
    toast(
      `${data.applied}건 적용 완료${data.failed > 0 ? ` / ${data.failed}건 실패` : ''}`,
      data.failed > 0 ? 'warn' : 'success'
    );
    State.previewChanges = [];
    State.previewErrors  = [];
    if (uploadInput) uploadInput.value = '';
    await loadOptions();
  } catch (e) {
    toast('적용 오류: ' + e.message, 'error');
  } finally {
    setLoading(false);
  }
}

/* ── 상품 목록 로드 (필터 드롭다운) ─────────────────────────────────── */
async function loadProductFilter() {
  try {
    const res = await fetch('/api/get-product', {
      headers: { 'Authorization': 'Bearer ' + getToken() },
    });
    if (!res.ok) return;
    const data = await res.json();
    const products = data.products || (data.product ? [data.product] : []);
    const sel = $('filterProduct');
    if (!sel) return;
    sel.innerHTML = '<option value="">전체 상품</option>' +
      products.map((p) => `<option value="${esc(p.id)}">${esc(truncate(p.title, 30))}</option>`).join('');
  } catch { /* 필터 로드 실패 무시 */ }
}

/* ── 필터 적용 ───────────────────────────────────────────────────────── */
function applyFilters() {
  State.filters.product_id  = $('filterProduct')?.value  || '';
  State.filters.market      = $('filterMarket')?.value   || '';
  State.filters.zero_stock  = $('filterZeroStock')?.checked || false;
  State.filters.min_price   = $('filterMinPrice')?.value || '';
  State.filters.max_price   = $('filterMaxPrice')?.value || '';
  State.page = 1;
  loadOptions();
}

/* ── 초기화 ──────────────────────────────────────────────────────────── */
function init() {
  if (!authGuard()) return;

  // 상품 필터 로드
  loadProductFilter();
  // 첫 옵션 로드
  loadOptions();

  // tbody 이벤트 위임
  const tbody = $('optionsTbody');
  if (tbody) {
    tbody.addEventListener('change', (e) => {
      handleCellChange(e);
      handleRowCheck(e);
    });
    tbody.addEventListener('input', handleCellChange);
  }

  // 전체 선택
  $('selectAll')?.addEventListener('change', handleSelectAll);

  // 필터 버튼
  $('btnFilter')?.addEventListener('click', applyFilters);
  $('btnReset')?.addEventListener('click', () => {
    ['filterProduct', 'filterMarket', 'filterZeroStock', 'filterMinPrice', 'filterMaxPrice']
      .forEach((id) => { const el = $(id); if (el) { if (el.type === 'checkbox') el.checked = false; else el.value = ''; } });
    applyFilters();
  });

  // 일괄 적용
  $('btnBatchApply')?.addEventListener('click', applyBatchValue);

  // 전체 저장
  $('btnSave')?.addEventListener('click', saveInlineChanges);

  // 엑셀 다운로드
  $('btnExcelDownload')?.addEventListener('click', downloadExcel);

  // 엑셀 업로드
  $('btnExcelUpload')?.addEventListener('click', () => $('excelUploadInput')?.click());
  $('excelUploadInput')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleExcelUpload(file);
  });

  // 미리보기 모달 닫기
  $('btnClosePreview')?.addEventListener('click', closePreviewModal);
  $('btnCancelPreview')?.addEventListener('click', closePreviewModal);
  $('btnApplyPreview')?.addEventListener('click', applyPreviewChanges);

  // 모달 배경 클릭 닫기
  $('previewModal')?.addEventListener('click', (e) => {
    if (e.target === $('previewModal')) closePreviewModal();
  });

  // 다크 모드 토글 (다른 페이지와 동일)
  const themeBtn = $('themeToggle');
  if (themeBtn) {
    const isDark = localStorage.getItem('lumi_dark_mode') !== '0';
    document.body.classList.toggle('dark-mode', isDark);
    themeBtn.textContent = isDark ? '☀' : '☾';
    themeBtn.addEventListener('click', () => {
      const now = document.body.classList.toggle('dark-mode');
      localStorage.setItem('lumi_dark_mode', now ? '1' : '0');
      themeBtn.textContent = now ? '☀' : '☾';
    });
  }

  updateSaveButton();
}

document.addEventListener('DOMContentLoaded', init);
