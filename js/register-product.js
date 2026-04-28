// register-product.js — Sprint 2
// 셀러 UX = 3 액션 (사진 1장 → 카드 5스와이프 → 마켓 토글 1탭)
// API: /api/upload-product-image, /api/analyze-product-image, /api/register-product, /api/me

(function () {
  'use strict';

  // ================================================================
  // 상태
  // ================================================================
  const state = {
    photoFile: null,
    imageUrl: null,
    lumiProduct: null,        // AI 분석 결과 (Lumi 표준 스키마)
    cardIndex: 0,             // 0~5 (6 cards)
    cardOrder: ['category', 'title', 'detail', 'price', 'options', 'policy'],
    connectedMarkets: new Set(), // me API 결과
    selectedMarkets: new Set(),
    distributeResult: null,
  };

  // ================================================================
  // 유틸
  // ================================================================
  function $(s, root) { return (root || document).querySelector(s); }
  function $$(s, root) { return Array.from((root || document).querySelectorAll(s)); }

  function getToken() {
    return localStorage.getItem('lumi_seller_token') || sessionStorage.getItem('lumi_seller_token') || '';
  }

  async function apiFetch(path, opts) {
    const token = getToken();
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts?.headers || {});
    if (token) headers.Authorization = 'Bearer ' + token;
    if (opts?.formData) {
      delete headers['Content-Type'];
    }
    const res = await fetch(path, {
      method: opts?.method || 'GET',
      headers,
      body: opts?.formData || (opts?.body ? JSON.stringify(opts.body) : undefined),
      credentials: 'include',
    });
    let body = null;
    try { body = await res.json(); } catch (_) { /* */ }
    return { ok: res.ok, status: res.status, body };
  }

  function showError(scope, message) {
    const el = $('[data-error="' + scope + '"]');
    if (!el) return;
    if (!message) { el.style.display = 'none'; el.textContent = ''; return; }
    el.style.display = 'block';
    el.textContent = message;
  }

  function setProgress(step) {
    const steps = $$('[data-progress-step]');
    steps.forEach((el, i) => {
      el.classList.toggle('active', i < step);
    });
    const label = $('[data-progress-label]');
    if (label) label.textContent = `사진 1장 → 검수 → 마켓 — ${step} / 3`;
  }

  function showScreen(name) {
    $$('[data-screen]').forEach((el) => {
      el.style.display = el.dataset.screen === name ? '' : 'none';
    });
    if (name === 'upload') setProgress(1);
    else if (name === 'review') setProgress(2);
    else if (name === 'distribute') setProgress(3);
    if (window.lucide) window.lucide.createIcons();
  }

  // ================================================================
  // 디바이스 감지 (모바일 = 터치 + 화면 768px 미만)
  // ================================================================
  function isMobile() {
    return window.innerWidth < 768 || ('ontouchstart' in window && window.innerWidth < 1024);
  }

  function initDeviceContext() {
    const pcExtra = $('[data-pc-extra]');
    const mobilLimit = $('[data-mobile-limit]');
    const subMobile = $('.rp-sub-mobile');
    const subPc = $('.rp-sub-pc');

    if (isMobile()) {
      if (subMobile) subMobile.style.display = '';
      if (subPc) subPc.style.display = 'none';
      if (pcExtra) pcExtra.style.display = 'none';
      if (mobilLimit) mobilLimit.style.display = '';
    } else {
      if (subMobile) subMobile.style.display = 'none';
      if (subPc) subPc.style.display = '';
      if (pcExtra) pcExtra.style.display = '';
      if (mobilLimit) mobilLimit.style.display = 'none';
    }

    // "PC에서 이어가기" — 현재 URL을 복사해 데스크톱에서 열 수 있도록 클립보드에 저장
    const pcBtn = $('[data-action="continue-on-pc"]');
    if (pcBtn) {
      pcBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const url = window.location.href;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(() => {
            pcBtn.textContent = '링크 복사됨! PC에서 열어보세요';
          }).catch(() => {
            pcBtn.textContent = url;
          });
        } else {
          pcBtn.textContent = url;
        }
      });
    }
  }

  // ================================================================
  // 화면 1: 사진 업로드
  // ================================================================
  function initUpload() {
    const input = $('#photo-input');
    const empty = $('[data-upload-empty]');
    const preview = $('[data-upload-preview]');
    const thumb = $('[data-upload-thumb]');
    const replaceBtn = $('[data-upload-replace]');
    const submitBtn = $('[data-action="upload-and-analyze"]');

    if (!input) return;

    input.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      handleFile(file);
    });

    if (replaceBtn) {
      replaceBtn.addEventListener('click', (e) => {
        e.preventDefault();
        input.value = '';
        input.click();
      });
    }

    function handleFile(file) {
      showError('upload', null);
      if (file.size > 10 * 1024 * 1024) {
        showError('upload', '파일이 너무 커요 (최대 10MB).');
        return;
      }
      if (!/^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(file.type)) {
        showError('upload', '이미지 형식만 올려주세요 (JPG/PNG/WebP/HEIC).');
        return;
      }
      state.photoFile = file;
      const reader = new FileReader();
      reader.onload = (ev) => {
        thumb.src = ev.target.result;
        preview.style.display = '';
        empty.style.display = 'none';
      };
      reader.readAsDataURL(file);
      submitBtn.disabled = false;
    }

    submitBtn.addEventListener('click', async () => {
      if (!state.photoFile) return;
      submitBtn.disabled = true;
      await uploadAndAnalyze();
      submitBtn.disabled = false;
    });
  }

  async function uploadAndAnalyze() {
    const progress = $('[data-upload-progress]');
    const fill = $('[data-upload-progress-fill]');
    const text = $('[data-upload-progress-text]');
    progress.style.display = '';
    fill.style.width = '15%';
    text.textContent = '사진을 안전하게 올리는 중…';

    const formData = new FormData();
    formData.append('file', state.photoFile);

    const upRes = await apiFetch('/api/upload-product-image', { method: 'POST', formData });
    if (!upRes.ok || !upRes.body?.success) {
      showError('upload', upRes.body?.error || '업로드에 실패했어요. 다시 시도해주세요.');
      progress.style.display = 'none';
      return;
    }
    state.imageUrl = upRes.body.imageUrl;

    fill.style.width = '55%';
    text.textContent = '루미가 사진을 보고 있어요…';

    const aiRes = await apiFetch('/api/analyze-product-image', {
      method: 'POST',
      body: { imageUrl: state.imageUrl },
    });
    if (!aiRes.ok || !aiRes.body?.success) {
      showError('upload', aiRes.body?.error || 'AI 분석에 실패했어요. 사진을 다시 올려주세요.');
      progress.style.display = 'none';
      return;
    }
    state.lumiProduct = aiRes.body.product;

    fill.style.width = '100%';
    text.textContent = '카드 5장 준비 완료!';

    setTimeout(() => {
      bindReviewCards();
      showScreen('review');
      progress.style.display = 'none';
      fill.style.width = '0%';
    }, 350);
  }

  // ================================================================
  // 화면 2: 검수 카드 5장
  // ================================================================
  function bindReviewCards() {
    const product = state.lumiProduct;
    if (!product) return;

    // 카드 (상품명): title 3안 라디오 + 후킹 카피
    const titleOptionsBox = $('[data-bind="title-options"]');
    if (titleOptionsBox) {
      titleOptionsBox.innerHTML = '';
      const opts = Array.isArray(product.title_options) && product.title_options.length > 0
        ? product.title_options
        : (product.title ? [product.title] : []);
      opts.forEach((label, idx) => {
        const id = `title-opt-${idx}`;
        const wrap = document.createElement('label');
        wrap.className = 'rp-title-option';
        wrap.innerHTML = `<input type="radio" name="title-option" value="${escapeHtml(label)}" id="${id}" ${idx === 0 ? 'checked' : ''} />
          <span class="rp-title-option-tag">${idx === 0 ? 'A · 감성' : (idx === 1 ? 'B · 스펙' : 'C · 가격')}</span>
          <span class="rp-title-option-text">${escapeHtml(label)}</span>`;
        titleOptionsBox.appendChild(wrap);
      });
      titleOptionsBox.querySelectorAll('input[type="radio"]').forEach((r) => {
        r.addEventListener('change', () => {
          if (r.checked) state.lumiProduct.title = r.value;
        });
      });
    }
    const titleEdit = $('[data-edit="title"]');
    if (titleEdit) titleEdit.value = product.title || '';

    // 후킹 카피
    const hookEl = $('[data-bind="hook-caption"]');
    if (hookEl) hookEl.textContent = product.hook_caption || '—';
    const hookEdit = $('[data-edit="hook"]');
    if (hookEdit) hookEdit.value = product.hook_caption || '';

    // 카드 (카테고리): 쿠팡 / 네이버 / 토스
    const cTree = product.category_suggestions?.coupang?.tree || [];
    const nTree = product.category_suggestions?.naver?.tree || [];
    const tTree = product.category_suggestions?.toss?.tree || [];
    const cConf = product.category_suggestions?.coupang?.confidence || 0;
    const cpEl = $('[data-bind="category-coupang"]');
    if (cpEl) cpEl.textContent = cTree.length ? cTree.join(' > ') : '추천 없음';
    const nvEl = $('[data-bind="category-naver"]');
    if (nvEl) nvEl.textContent = nTree.length ? nTree.join(' > ') : '추천 없음';
    const tsEl = $('[data-bind="category-toss"]');
    if (tsEl) tsEl.textContent = tTree.length ? tTree.slice(0, 3).join(' > ') : '추천 없음';
    const cMeta = $('[data-bind="category-confidence"]');
    if (cMeta) cMeta.textContent = `루미 신뢰도 ${Math.round((cConf || 0) * 100)}%`;

    // 카드 (상세 레이아웃) — 블록 단위 미리보기
    const detailBox = $('[data-bind="detail-layout"]');
    if (detailBox) {
      detailBox.innerHTML = renderDetailLayout(product.detail_layout);
    }

    // 카드 3: 가격
    const priceEl = $('[data-bind="price"]');
    if (priceEl) priceEl.textContent = formatPrice(product.price_suggested);
    const priceEdit = $('[data-edit="price"]');
    if (priceEdit) priceEdit.value = product.price_suggested || '';

    // 카드 4: 옵션
    const optBox = $('[data-bind="options"]');
    if (optBox) {
      optBox.innerHTML = '';
      const options = product.options || [];
      if (options.length === 0) {
        optBox.innerHTML = '<div class="rp-option-row"><p class="rp-option-name">옵션</p><p class="rp-option-values">단품</p></div>';
      } else {
        options.forEach((o) => {
          const row = document.createElement('div');
          row.className = 'rp-option-row';
          row.innerHTML = `<p class="rp-option-name">${escapeHtml(o.name)}</p><p class="rp-option-values">${(o.values || []).map(escapeHtml).join(' · ')}</p>`;
          optBox.appendChild(row);
        });
      }
    }

    // 카드 5: 정책 + 키워드
    const kwBox = $('[data-bind="keywords"]');
    if (kwBox) {
      kwBox.innerHTML = '';
      (product.keywords || []).forEach((k) => {
        const chip = document.createElement('span');
        chip.className = 'rp-keyword-chip';
        chip.textContent = k;
        kwBox.appendChild(chip);
      });
    }

    const policyBox = $('[data-bind="policy"]');
    if (policyBox) {
      policyBox.innerHTML = '';
      const warnings = product.policy_warnings || [];
      if (warnings.length === 0) {
        policyBox.innerHTML = '<div class="rp-policy-clean"><i data-lucide="check"></i> 깨끗해요. 정책 위반 단어 없음</div>';
      } else {
        warnings.forEach((w) => {
          const row = document.createElement('div');
          row.className = 'rp-policy-warn';
          row.innerHTML = `<span class="rp-policy-warn-word">${escapeHtml(w.word)}</span> ${escapeHtml(w.cause || '')} <strong>→ ${escapeHtml(w.suggestion || '')}</strong>`;
          policyBox.appendChild(row);
        });
      }
    }

    // 카드 액션
    state.cardIndex = 0;
    state.cardOrder.forEach((id, i) => {
      const card = $(`[data-card-id="${id}"]`);
      if (!card) return;
      // 우 = approve, 좌 = reject, edit
      $$('[data-card-action]', card).forEach((btn) => {
        btn.onclick = (e) => {
          e.preventDefault();
          handleCardAction(id, btn.dataset.cardAction, card);
        };
      });
    });

    if (window.lucide) window.lucide.createIcons();
  }

  function persistCardEdits(cardId, card) {
    // title 카드 = 라디오 + 직접 수정 input 두 개 (title / hook)
    if (cardId === 'title') {
      const titleInput = $('[data-edit="title"]', card);
      const hookInput = $('[data-edit="hook"]', card);
      if (titleInput && titleInput.value.trim()) {
        state.lumiProduct.title = titleInput.value.trim();
      } else {
        // 라디오 선택 값 적용
        const checked = card.querySelector('input[name="title-option"]:checked');
        if (checked) state.lumiProduct.title = checked.value;
      }
      if (hookInput && hookInput.value.trim()) {
        state.lumiProduct.hook_caption = hookInput.value.trim();
      }
      const hookEl = $('[data-bind="hook-caption"]', card);
      if (hookEl) hookEl.textContent = state.lumiProduct.hook_caption || '—';
      return;
    }
    if (cardId === 'price') {
      const input = $('[data-edit="price"]', card);
      if (input) {
        state.lumiProduct.price_suggested = Number(input.value) || state.lumiProduct.price_suggested;
        const priceEl = $('[data-bind="price"]');
        if (priceEl) priceEl.textContent = formatPrice(state.lumiProduct.price_suggested);
      }
      return;
    }
  }

  function handleCardAction(cardId, action, card) {
    if (action === 'edit') {
      card.classList.toggle('rp-editing');
      if (card.classList.contains('rp-editing')) {
        const focusable = $('[data-edit]', card);
        if (focusable) setTimeout(() => focusable.focus(), 50);
      } else {
        persistCardEdits(cardId, card);
      }
      return;
    }

    if (action === 'reject') {
      // "다시" — 단순 안내. 직접 수정 권유
      const editBtn = $('[data-card-action="edit"]', card);
      if (editBtn) editBtn.click();
      return;
    }

    if (action === 'approve') {
      // 편집 중이었다면 저장
      if (card.classList.contains('rp-editing')) {
        persistCardEdits(cardId, card);
        card.classList.remove('rp-editing');
      } else if (cardId === 'title') {
        // 라디오 선택값 반영 (편집 모드 아니어도)
        persistCardEdits(cardId, card);
      }
      // 카드 우측 슬라이드
      card.classList.add('rp-rcard-leave-right');
      setTimeout(() => {
        card.style.display = 'none';
        state.cardIndex += 1;
        if (state.cardIndex >= state.cardOrder.length) {
          // 모든 카드 승인 → 화면 3
          enterDistribute();
        } else {
          updateDeckHint();
        }
      }, 350);
    }
  }

  function updateDeckHint() {
    const hint = $('[data-deck-hint]');
    if (!hint) return;
    const remain = state.cardOrder.length - state.cardIndex;
    hint.textContent = remain > 0 ? `${remain}장 남았어요` : '모두 좋다면 마켓 토글로 넘어갈게요';
  }

  // ================================================================
  // 화면 3: 마켓 전송
  // ================================================================
  async function enterDistribute() {
    showScreen('distribute');
    // me API 조회 → 연결된 마켓만 활성
    await refreshMarketsStatus();
    bindDistribute();
  }

  async function refreshMarketsStatus() {
    state.connectedMarkets.clear();
    try {
      const meRes = await apiFetch('/api/me');
      const markets = meRes.body?.seller?.market_credentials || meRes.body?.market_credentials || [];
      markets.forEach((m) => {
        if (m.verified) state.connectedMarkets.add(m.market);
      });
    } catch (e) { /* mock 환경 */ }

    ['coupang', 'naver', 'toss'].forEach((market) => {
      const row = $(`[data-market="${market}"]`);
      const status = $(`[data-market-status="${market}"]`);
      const toggle = $(`[data-market-toggle="${market}"]`);
      if (!row || !status || !toggle) return;
      if (state.connectedMarkets.has(market)) {
        status.textContent = '연결됨';
        status.dataset.state = 'connected';
        row.classList.remove('rp-market-disabled');
        toggle.disabled = false;
        toggle.checked = true;
        state.selectedMarkets.add(market);
      } else {
        status.textContent = '미연결 — /signup 에서 연결';
        status.dataset.state = 'missing';
        row.classList.add('rp-market-disabled');
        toggle.disabled = true;
        toggle.checked = false;
      }
    });
    updateDistributeButton();
  }

  function bindDistribute() {
    ['coupang', 'naver', 'toss'].forEach((market) => {
      const toggle = $(`[data-market-toggle="${market}"]`);
      if (!toggle) return;
      toggle.onchange = () => {
        if (toggle.checked) state.selectedMarkets.add(market);
        else state.selectedMarkets.delete(market);
        updateDistributeButton();
      };
    });

    const submit = $('[data-action="distribute"]');
    if (submit) {
      submit.onclick = doDistribute;
    }
    const another = $('[data-action="register-another"]');
    if (another) {
      another.onclick = () => location.reload();
    }
  }

  function updateDistributeButton() {
    const submit = $('[data-action="distribute"]');
    if (!submit) return;
    submit.disabled = state.selectedMarkets.size === 0;
  }

  async function doDistribute() {
    if (state.selectedMarkets.size === 0) return;
    const submit = $('[data-action="distribute"]');
    submit.disabled = true;
    showError('distribute', null);

    const progressBox = $('[data-distribute-progress]');
    progressBox.style.display = '';
    state.selectedMarkets.forEach((m) => {
      const row = $(`[data-distribute-row="${m}"]`);
      const state_el = $(`[data-distribute-state="${m}"]`);
      if (row) row.style.display = '';
      if (state_el) {
        state_el.textContent = '전송 중…';
        state_el.dataset.state = 'processing';
      }
    });

    const res = await apiFetch('/api/register-product', {
      method: 'POST',
      body: {
        product: state.lumiProduct,
        markets: Array.from(state.selectedMarkets),
      },
    });

    if (!res.ok || !res.body) {
      showError('distribute', res.body?.error || '전송에 실패했어요.');
      submit.disabled = false;
      return;
    }

    state.distributeResult = res.body;

    // 마켓별 상태 갱신
    (res.body.registrations || []).forEach((r) => {
      const state_el = $(`[data-distribute-state="${r.market}"]`);
      if (!state_el) return;
      if (r.success) {
        state_el.textContent = r.mock ? '모킹 등록 완료' : '등록 완료';
        state_el.dataset.state = 'success';
      } else if (r.retryable) {
        state_el.textContent = '재시도 큐 적재됨';
        state_el.dataset.state = 'queued';
      } else {
        state_el.textContent = (r.error?.title || '실패') + ' — ' + (r.error?.action || '');
        state_el.dataset.state = 'failed';
      }
    });

    // 결과 직링크 표시
    const resultsBox = $('[data-results]');
    const list = $('[data-results-list]');
    list.innerHTML = '';
    let anyLink = false;
    (res.body.registrations || []).forEach((r) => {
      const li = document.createElement('li');
      const marketName = r.market === 'coupang' ? '쿠팡'
        : r.market === 'naver' ? '네이버 스마트스토어'
        : r.market === 'toss' ? '토스쇼핑'
        : r.market;
      if (r.success && r.direct_link) {
        anyLink = true;
        li.innerHTML = `<p class="rp-results-market">${marketName}</p><a href="${escapeHtml(r.direct_link)}" target="_blank" rel="noopener">상품 보러 가기 <i data-lucide="external-link" style="width:14px;height:14px;"></i></a>`;
      } else if (r.retryable) {
        li.innerHTML = `<p class="rp-results-market">${marketName}</p><span style="color:#c98314;">잠시 후 자동 재시도해요</span>`;
      } else {
        li.innerHTML = `<p class="rp-results-market">${marketName}</p><span style="color:#d23f5e;">${escapeHtml(r.error?.title || '실패')} — ${escapeHtml(r.error?.action || '')}</span>`;
      }
      list.appendChild(li);
    });
    resultsBox.style.display = '';
    if (window.lucide) window.lucide.createIcons();

    // 스크롤 결과로
    setTimeout(() => resultsBox.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
  }

  // ================================================================
  // 헬퍼
  // ================================================================
  function formatPrice(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return '—';
    return '₩' + v.toLocaleString('ko-KR');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function renderDetailLayout(dl) {
    if (!dl || typeof dl !== 'object') {
      return '<p class="rp-rcard-meta">상세 레이아웃 정보가 없어요. 직접 입력은 PC에서 가능해요.</p>';
    }
    const blocks = [];
    if (dl.header_image) {
      blocks.push(`<div class="rp-detail-block rp-detail-block-hero"><span class="rp-detail-block-tag">대표</span><p>${escapeHtml(dl.header_image)}</p></div>`);
    }
    if (Array.isArray(dl.key_points) && dl.key_points.length > 0) {
      const items = dl.key_points.map((k) => `<li>${escapeHtml(k)}</li>`).join('');
      blocks.push(`<div class="rp-detail-block"><span class="rp-detail-block-tag">셀링포인트</span><ul class="rp-detail-keypoints">${items}</ul></div>`);
    }
    if (Array.isArray(dl.size_table) && dl.size_table.length > 0) {
      const cols = Object.keys(dl.size_table[0] || {});
      const head = `<tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr>`;
      const rows = dl.size_table.map((row) => {
        return `<tr>${cols.map((c) => `<td>${escapeHtml(row[c] || '')}</td>`).join('')}</tr>`;
      }).join('');
      blocks.push(`<div class="rp-detail-block"><span class="rp-detail-block-tag">사이즈표</span><table class="rp-detail-sizetable"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`);
    }
    if (dl.model_styling) {
      blocks.push(`<div class="rp-detail-block"><span class="rp-detail-block-tag">모델</span><p>${escapeHtml(dl.model_styling)}</p></div>`);
    }
    if (dl.fabric_care) {
      blocks.push(`<div class="rp-detail-block"><span class="rp-detail-block-tag">소재·세탁</span><p>${escapeHtml(dl.fabric_care)}</p></div>`);
    }
    if (Array.isArray(dl.faq) && dl.faq.length > 0) {
      const items = dl.faq.map((f) => `<li><strong>Q. ${escapeHtml(f.q)}</strong><br />A. ${escapeHtml(f.a)}</li>`).join('');
      blocks.push(`<div class="rp-detail-block"><span class="rp-detail-block-tag">FAQ</span><ul class="rp-detail-faq">${items}</ul></div>`);
    }
    if (blocks.length === 0) {
      return '<p class="rp-rcard-meta">루미가 상세 레이아웃을 더 가다듬을 수 있어요. 좋아요 누르면 다음 카드로 갈게요.</p>';
    }
    return blocks.join('');
  }

  // ================================================================
  // 부트
  // ================================================================
  document.addEventListener('DOMContentLoaded', () => {
    setProgress(1);
    initDeviceContext();
    initUpload();
    if (window.lucide) window.lucide.createIcons();
  });

  // 디버그용 export (브라우저 콘솔에서 검증)
  window.__rp = { state, showScreen, bindReviewCards, refreshMarketsStatus };
})();
