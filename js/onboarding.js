// =====================================================
// 루미 Sprint 1 — 가입 플로우 (5단계)
// API:
//   POST /api/business-verify              (국세청 휴폐업 자동 검증)
//   POST /api/upload-business-license      (사업자등록증 사진 업로드 — 백그라운드 검토)
//   POST /api/connect-coupang
//   POST /api/connect-naver
//   POST /api/signup-create-seller
//   GET  /api/me
// =====================================================
(function () {
  'use strict';

  const STORAGE_DARK = 'lumi_dark_mode';
  const STORAGE_TOKEN = 'lumi_token';
  const STORAGE_USER = 'lumi_user';
  const STORAGE_DRAFT = 'lumi_signup_draft_v1';

  const LICENSE_MAX_BYTES = 10 * 1024 * 1024; // 10MB
  const LICENSE_ALLOWED_MIME = [
    'image/jpeg', 'image/jpg', 'image/png',
    'image/heic', 'image/heif', 'image/webp',
    'application/pdf',
  ];

  // -------- 상태 --------
  const state = {
    step: 1,                // 1..5
    token: null,
    sellerId: null,
    licenseFile: null,           // File 객체 (가입 submit 시 업로드)
    licenseFileUrl: null,        // 업로드 후 받은 fileUrl
    business: {
      businessNumber: '',
      ownerName: '',
      email: '',
      birthDate: '',
      phone: '',
      storeName: '',
      verified: false,
    },
    markets: {
      coupang: { connected: false, vendorId: null, mock: false },
      naver: { connected: false, applicationIdMasked: null, mock: false },
    },
    tone: {
      greeting: '',
      closing: '',
      recommendation: '',
      skipped: false,
    },
    consent: {
      privacy: false,
      terms: false,
      refund: false,
      openai: false,
      marketing: false,
    },
  };

  function loadDraft() {
    try {
      const raw = localStorage.getItem(STORAGE_DRAFT);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d && typeof d === 'object') {
        if (d.business) Object.assign(state.business, d.business);
        if (d.tone) Object.assign(state.tone, d.tone);
        if (d.consent) Object.assign(state.consent, d.consent);
      }
    } catch (_) { /* ignore */ }
  }
  function saveDraft() {
    try {
      // 사업자번호/휴대폰/이름은 동일 디바이스 복원 목적으로만 저장
      localStorage.setItem(STORAGE_DRAFT, JSON.stringify({
        business: state.business,
        tone: state.tone,
        consent: state.consent,
      }));
    } catch (_) { /* ignore */ }
  }
  function clearDraft() {
    try { localStorage.removeItem(STORAGE_DRAFT); } catch (_) { /* */ }
  }

  // -------- 다크모드 --------
  function applyTheme(dark) {
    document.body.classList.toggle('dark-mode', dark);
    const ico = document.querySelector('[data-theme-icon]');
    if (ico) ico.setAttribute('data-lucide', dark ? 'sun' : 'moon');
    if (window.lucide) window.lucide.createIcons();
  }
  function initTheme() {
    const stored = localStorage.getItem(STORAGE_DARK);
    let dark = stored === '1';
    if (stored === null) dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(dark);
    const btn = document.querySelector('[data-theme-toggle]');
    if (btn) {
      btn.addEventListener('click', function () {
        const next = !document.body.classList.contains('dark-mode');
        localStorage.setItem(STORAGE_DARK, next ? '1' : '0');
        applyTheme(next);
      });
    }
  }
  function initIcons() { if (window.lucide) window.lucide.createIcons(); }

  // -------- 토스트 --------
  function ensureToastContainer() {
    let c = document.querySelector('.toast-container');
    if (!c) {
      c = document.createElement('div');
      c.className = 'toast-container';
      document.body.appendChild(c);
    }
    return c;
  }
  function showToast(message, type) {
    const c = ensureToastContainer();
    const t = document.createElement('div');
    t.className = 'toast' + (type ? ' ' + type : '');
    const icon = type === 'error' ? 'alert-circle' : type === 'success' ? 'check-circle' : 'info';
    t.innerHTML = `<i class="toast-icon" data-lucide="${icon}" style="width:18px;height:18px;"></i>` +
                  `<p class="toast-msg"></p>`;
    t.querySelector('.toast-msg').textContent = message;
    c.appendChild(t);
    initIcons();
    setTimeout(function () { t.style.opacity = '0'; t.style.transform = 'translateY(20px)'; }, 4200);
    setTimeout(function () { t.remove(); }, 4600);
  }

  // Principle 5: 친화 에러 토스트 (title + cause + action + deep link)
  function showFriendlyError(err) {
    if (!err || typeof err !== 'object') {
      showToast(typeof err === 'string' ? err : '연결에 실패했습니다.', 'error');
      return;
    }
    const c = ensureToastContainer();
    const t = document.createElement('div');
    t.className = 'toast error friendly';
    const titleHtml = err.title ? `<p class="toast-title">${escapeHtml(err.title)}</p>` : '';
    const causeHtml = err.cause ? `<p class="toast-msg">${escapeHtml(err.cause)}</p>` : '';
    const actionHtml = err.action ? `<p class="toast-msg toast-action">${escapeHtml(err.action)}</p>` : '';
    const linkHtml = err.deepLink ? `<button class="toast-deeplink" data-deeplink="${escapeHtml(err.deepLink)}">자세히 보기 →</button>` : '';
    const codeHtml = err.statusCode ? `<span class="toast-code">코드 ${err.statusCode}</span>` : '';
    t.innerHTML = `<i class="toast-icon" data-lucide="alert-circle" style="width:20px;height:20px;"></i>` +
                  `<div class="toast-body">${titleHtml}${causeHtml}${actionHtml}${linkHtml}${codeHtml}</div>`;
    c.appendChild(t);
    initIcons();
    const link = t.querySelector('[data-deeplink]');
    if (link) {
      link.addEventListener('click', function () {
        const key = link.getAttribute('data-deeplink');
        openDeepLink(key);
      });
    }
    setTimeout(function () { t.style.opacity = '0'; t.style.transform = 'translateY(20px)'; }, 8000);
    setTimeout(function () { t.remove(); }, 8400);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // Principle 3: deep link DB 조회 + 외부 URL 오픈
  let _guidesCache = null;
  async function fetchGuides() {
    if (_guidesCache) return _guidesCache;
    try {
      const r = await api('/api/market-guides', { method: 'GET' });
      if (r.status === 200 && r.data?.success) {
        _guidesCache = r.data.guides || [];
        return _guidesCache;
      }
    } catch (_) { /* fallback */ }
    _guidesCache = [];
    return _guidesCache;
  }
  async function openDeepLink(key) {
    if (!key || typeof key !== 'string') return;
    const [market, stepKey] = key.split('.');
    const guides = await fetchGuides();
    const found = guides.find(function (g) { return g.market === market && g.step_key === stepKey; });
    if (found && found.external_url) {
      window.open(found.external_url, '_blank', 'noopener,noreferrer');
    } else {
      showToast('가이드 페이지를 불러오지 못했어요. 잠시 후 다시 시도해주세요.', 'error');
    }
  }

  // -------- 입력 정규화 --------
  function normalizeBusinessNumber(s) { return String(s || '').replace(/\D/g, ''); }
  function formatBusinessNumber(s) {
    const d = normalizeBusinessNumber(s).slice(0, 10);
    if (d.length <= 3) return d;
    if (d.length <= 5) return `${d.slice(0,3)}-${d.slice(3)}`;
    return `${d.slice(0,3)}-${d.slice(3,5)}-${d.slice(5)}`;
  }
  function isValidBusinessNumber(s) {
    const d = normalizeBusinessNumber(s);
    if (!/^\d{10}$/.test(d)) return false;
    const w = [1,3,7,1,3,7,1,3,5];
    let sum = 0;
    for (let i = 0; i < 9; i += 1) sum += parseInt(d[i],10) * w[i];
    sum += Math.floor((parseInt(d[8],10) * 5) / 10);
    const check = (10 - (sum % 10)) % 10;
    return check === parseInt(d[9],10);
  }
  function formatBirthDate(s) {
    const d = String(s || '').replace(/\D/g, '').slice(0, 8);
    if (d.length <= 4) return d;
    if (d.length <= 6) return `${d.slice(0,4)}-${d.slice(4)}`;
    return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6)}`;
  }
  function normalizePhone(s) { return String(s || '').replace(/\D/g, ''); }
  function formatPhone(s) {
    const d = normalizePhone(s).slice(0, 11);
    if (d.length <= 3) return d;
    if (d.length <= 7) return `${d.slice(0,3)}-${d.slice(3)}`;
    if (d.length === 10) return `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`;
    return `${d.slice(0,3)}-${d.slice(3,7)}-${d.slice(7)}`;
  }
  function isValidPhone(s) {
    const d = normalizePhone(s);
    return /^01[016789]\d{7,8}$/.test(d);
  }

  // -------- 백그라운드 권한 검증 (Principle 1, 2) --------
  // 셀러를 막지 않음. 결과 도착 시 카드 하단 텍스트만 갱신.
  async function triggerPermissionCheck(market, cardEl) {
    try {
      const res = await api('/api/market-permission-check', {
        method: 'POST',
        body: JSON.stringify({ market }),
      });
      const scopeEl = cardEl?.querySelector('[data-scope-status]');
      if (res.status === 200 && res.data?.success) {
        if (res.data.scopeOk) {
          state.markets[market].scopeStatus = 'ok';
          if (scopeEl) {
            scopeEl.textContent = '판매 권한 확인 완료';
            scopeEl.style.color = 'var(--success)';
          }
        } else {
          state.markets[market].scopeStatus = 'fail';
          if (scopeEl) {
            scopeEl.textContent = '판매 권한 부족 — 가이드 확인 필요';
            scopeEl.style.color = 'var(--warning)';
          }
          // 셀러를 막지 않고 알림만
          if (res.data.error) showFriendlyError(res.data.error);
        }
      } else {
        state.markets[market].scopeStatus = 'unknown';
        if (scopeEl) {
          scopeEl.textContent = '권한 확인 실패 — 나중에 다시 확인';
          scopeEl.style.color = 'var(--text-muted)';
        }
      }
    } catch (e) {
      console.error(`[permission-check ${market}]`, e);
      const scopeEl = cardEl?.querySelector('[data-scope-status]');
      if (scopeEl) {
        scopeEl.textContent = '권한 확인 실패 — 네트워크 오류';
        scopeEl.style.color = 'var(--text-muted)';
      }
    }
  }

  // -------- API --------
  async function api(path, opts) {
    const base = window.location.origin;
    const url = base + path;
    const headers = Object.assign(
      { 'Content-Type': 'application/json' },
      state.token ? { Authorization: 'Bearer ' + state.token } : {},
      (opts && opts.headers) || {}
    );
    const res = await fetch(url, Object.assign({}, opts, { headers }));
    let data;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  }

  // -------- 진행도 표시 --------
  function renderProgress() {
    const steps = document.querySelectorAll('[data-progress-step]');
    steps.forEach(function (el, i) {
      el.classList.remove('active', 'done');
      if (i + 1 < state.step) el.classList.add('done');
      if (i + 1 === state.step) el.classList.add('active');
    });
    const label = document.querySelector('[data-progress-label]');
    if (label) {
      label.textContent = `사장님 첫 쇼핑몰까지 5분 — ${state.step} / 5`;
    }
  }

  // -------- 단계 전환 --------
  function showStep(step) {
    state.step = step;
    document.querySelectorAll('[data-step]').forEach(function (el) {
      el.style.display = (Number(el.getAttribute('data-step')) === step) ? 'block' : 'none';
    });
    document.querySelector('[data-done]').style.display = 'none';
    renderProgress();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    initIcons();
  }
  function showDone() {
    document.querySelectorAll('[data-step]').forEach(function (el) { el.style.display = 'none'; });
    const done = document.querySelector('[data-done]');
    if (done) done.style.display = 'block';
    document.querySelectorAll('[data-progress-step]').forEach(function (el) {
      el.classList.add('done'); el.classList.remove('active');
    });
    const label = document.querySelector('[data-progress-label]');
    if (label) label.textContent = '완료';
    initIcons();
  }

  // =====================================================
  // STEP 1: 사업자 인증
  // =====================================================
  function initStep1() {
    const bizInput = document.querySelector('[data-input="businessNumber"]');
    const ownerInput = document.querySelector('[data-input="ownerName"]');
    const emailInput = document.querySelector('[data-input="email"]');
    const birthInput = document.querySelector('[data-input="birthDate"]');
    const phoneInput = document.querySelector('[data-input="phone"]');
    const storeInput = document.querySelector('[data-input="storeName"]');
    const licenseInput = document.querySelector('[data-input="licenseFile"]');
    const submit = document.querySelector('[data-action="step1-submit"]');
    const errEl = document.querySelector('[data-error="step1"]');

    if (bizInput) {
      bizInput.value = state.business.businessNumber || bizInput.value || '';
      bizInput.addEventListener('input', function () {
        const pos = bizInput.selectionStart;
        const prev = bizInput.value;
        const formatted = formatBusinessNumber(prev);
        bizInput.value = formatted;
        // 커서 위치 보정: 하이픈 삽입 직후 1칸 앞으로 밀림 방지
        const diff = formatted.length - prev.length;
        bizInput.setSelectionRange(pos + diff, pos + diff);
      });
      bizInput.addEventListener('blur', function () {
        bizInput.value = formatBusinessNumber(bizInput.value);
      });
    }
    if (ownerInput) ownerInput.value = state.business.ownerName || ownerInput.value || '';
    if (emailInput) {
      emailInput.value = state.business.email || emailInput.value || '';
      // OAuth로 가져온 이메일은 readonly
      if (state.business.email) {
        emailInput.readOnly = true;
        emailInput.style.opacity = '0.7';
        emailInput.style.cursor = 'not-allowed';
      }
    }
    if (birthInput) {
      birthInput.value = state.business.birthDate || birthInput.value || '';
      birthInput.addEventListener('input', function () {
        const pos = birthInput.selectionStart;
        const prev = birthInput.value;
        const formatted = formatBirthDate(prev);
        birthInput.value = formatted;
        const diff = formatted.length - prev.length;
        birthInput.setSelectionRange(pos + diff, pos + diff);
      });
    }
    if (phoneInput) {
      phoneInput.value = state.business.phone || phoneInput.value || '';
      // 카카오에서 받은 휴대폰은 readonly
      if (state.business.phoneFromOAuth) {
        phoneInput.readOnly = true;
        phoneInput.style.opacity = '0.7';
        phoneInput.style.cursor = 'not-allowed';
      }
      phoneInput.addEventListener('input', function () {
        if (phoneInput.readOnly) return;
        const pos = phoneInput.selectionStart;
        const prev = phoneInput.value;
        const formatted = formatPhone(prev);
        phoneInput.value = formatted;
        const diff = formatted.length - prev.length;
        phoneInput.setSelectionRange(pos + diff, pos + diff);
      });
      phoneInput.addEventListener('blur', function () {
        phoneInput.value = formatPhone(phoneInput.value);
      });
    }
    if (storeInput) storeInput.value = state.business.storeName || storeInput.value || '';

    initLicenseUpload(licenseInput);

    function setError(msg) {
      if (errEl) {
        errEl.textContent = msg || '';
        errEl.style.display = msg ? 'block' : 'none';
      }
    }

    if (submit) {
      submit.addEventListener('click', async function () {
        setError('');
        const businessNumber = normalizeBusinessNumber(bizInput?.value);
        const ownerName = (ownerInput?.value || '').trim();
        const email = (emailInput?.value || '').trim();
        const birthDate = (birthInput?.value || '').trim();
        const phone = normalizePhone(phoneInput?.value);
        const storeName = (storeInput?.value || '').trim();

        if (!isValidBusinessNumber(businessNumber)) {
          setError('사업자등록번호 형식이 올바르지 않습니다. 10자리 숫자를 확인해주세요.');
          bizInput?.classList.add('error');
          return;
        }
        bizInput?.classList.remove('error');
        if (!ownerName || ownerName.length < 2) {
          setError('대표자명을 입력해주세요.');
          ownerInput?.classList.add('error');
          return;
        }
        ownerInput?.classList.remove('error');
        if (!isValidPhone(phone)) {
          setError('휴대폰 번호를 정확히 입력해주세요. (예: 010-1234-5678)');
          phoneInput?.classList.add('error');
          return;
        }
        phoneInput?.classList.remove('error');
        if (!state.licenseFile) {
          setError('사업자등록증 사진 또는 PDF를 올려주세요.');
          return;
        }

        submit.disabled = true;
        const orig = submit.innerHTML;
        submit.innerHTML = '<span class="spinner"></span> 인증 중...';

        try {
          // 1) 사업자 인증 호출 (국세청 휴폐업 자동 확인 — startDate 불필요)
          const verifyRes = await api('/api/business-verify', {
            method: 'POST',
            body: JSON.stringify({
              businessNumber, ownerName,
              businessName: storeName || undefined,
              birthDate, phone,
            }),
          });
          if (verifyRes.status !== 200 || !verifyRes.data || !verifyRes.data.success) {
            const errPayload = verifyRes.data?.error;
            // 친화 에러 객체이면 토스트 카드, 아니면 인라인 텍스트
            if (errPayload && typeof errPayload === 'object' && errPayload.title) {
              showFriendlyError(errPayload);
              setError(errPayload.cause || '');
            } else {
              setError(errPayload || '인증에 실패했습니다. 잠시 후 다시 시도해주세요.');
            }
            return;
          }

          state.business = { businessNumber, ownerName, email, birthDate, phone, storeName, verified: true };
          saveDraft();

          // 2) 셀러 row 생성 (signup_step=1, 토큰 발급)
          const createRes = await api('/api/signup-create-seller', {
            method: 'POST',
            body: JSON.stringify({
              businessNumber,
              ownerName,
              phone,
              birthDate,
              storeName,
              email: email || null,
              marketingConsent: state.consent.marketing,
              privacyConsent: true,
              termsConsent: true,
              signupStep: 1,
            }),
          });
          if (createRes.status !== 200 || !createRes.data || !createRes.data.success) {
            setError(createRes.data?.error || '가입 처리에 실패했습니다.');
            return;
          }
          state.token = createRes.data.token;
          state.sellerId = createRes.data.seller.id;
          try { localStorage.setItem(STORAGE_TOKEN, state.token); } catch (_) {}
          try { localStorage.setItem('lumi_seller_jwt', state.token); } catch (_) {}
          try { localStorage.setItem('lumi_seller_token', state.token); } catch (_) {}
          try { localStorage.setItem(STORAGE_USER, JSON.stringify(createRes.data.seller)); } catch (_) {}

          // 3) 사업자등록증 업로드 + OCR 자동 대조 (Sprint 1.1)
          submit.innerHTML = '<span class="spinner"></span> 등록증 확인 중...';
          showOcrCard('checking');
          try {
            const uploadRes = await uploadLicenseFile(state.licenseFile, state.token, {
              businessNumber, ownerName, businessName: storeName,
            });
            const licenseUrl = uploadRes && uploadRes.fileUrl;
            const ocr = uploadRes && uploadRes.ocr;
            if (licenseUrl) {
              state.licenseFileUrl = licenseUrl;
              // 셀러 row에 fileUrl 연결
              await api('/api/signup-create-seller', {
                method: 'POST',
                body: JSON.stringify({
                  businessNumber, ownerName, phone, birthDate, storeName, email: null,
                  marketingConsent: state.consent.marketing,
                  privacyConsent: true, termsConsent: true,
                  signupStep: 1,
                  licenseFileUrl: licenseUrl,
                }),
              }).catch(function () { /* best-effort */ });
            }
            // OCR 결과 카드 렌더 — 일치/불일치/스킵
            renderOcrResult(ocr);
            // 불일치면 셀러가 다시 촬영하거나 그대로 진행을 선택할 때까지 대기
            if (ocr && ocr.ran && ocr.match === false) {
              const choice = await waitForOcrAction();
              if (choice === 'recapture') {
                // 셀러가 다시 촬영 선택 — Step 2로 넘어가지 않고 같은 화면 유지
                submit.disabled = false;
                submit.innerHTML = orig;
                return;
              }
              // 'continue' 선택 시 다음 단계 진행
            }
          } catch (uploadErr) {
            console.error('[step1] 업로드 실패:', uploadErr.message || uploadErr);
            showOcrCard('error', '사진 확인을 일시적으로 못했어요', '가입은 막히지 않아요. 사진은 나중에 다시 올릴 수 있어요.');
            showToast('사진 업로드는 나중에 다시 할 수 있어요. 가입은 정상 진행돼요.', 'info');
          }

          showToast('사업자 인증이 완료됐어요. 사진 검토는 백그라운드로 진행됩니다.', 'success');
          showStep(2);
        } catch (e) {
          setError('네트워크 오류가 발생했습니다. 다시 시도해주세요.');
          console.error('[step1]', e);
        } finally {
          submit.disabled = false;
          submit.innerHTML = orig;
        }
      });
    }
  }

  // -------- 사업자등록증 업로드 UI --------
  function initLicenseUpload(licenseInput) {
    if (!licenseInput) return;
    const dropzone = document.querySelector('[data-license-dropzone]');
    const empty = document.querySelector('[data-license-empty]');
    const preview = document.querySelector('[data-license-preview]');
    const thumb = document.querySelector('[data-license-thumb]');
    const nameEl = document.querySelector('[data-license-name]');
    const sizeEl = document.querySelector('[data-license-size]');
    const removeBtn = document.querySelector('[data-license-remove]');

    function showFile(file) {
      state.licenseFile = file;
      if (empty) empty.style.display = 'none';
      if (preview) preview.style.display = 'flex';
      if (dropzone) dropzone.classList.add('has-file');
      if (nameEl) nameEl.textContent = file.name;
      if (sizeEl) sizeEl.textContent = formatBytes(file.size);
      // 이미지면 썸네일, PDF면 PDF 아이콘
      if (thumb) {
        if (file.type === 'application/pdf') {
          thumb.src = '';
          thumb.style.display = 'none';
        } else if (file.type.startsWith('image/')) {
          thumb.style.display = 'block';
          const reader = new FileReader();
          reader.onload = function (ev) { thumb.src = ev.target.result; };
          reader.readAsDataURL(file);
        }
      }
    }

    function clearFile() {
      state.licenseFile = null;
      state.licenseFileUrl = null;
      if (licenseInput) licenseInput.value = '';
      if (empty) empty.style.display = 'flex';
      if (preview) preview.style.display = 'none';
      if (dropzone) dropzone.classList.remove('has-file');
      if (thumb) thumb.src = '';
    }

    function handleFile(file) {
      if (!file) { clearFile(); return; }
      // MIME 검증
      if (!LICENSE_ALLOWED_MIME.includes(file.type) && !/\.(jpe?g|png|heic|heif|webp|pdf)$/i.test(file.name)) {
        showToast('사진 또는 PDF만 올릴 수 있어요. (JPG·PNG·HEIC·PDF)', 'error');
        clearFile();
        return;
      }
      // 크기 검증
      if (file.size > LICENSE_MAX_BYTES) {
        showToast(`파일이 너무 커요. 10MB 이하로 올려주세요. (현재 ${formatBytes(file.size)})`, 'error');
        clearFile();
        return;
      }
      showFile(file);
    }

    licenseInput.addEventListener('change', function (e) {
      const file = e.target.files && e.target.files[0];
      handleFile(file);
    });

    if (removeBtn) {
      removeBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        clearFile();
      });
    }

    // 드래그 & 드롭 (PC)
    if (dropzone) {
      ['dragenter', 'dragover'].forEach(function (ev) {
        dropzone.addEventListener(ev, function (e) {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.add('dragover');
        });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        dropzone.addEventListener(ev, function (e) {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.remove('dragover');
        });
      });
      dropzone.addEventListener('drop', function (e) {
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) handleFile(file);
      });
    }
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB'];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + ' ' + units[i];
  }

  // 사업자등록증 업로드 — XHR로 진행률 갱신 + OCR 자동 대조 결과 동봉.
  // sellerInput { businessNumber, ownerName, businessName } — OCR 자동 대조용 (multipart 필드 동봉).
  async function uploadLicenseFile(file, token, sellerInput) {
    return new Promise(function (resolve, reject) {
      const progressEl = document.querySelector('[data-license-progress]');
      const fillEl = document.querySelector('[data-license-progress-fill]');
      const labelEl = document.querySelector('[data-license-progress-label]');
      if (progressEl) progressEl.style.display = 'block';

      const fd = new FormData();
      fd.append('file', file);
      fd.append('originalName', file.name);
      // OCR 자동 대조용 셀러 입력값 — multipart field로 함께 전송
      if (sellerInput) {
        if (sellerInput.businessNumber) fd.append('businessNumber', String(sellerInput.businessNumber));
        if (sellerInput.ownerName)      fd.append('ownerName', String(sellerInput.ownerName));
        if (sellerInput.businessName)   fd.append('businessName', String(sellerInput.businessName));
      }

      const xhr = new XMLHttpRequest();
      xhr.open('POST', window.location.origin + '/api/upload-business-license', true);
      if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);

      xhr.upload.addEventListener('progress', function (e) {
        if (!e.lengthComputable) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        if (fillEl) fillEl.style.width = pct + '%';
        if (labelEl) labelEl.textContent = pct + '%';
      });

      xhr.addEventListener('load', function () {
        if (progressEl) {
          setTimeout(function () { progressEl.style.display = 'none'; }, 600);
        }
        let data;
        try { data = JSON.parse(xhr.responseText); } catch { data = null; }
        if (xhr.status === 200 && data && data.success && data.fileUrl) {
          // 전체 응답 반환 — caller가 fileUrl + ocr 모두 사용
          resolve({ fileUrl: data.fileUrl, ocr: data.ocr || null, mock: Boolean(data.mock) });
        } else {
          const err = data && data.error;
          const msg = (typeof err === 'string') ? err : (err && err.cause) || '업로드에 실패했어요';
          reject(new Error(msg));
        }
      });
      xhr.addEventListener('error', function () {
        if (progressEl) progressEl.style.display = 'none';
        reject(new Error('네트워크 오류'));
      });
      xhr.addEventListener('abort', function () {
        if (progressEl) progressEl.style.display = 'none';
        reject(new Error('업로드 취소됨'));
      });

      xhr.send(fd);
    });
  }

  // =====================================================
  // OCR 자동 대조 결과 카드 — Sprint 1.1
  // =====================================================
  function showOcrCard(state, title, desc) {
    const card = document.querySelector('[data-ocr-card]');
    if (!card) return;
    card.style.display = 'flex';
    card.setAttribute('data-state', state || 'checking');
    const titleEl = card.querySelector('[data-ocr-title]');
    const descEl = card.querySelector('[data-ocr-desc]');
    const iconEl = card.querySelector('[data-ocr-icon]');
    if (state === 'checking') {
      if (titleEl) titleEl.textContent = '잠시만요, 사장님 사진을 확인해 보고 있어요';
      if (descEl)  descEl.textContent = '사진에 적힌 정보를 입력값과 비교하고 있어요. 5초 정도 걸려요.';
      if (iconEl)  iconEl.innerHTML = '<i data-lucide="loader" style="width:20px;height:20px;"></i>';
    } else if (state === 'match') {
      if (titleEl) titleEl.textContent = title || '사진과 입력값이 일치해요';
      if (descEl)  descEl.textContent = desc || '자동으로 사업자등록증을 확인했어요. 다음 단계로 넘어가요.';
      if (iconEl)  iconEl.innerHTML = '<i data-lucide="check" style="width:18px;height:18px;"></i>';
    } else if (state === 'mismatch') {
      if (titleEl) titleEl.textContent = title || '입력값과 사진이 달라요';
      if (descEl)  descEl.textContent = desc || '사진에서 읽은 정보가 입력값과 달라요. 다시 촬영하거나 그대로 진행할 수 있어요.';
      if (iconEl)  iconEl.innerHTML = '<i data-lucide="alert-triangle" style="width:18px;height:18px;"></i>';
    } else if (state === 'error') {
      if (titleEl) titleEl.textContent = title || '사진 자동 확인을 못했어요';
      if (descEl)  descEl.textContent = desc || '사진은 잘 받았어요. 자동 확인은 백그라운드에서 다시 시도할게요.';
      if (iconEl)  iconEl.innerHTML = '<i data-lucide="info" style="width:18px;height:18px;"></i>';
    }
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      try { window.lucide.createIcons(); } catch (_) {}
    }
  }

  function renderOcrFields(ocr) {
    const ul = document.querySelector('[data-ocr-fields]');
    if (!ul) return;
    ul.innerHTML = '';
    if (!ocr || !ocr.ran) { ul.style.display = 'none'; return; }
    const items = [];
    if (typeof ocr.businessNumberMatch === 'boolean') {
      items.push({
        label: '사업자번호',
        ok: ocr.businessNumberMatch,
        ng: '입력값과 사진의 사업자번호가 달라요',
      });
    }
    if (typeof ocr.ownerNameMatch === 'boolean') {
      items.push({
        label: '대표자명',
        ok: ocr.ownerNameMatch,
        ng: '입력값과 사진의 대표자명이 달라요',
      });
    }
    if (ocr.isBusinessLicense === false) {
      items.push({ label: '문서 종류', ok: false, ng: '사업자등록증으로 보이지 않아요' });
    }
    if (typeof ocr.confidence === 'number') {
      items.push({
        label: 'AI 신뢰도',
        ok: ocr.confidence >= 90,
        ng: '사진이 흐려서 자동 확인이 어려워요 (' + ocr.confidence + '%)',
        okText: ocr.confidence + '%',
      });
    }
    if (!items.length) { ul.style.display = 'none'; return; }
    items.forEach(function (it) {
      const li = document.createElement('li');
      li.setAttribute('data-status', it.ok ? 'ok' : 'bad');
      const icon = it.ok ? 'check-circle' : 'x-circle';
      const text = it.ok
        ? (it.label + (it.okText ? ' · ' + it.okText : ' 일치'))
        : (it.label + ' · ' + it.ng);
      li.innerHTML = '<i data-lucide="' + icon + '" style="width:14px;height:14px;flex:0 0 auto;"></i><span>' + text + '</span>';
      ul.appendChild(li);
    });
    ul.style.display = 'flex';
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      try { window.lucide.createIcons(); } catch (_) {}
    }
  }

  function renderOcrResult(ocr) {
    const card = document.querySelector('[data-ocr-card]');
    const actionsEl = document.querySelector('[data-ocr-actions]');
    if (!card) return;
    if (!ocr || !ocr.ran) {
      // OCR 미수행 — 카드 숨김
      card.style.display = 'none';
      return;
    }
    if (ocr.match === true) {
      showOcrCard('match');
      renderOcrFields(ocr);
      if (actionsEl) actionsEl.style.display = 'none';
    } else if (ocr.match === false) {
      showOcrCard('mismatch');
      renderOcrFields(ocr);
      if (actionsEl) actionsEl.style.display = 'flex';
    } else {
      showOcrCard('error', '사진 자동 확인을 못했어요',
        ocr.error === 'unsupported_format'
          ? 'PDF는 자동 확인을 못해요. 사진은 백그라운드에서 김현 admin이 검토할게요.'
          : '사진은 잘 받았어요. 자동 확인은 백그라운드에서 다시 시도할게요.');
      if (actionsEl) actionsEl.style.display = 'none';
    }
  }

  // OCR 카드의 사용자 액션 대기 — '다시 촬영' or '그대로 진행' 클릭 시 resolve
  function waitForOcrAction() {
    return new Promise(function (resolve) {
      const recapture = document.querySelector('[data-action="ocr-recapture"]');
      const cont = document.querySelector('[data-action="ocr-continue"]');
      const card = document.querySelector('[data-ocr-card]');
      function cleanup() {
        if (recapture) recapture.removeEventListener('click', onR);
        if (cont) cont.removeEventListener('click', onC);
      }
      function onR() {
        cleanup();
        // 카드 숨기고 파일 입력 다시 트리거
        if (card) card.style.display = 'none';
        const licenseInput = document.querySelector('[data-input="licenseFile"]');
        if (licenseInput) licenseInput.click();
        resolve('recapture');
      }
      function onC() {
        cleanup();
        resolve('continue');
      }
      if (recapture) recapture.addEventListener('click', onR);
      if (cont) cont.addEventListener('click', onC);
    });
  }

  // =====================================================
  // STEP 2: 마켓 OAuth — Sprint 1.5 미세 5단계 위자드
  // 메모리: project_market_oauth_wizard_ux.md
  //   1️⃣ 발급 안내 → 2️⃣ 키 복사 → 3️⃣ 입력 → 4️⃣ 검증 → 5️⃣ 완료
  // =====================================================
  const MICRO_MASCOT = {
    1: '/assets/logo-cloud.png', // 호기심·시작
    2: '/assets/logo-cloud.png', // 안내
    3: '/assets/logo-cloud.png', // 감지
    4: '/assets/logo-cloud.png', // 확인
    5: '/assets/logo-cloud.png', // 완료
  };

  const MICRO_COPY = {
    coupang: {
      1: { title: '쿠팡 키 발급하러 가요', sub: '쿠팡 Wing에서 OPEN API 키를 발급받고, 두 키를 복사해 주세요.', time: '예상 소요 30초' },
      2: { title: '두 키를 복사하셨나요?', sub: '루미로 돌아오시면 자동으로 감지해 드릴게요.', time: '앞으로 약 20초' },
      3: { title: '키를 입력해 주세요', sub: '복사하신 값이 자동으로 들어와요. 비어 있으면 직접 붙여넣어 주세요.', time: '앞으로 약 15초' },
      4: { title: '확인 중이에요, 잠시만요', sub: '쿠팡과 연결을 검증하고 있어요.', time: '앞으로 약 5초' },
      5: { title: '쿠팡 연결 완료!', sub: '다음은 네이버를 연결해 보세요.', time: '완료' },
    },
    naver: {
      1: { title: '네이버 키 발급하러 가요', sub: '네이버 커머스 API 센터에서 애플리케이션을 등록하고, ID와 Secret을 복사해 주세요.', time: '예상 소요 60초' },
      2: { title: '두 키를 복사하셨나요?', sub: '루미로 돌아오시면 자동으로 감지해 드릴게요.', time: '앞으로 약 30초' },
      3: { title: '키를 입력해 주세요', sub: '복사하신 값이 자동으로 들어와요. 비어 있으면 직접 붙여넣어 주세요.', time: '앞으로 약 20초' },
      4: { title: '확인 중이에요, 잠시만요', sub: '네이버와 연결을 검증하고 있어요.', time: '앞으로 약 5초' },
      5: { title: '네이버 연결 완료!', sub: '두 마켓 모두 연결됐어요. 다음 단계로 가요.', time: '완료' },
    },
  };

  // 마켓별 미세 위자드 상태
  const microState = {
    coupang: { step: 1, detector: null },
    naver: { step: 1, detector: null },
  };

  function setMicroStep(market, step) {
    if (!['coupang', 'naver'].includes(market)) return;
    if (step < 1 || step > 5) return;
    microState[market].step = step;
    const wizard = document.querySelector(`[data-micro-wizard="${market}"]`);
    if (!wizard) return;
    wizard.setAttribute('data-micro-step', String(step));

    // 진행 바 시각화
    wizard.querySelectorAll('[data-mp-step]').forEach(function (el) {
      const n = Number(el.getAttribute('data-mp-step'));
      el.classList.remove('active', 'done');
      if (n < step) el.classList.add('done');
      if (n === step) el.classList.add('active');
    });
    // 라인
    const lines = wizard.querySelectorAll('.micro-progress-line');
    lines.forEach(function (line, idx) {
      // line[0] = step1↔step2 사이 등
      if (idx + 1 < step) line.classList.add('done');
      else line.classList.remove('done');
    });

    // 마스코트 + 카피 + 시간
    const mascot = wizard.querySelector('[data-mp-mascot]');
    const titleEl = wizard.querySelector('[data-mp-title]');
    const subEl = wizard.querySelector('[data-mp-sub]');
    const timeEl = wizard.querySelector('[data-mp-time]');
    if (mascot) mascot.src = MICRO_MASCOT[step];
    const copy = (MICRO_COPY[market] || {})[step] || {};
    if (titleEl && copy.title) titleEl.textContent = copy.title;
    if (subEl && copy.sub) subEl.textContent = copy.sub;
    if (timeEl && copy.time) timeEl.textContent = copy.time;

    // 패널 표시
    wizard.querySelectorAll('[data-mp-pane]').forEach(function (pane) {
      const n = Number(pane.getAttribute('data-mp-pane'));
      pane.style.display = (n === step) ? 'block' : 'none';
    });

    initIcons();
  }

  // Smart Clipboard 팝업 (전역, 항상 [예/아니오])
  function showClipboardPopup(params) {
    return new Promise(function (resolve) {
      const popup = document.querySelector('[data-clipboard-popup]');
      if (!popup) { resolve(false); return; }
      const labelEl = popup.querySelector('[data-cb-label]');
      const valueEl = popup.querySelector('[data-cb-value]');
      const accept = popup.querySelector('[data-cb-accept]');
      const deny = popup.querySelector('[data-cb-deny]');

      if (labelEl) labelEl.textContent = params.label || '키';
      if (valueEl) valueEl.textContent = params.masked || '';

      popup.style.display = 'flex';

      function cleanup(approved) {
        popup.style.display = 'none';
        if (accept) accept.removeEventListener('click', onAccept);
        if (deny) deny.removeEventListener('click', onDeny);
        popup.removeEventListener('click', onBackdrop);
        resolve(approved);
      }
      function onAccept() { cleanup(true); }
      function onDeny() { cleanup(false); }
      function onBackdrop(e) {
        if (e.target === popup) cleanup(false);
      }
      if (accept) accept.addEventListener('click', onAccept);
      if (deny) deny.addEventListener('click', onDeny);
      popup.addEventListener('click', onBackdrop);
    });
  }

  // 키 종류 → input data-clipboard-target 매핑
  function fillInputByKind(market, kind, value) {
    if (!value) return false;
    const wizard = document.querySelector(`[data-micro-wizard="${market}"]`);
    if (!wizard) return false;
    const input = wizard.querySelector(`[data-clipboard-target="${kind}"]`);
    if (!input) return false;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // 시각 피드백
    input.classList.add('clipboard-filled');
    setTimeout(function () { input.classList.remove('clipboard-filled'); }, 1200);
    return true;
  }

  // ClipboardDetector 인스턴스 생성·시작
  function startClipboardDetector(market) {
    if (typeof window.ClipboardDetector === 'undefined') return null;
    if (microState[market].detector) return microState[market].detector;

    const detector = window.ClipboardDetector.create({
      market: market,
      pollOnVisibility: true,
      onPopup: function (params) {
        return showClipboardPopup(params);
      },
      onDetect: function (kind, value) {
        const filled = fillInputByKind(market, kind, value);
        if (filled) {
          showToast(`${window.ClipboardDetector.KIND_LABELS[kind] || kind}을(를) 자동 입력했어요`, 'success');
          // 입력 단계가 아니면 입력 단계로 이동
          if (microState[market].step < 3) setMicroStep(market, 3);
        }
      },
    });
    detector.start();
    microState[market].detector = detector;
    return detector;
  }

  function stopClipboardDetector(market) {
    const d = microState[market].detector;
    if (d) {
      d.stop();
      microState[market].detector = null;
    }
  }

  // 단계 4 — Progressive Validation 시각화
  function setValidatePhase(market, phase, status) {
    const wizard = document.querySelector(`[data-micro-wizard="${market}"]`);
    if (!wizard) return;
    const row = wizard.querySelector(`[data-mp-phase="${phase}"]`);
    const icon = wizard.querySelector(`[data-mp-phase-icon="${phase}"]`);
    if (!row) return;
    row.classList.remove('active', 'done', 'fail');
    if (status === 'active') {
      row.classList.add('active');
      if (icon) icon.innerHTML = '<i data-lucide="loader-2" style="width:18px;height:18px;"></i>';
    } else if (status === 'done') {
      row.classList.add('done');
      if (icon) icon.innerHTML = '<i data-lucide="check" style="width:18px;height:18px;"></i>';
    } else if (status === 'fail') {
      row.classList.add('fail');
      if (icon) icon.innerHTML = '<i data-lucide="x" style="width:18px;height:18px;"></i>';
    } else {
      if (icon) icon.innerHTML = '<i data-lucide="circle" style="width:18px;height:18px;"></i>';
    }
    initIcons();
  }

  function initStep2() {
    // ============ 쿠팡 ============
    const coupangCard = document.querySelector('[data-market="coupang"]');
    const coupangForm = document.querySelector('[data-form="coupang"]');
    const coupangVendor = document.querySelector('[data-input="coupangVendor"]');
    const coupangAccess = document.querySelector('[data-input="coupangAccess"]');
    const coupangSecret = document.querySelector('[data-input="coupangSecret"]');
    const coupangError = document.querySelector('[data-error="coupang"]');

    if (coupangCard) {
      coupangCard.addEventListener('click', function (e) {
        if (e.target.closest('.connect-form')) return;
        const isOpen = coupangForm.style.display !== 'none';
        coupangForm.style.display = isOpen ? 'none' : 'block';
        if (!isOpen) {
          setMicroStep('coupang', microState.coupang.step || 1);
          startClipboardDetector('coupang');
        } else {
          stopClipboardDetector('coupang');
        }
      });
    }

    // 단계 1 → 2: Deep Link 새 탭
    const coupangGo = document.querySelector('[data-action="mp-coupang-go"]');
    if (coupangGo) {
      coupangGo.addEventListener('click', async function (e) {
        e.stopPropagation();
        await openDeepLink('coupang.api_key_issue');
        setMicroStep('coupang', 2);
        startClipboardDetector('coupang');
      });
    }
    // 단계 2 → 3: 키 입력하기
    const coupangInput = document.querySelector('[data-action="mp-coupang-input"]');
    if (coupangInput) {
      coupangInput.addEventListener('click', function (e) {
        e.stopPropagation();
        setMicroStep('coupang', 3);
        // 입력 단계 진입 시 클립보드 한번 체크
        const d = microState.coupang.detector;
        if (d) d.trigger();
      });
    }
    // 이전 (모든 단계 공통)
    document.querySelectorAll('[data-action="mp-coupang-back"]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        const cur = microState.coupang.step;
        if (cur > 1) setMicroStep('coupang', cur - 1);
      });
    });

    // 단계 3 → 4 → 5: 검증
    const coupangSubmit = document.querySelector('[data-action="connect-coupang"]');
    if (coupangSubmit) {
      coupangSubmit.addEventListener('click', async function (e) {
        e.stopPropagation();
        if (coupangError) coupangError.textContent = '';

        const vendorId = (coupangVendor?.value || '').trim();
        const accessKey = (coupangAccess?.value || '').trim();
        const secretKey = (coupangSecret?.value || '').trim();

        // Phase 1: 형식 체크 (즉시)
        const isTestPattern = /^TEST_/.test(vendorId);
        if (!isTestPattern) {
          if (!vendorId || !/^A\d{8,12}$/.test(vendorId)) {
            if (coupangError) coupangError.textContent = 'Vendor ID는 A로 시작하는 9~13자리입니다.';
            return;
          }
          if (accessKey.length < 16 || secretKey.length < 16) {
            if (coupangError) coupangError.textContent = 'Access Key / Secret Key를 확인해주세요.';
            return;
          }
        }

        setMicroStep('coupang', 4);
        setValidatePhase('coupang', 1, 'active');

        coupangSubmit.disabled = true;
        try {
          // Phase 1 통과
          await new Promise(function (r) { setTimeout(r, 250); });
          setValidatePhase('coupang', 1, 'done');
          // Phase 2: API 인증
          setValidatePhase('coupang', 2, 'active');

          const res = await api('/api/connect-coupang', {
            method: 'POST',
            body: JSON.stringify({ vendorId, accessKey, secretKey }),
          });
          if (res.status === 200 && res.data?.success && res.data?.verified) {
            setValidatePhase('coupang', 2, 'done');
            // Phase 3: 권한 체크 (백그라운드)
            setValidatePhase('coupang', 3, 'active');

            state.markets.coupang = {
              connected: true,
              vendorId: res.data.vendorId,
              mock: Boolean(res.data.mock),
              scopeStatus: 'checking',
            };
            coupangCard.classList.add('connected');
            const status = coupangCard.querySelector('.choice-status');
            if (status) status.textContent = '연결 완료';
            const desc = coupangCard.querySelector('.choice-desc');
            if (desc) desc.textContent = `Vendor ${vendorId}` + (res.data.mock ? ' (베타 모킹)' : '');
            const scopeEl = coupangCard.querySelector('[data-scope-status]');
            if (scopeEl) {
              scopeEl.textContent = '판매 권한 확인 중...';
              scopeEl.style.display = 'block';
            }
            showToast('쿠팡 연결이 완료됐어요', 'success');

            // 단계 5로 이동 (권한 체크는 백그라운드 — 셀러 막지 않음)
            setTimeout(function () {
              setValidatePhase('coupang', 3, 'done');
              setMicroStep('coupang', 5);
              stopClipboardDetector('coupang');
              triggerPermissionCheck('coupang', coupangCard);
            }, 600);
          } else {
            setValidatePhase('coupang', 2, 'fail');
            const errObj = res.data?.error;
            if (errObj && typeof errObj === 'object') {
              if (coupangError) coupangError.textContent = errObj.cause || errObj.title || '연결에 실패했어요';
              showFriendlyError(errObj);
            } else {
              const msg = (typeof errObj === 'string' ? errObj : null) || '연결에 실패했습니다.';
              if (coupangError) coupangError.textContent = msg;
              showToast(msg, 'error');
            }
            // 입력 단계로 복귀
            setTimeout(function () { setMicroStep('coupang', 3); }, 1500);
          }
        } catch (err) {
          setValidatePhase('coupang', 2, 'fail');
          if (coupangError) coupangError.textContent = '네트워크 오류가 발생했습니다.';
          setTimeout(function () { setMicroStep('coupang', 3); }, 1500);
        } finally {
          coupangSubmit.disabled = false;
        }
      });
    }

    // ============ 네이버 ============
    const naverCard = document.querySelector('[data-market="naver"]');
    const naverForm = document.querySelector('[data-form="naver"]');
    const naverApp = document.querySelector('[data-input="naverApp"]');
    const naverSecret = document.querySelector('[data-input="naverSecret"]');
    const naverError = document.querySelector('[data-error="naver"]');

    if (naverCard) {
      naverCard.addEventListener('click', function (e) {
        if (e.target.closest('.connect-form')) return;
        const isOpen = naverForm.style.display !== 'none';
        naverForm.style.display = isOpen ? 'none' : 'block';
        if (!isOpen) {
          setMicroStep('naver', microState.naver.step || 1);
          startClipboardDetector('naver');
        } else {
          stopClipboardDetector('naver');
        }
      });
    }

    const naverGo = document.querySelector('[data-action="mp-naver-go"]');
    if (naverGo) {
      naverGo.addEventListener('click', async function (e) {
        e.stopPropagation();
        await openDeepLink('naver.app_register');
        setMicroStep('naver', 2);
        startClipboardDetector('naver');
      });
    }
    const naverInput = document.querySelector('[data-action="mp-naver-input"]');
    if (naverInput) {
      naverInput.addEventListener('click', function (e) {
        e.stopPropagation();
        setMicroStep('naver', 3);
        const d = microState.naver.detector;
        if (d) d.trigger();
      });
    }
    document.querySelectorAll('[data-action="mp-naver-back"]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        const cur = microState.naver.step;
        if (cur > 1) setMicroStep('naver', cur - 1);
      });
    });

    const naverSubmit = document.querySelector('[data-action="connect-naver"]');
    if (naverSubmit) {
      naverSubmit.addEventListener('click', async function (e) {
        e.stopPropagation();
        if (naverError) naverError.textContent = '';

        const applicationId = (naverApp?.value || '').trim();
        const applicationSecret = (naverSecret?.value || '').trim();

        const isTestPatternNaver = /^TEST_/.test(applicationId);
        if (!isTestPatternNaver) {
          if (applicationId.length < 8 || applicationSecret.length < 16) {
            if (naverError) naverError.textContent = 'Application ID / Secret을 확인해주세요.';
            return;
          }
        }

        setMicroStep('naver', 4);
        setValidatePhase('naver', 1, 'active');

        naverSubmit.disabled = true;
        try {
          await new Promise(function (r) { setTimeout(r, 250); });
          setValidatePhase('naver', 1, 'done');
          setValidatePhase('naver', 2, 'active');

          const res = await api('/api/connect-naver', {
            method: 'POST',
            body: JSON.stringify({ applicationId, applicationSecret }),
          });
          if (res.status === 200 && res.data?.success && res.data?.verified) {
            setValidatePhase('naver', 2, 'done');
            setValidatePhase('naver', 3, 'active');

            state.markets.naver = {
              connected: true,
              applicationIdMasked: res.data.applicationIdMasked,
              mock: Boolean(res.data.mock),
              scopeStatus: 'checking',
            };
            naverCard.classList.add('connected');
            const status = naverCard.querySelector('.choice-status');
            if (status) status.textContent = '연결 완료';
            const desc = naverCard.querySelector('.choice-desc');
            if (desc) desc.textContent = `${res.data.applicationIdMasked}` + (res.data.mock ? ' (베타 모킹)' : '');
            const scopeEl = naverCard.querySelector('[data-scope-status]');
            if (scopeEl) {
              scopeEl.textContent = '판매 권한 확인 중...';
              scopeEl.style.display = 'block';
            }
            showToast('네이버 연결이 완료됐어요', 'success');

            setTimeout(function () {
              setValidatePhase('naver', 3, 'done');
              setMicroStep('naver', 5);
              stopClipboardDetector('naver');
              triggerPermissionCheck('naver', naverCard);
            }, 600);
          } else {
            setValidatePhase('naver', 2, 'fail');
            const errObj = res.data?.error;
            if (errObj && typeof errObj === 'object') {
              if (naverError) naverError.textContent = errObj.cause || errObj.title || '연결에 실패했어요';
              showFriendlyError(errObj);
            } else {
              const msg = (typeof errObj === 'string' ? errObj : null) || '연결에 실패했습니다.';
              if (naverError) naverError.textContent = msg;
              showToast(msg, 'error');
            }
            setTimeout(function () { setMicroStep('naver', 3); }, 1500);
          }
        } catch (err) {
          setValidatePhase('naver', 2, 'fail');
          if (naverError) naverError.textContent = '네트워크 오류가 발생했습니다.';
          setTimeout(function () { setMicroStep('naver', 3); }, 1500);
        } finally {
          naverSubmit.disabled = false;
        }
      });
    }

    // Step2 다음
    const next = document.querySelector('[data-action="step2-next"]');
    if (next) {
      next.addEventListener('click', function () {
        if (!state.markets.coupang.connected && !state.markets.naver.connected) {
          showToast('마켓을 1개 이상 연결해주세요', 'error');
          return;
        }
        // 진행도 동기화 (백엔드)
        api('/api/signup-create-seller', {
          method: 'POST',
          body: JSON.stringify({
            businessNumber: state.business.businessNumber,
            ownerName: state.business.ownerName,
            phone: state.business.phone,
            birthDate: state.business.birthDate,
            storeName: state.business.storeName,
            email: null,
            marketingConsent: state.consent.marketing,
            privacyConsent: true,
            termsConsent: true,
            signupStep: 2,
          }),
        }).catch(function () { /* best-effort */ });
        // 마켓 위자드 detector 정리
        stopClipboardDetector('coupang');
        stopClipboardDetector('naver');
        showStep(3);
      });
    }
    const back = document.querySelector('[data-action="step2-back"]');
    if (back) back.addEventListener('click', function () {
      stopClipboardDetector('coupang');
      stopClipboardDetector('naver');
      showStep(1);
    });
  }

  // =====================================================
  // STEP 3: 말투 학습 (스킵 가능)
  // =====================================================
  function initStep3() {
    const greeting = document.querySelector('[data-input="toneGreeting"]');
    const closing = document.querySelector('[data-input="toneClosing"]');
    const recommendation = document.querySelector('[data-input="toneRecommendation"]');
    const next = document.querySelector('[data-action="step3-next"]');
    const back = document.querySelector('[data-action="step3-back"]');
    const skip = document.querySelector('[data-action="step3-skip"]');

    if (next) next.addEventListener('click', function () {
      state.tone.greeting = greeting?.value || '';
      state.tone.closing = closing?.value || '';
      state.tone.recommendation = recommendation?.value || '';
      state.tone.skipped = false;
      saveDraft();
      // 말투 샘플 저장 (best-effort)
      api('/api/signup-tone-samples', {
        method: 'POST',
        body: JSON.stringify({
          greeting: state.tone.greeting,
          closing: state.tone.closing,
          recommendation: state.tone.recommendation,
          skipped: false,
        }),
      }).catch(function () { /* */ });
      api('/api/signup-create-seller', {
        method: 'POST',
        body: JSON.stringify({
          businessNumber: state.business.businessNumber,
          ownerName: state.business.ownerName,
          phone: state.business.phone,
          birthDate: state.business.birthDate,
          storeName: state.business.storeName,
          email: null,
          marketingConsent: state.consent.marketing,
          privacyConsent: true,
          termsConsent: true,
          signupStep: 3,
        }),
      }).catch(function () { /* */ });
      showStep(4);
    });
    if (skip) skip.addEventListener('click', function () {
      state.tone.skipped = true;
      saveDraft();
      api('/api/signup-tone-samples', {
        method: 'POST',
        body: JSON.stringify({ skipped: true }),
      }).catch(function () { /* */ });
      showStep(4);
    });
    if (back) back.addEventListener('click', function () { showStep(2); });
  }

  // =====================================================
  // STEP 4: 첫 상품 등록 (UI만, 다음 스프린트에서 작동)
  // =====================================================
  function initStep4() {
    const next = document.querySelector('[data-action="step4-next"]');
    const back = document.querySelector('[data-action="step4-back"]');
    const skip = document.querySelector('[data-action="step4-skip"]');

    if (next) next.addEventListener('click', function () {
      api('/api/signup-create-seller', {
        method: 'POST',
        body: JSON.stringify({
          businessNumber: state.business.businessNumber,
          ownerName: state.business.ownerName,
          phone: state.business.phone,
          birthDate: state.business.birthDate,
          storeName: state.business.storeName,
          email: null,
          marketingConsent: state.consent.marketing,
          privacyConsent: true,
          termsConsent: true,
          signupStep: 4,
        }),
      }).catch(function () { /* */ });
      showStep(5);
    });
    if (back) back.addEventListener('click', function () { showStep(3); });
    if (skip) skip.addEventListener('click', function () { showStep(5); });
  }

  // =====================================================
  // STEP 5: 동의 + 완료
  // =====================================================
  function initStep5() {
    const allChk = document.querySelector('[data-consent="all"]');
    const termsChk = document.querySelector('[data-consent="terms"]');
    const privacyChk = document.querySelector('[data-consent="privacy"]');
    const refundChk = document.querySelector('[data-consent="refund"]');
    const openaiChk = document.querySelector('[data-consent="openai"]');
    const marketingChk = document.querySelector('[data-consent="marketing"]');
    const submit = document.querySelector('[data-action="step5-submit"]');
    const back = document.querySelector('[data-action="step5-back"]');
    const errEl = document.querySelector('[data-error="step5"]');

    const allBoxes = [termsChk, privacyChk, refundChk, openaiChk, marketingChk];

    function syncAll() {
      const all = allBoxes.every(function (b) { return b && b.checked; });
      if (allChk) allChk.checked = Boolean(all);
    }
    if (allChk) {
      allChk.addEventListener('change', function () {
        const v = allChk.checked;
        allBoxes.forEach(function (b) { if (b) b.checked = v; });
      });
    }
    allBoxes.forEach(function (el) {
      if (el) el.addEventListener('change', syncAll);
    });

    if (submit) submit.addEventListener('click', async function () {
      if (errEl) errEl.textContent = '';
      if (!termsChk?.checked || !privacyChk?.checked || !refundChk?.checked) {
        if (errEl) errEl.textContent = '필수 항목 (이용약관·개인정보처리방침·환불약관)에 모두 동의해주세요.';
        return;
      }
      state.consent.terms = true;
      state.consent.privacy = true;
      state.consent.refund = true;
      state.consent.openai = Boolean(openaiChk?.checked);
      state.consent.marketing = Boolean(marketingChk?.checked);

      submit.disabled = true;
      const orig = submit.innerHTML;
      submit.innerHTML = '<span class="spinner"></span> 처리 중...';

      try {
        const res = await api('/api/signup-create-seller', {
          method: 'POST',
          body: JSON.stringify({
            businessNumber: state.business.businessNumber,
            ownerName: state.business.ownerName,
            phone: state.business.phone,
            birthDate: state.business.birthDate,
            storeName: state.business.storeName,
            email: null,
            marketingConsent: state.consent.marketing,
            privacyConsent: true,
            termsConsent: true,
            refundConsent: true,
            openaiConsent: state.consent.openai,
            signupStep: 5,
          }),
        });
        if (res.status !== 200 || !res.data || !res.data.success) {
          if (errEl) errEl.textContent = res.data?.error || '가입 완료에 실패했습니다.';
          return;
        }
        state.token = res.data.token;
        try { localStorage.setItem(STORAGE_TOKEN, state.token); } catch (_) {}
        try { localStorage.setItem('lumi_seller_jwt', state.token); } catch (_) {}
        try { localStorage.setItem('lumi_seller_token', state.token); } catch (_) {}
        try { localStorage.setItem(STORAGE_USER, JSON.stringify(res.data.seller)); } catch (_) {}
        clearDraft();

        // /api/me 호출로 검증 (성공 시 done 화면)
        const meRes = await api('/api/me', { method: 'GET' });
        if (meRes.status === 200 && meRes.data?.success) {
          // OAuth 재방문 대비 sellerToken 3개 키 저장
          if (meRes.data.sellerToken) {
            try { localStorage.setItem('lumi_seller_jwt', meRes.data.sellerToken); } catch (_) {}
            try { localStorage.setItem('lumi_seller_token', meRes.data.sellerToken); } catch (_) {}
            try { localStorage.setItem('lumi_token', meRes.data.sellerToken); } catch (_) {}
          }
          // onboarding 완료 플래그를 Supabase user_metadata에 기록
          try {
            if (window.lumiSupa) {
              await window.lumiSupa.auth.updateUser({
                data: {
                  onboarded: true,
                  business_no: state.business.businessNumber,
                  business_name: meRes.data.seller.businessName || state.business.storeName,
                  representative: state.business.ownerName,
                  consent_terms: true,
                  consent_privacy: true,
                  consent_refund: true,
                  consent_openai: Boolean(state.consent.openai),
                  consent_marketing: Boolean(state.consent.marketing),
                  onboarded_at: new Date().toISOString(),
                  store_name: state.business.storeName,
                }
              });
            }
          } catch (_) {}
          showDone();
          // 셀러 이름 동적 표시
          const nameEl = document.querySelector('[data-done-name]');
          if (nameEl) nameEl.textContent = meRes.data.seller.ownerName + '님';
        } else {
          if (errEl) errEl.textContent = '인증 토큰 검증에 실패했습니다. 다시 로그인해주세요.';
        }
      } catch (e) {
        if (errEl) errEl.textContent = '네트워크 오류가 발생했습니다.';
      } finally {
        submit.disabled = false;
        submit.innerHTML = orig;
      }
    });
    if (back) back.addEventListener('click', function () { showStep(4); });
  }

  // =====================================================
  // 부트스트랩
  // =====================================================
  function ready() {
    initTheme();
    initIcons();
    loadDraft();
    initStep1();
    initStep2();
    initStep3();
    initStep4();
    initStep5();
    showStep(1); // STEP 1부터 시작 (OAuth 선택은 메인 인증 모달에서 처리)

    // Supabase OAuth 콜백: URL hash에 access_token이 있으면 세션 처리 후 STEP 1로
    if (window.lumiSupa && window.location.hash && window.location.hash.includes('access_token')) {
      window.lumiSupa.auth.getSession().then(function (result) {
        const session = result?.data?.session;
        if (session && session.access_token) {
          state.token = session.access_token;
          try { localStorage.setItem(STORAGE_TOKEN, session.access_token); } catch (_) {}
          // 이름·이메일·휴대폰 메타데이터 pre-fill
          const meta = session.user?.user_metadata || {};
          const fullName = meta.full_name || meta.name || '';
          if (fullName && !state.business.ownerName) state.business.ownerName = fullName;
          if (session.user?.email && !state.business.email) state.business.email = session.user.email;
          // 카카오 휴대폰: +821012345678 → 010-1234-5678 변환
          const rawPhone = meta.phone_number || meta.phone || '';
          if (rawPhone && !state.business.phone) {
            const normalized = rawPhone.replace(/^\+82/, '0').replace(/\D/g, '');
            state.business.phone = formatPhone(normalized);
            state.business.phoneFromOAuth = true;
          }
          // URL hash 정리
          try { window.history.replaceState({}, '', window.location.pathname); } catch (_) {}
          showStep(1);
        }
      }).catch(function () {});
      return;
    }

    // 카카오 콜백: ?token=... 파라미터로 돌아옴 (auth-kakao-callback이 /signup?token=... 로 전달 시)
    const params = new URLSearchParams(window.location.search);
    const oauthToken = params.get('token');
    if (oauthToken) {
      state.token = oauthToken;
      try { localStorage.setItem(STORAGE_TOKEN, oauthToken); } catch (_) {}
      // Supabase 세션에서 이메일·이름 pre-fill 시도
      if (window.lumiSupa) {
        window.lumiSupa.auth.getUser().then(function (res) {
          const u = res?.data?.user;
          if (u) {
            const meta = u.user_metadata || {};
            const fullName = meta.full_name || meta.name || '';
            if (fullName && !state.business.ownerName) state.business.ownerName = fullName;
            if (u.email && !state.business.email) state.business.email = u.email;
            // 카카오 휴대폰 prefill
            const rawPhone = meta.phone_number || meta.phone || '';
            if (rawPhone && !state.business.phone) {
              const normalized = rawPhone.replace(/^\+82/, '0').replace(/\D/g, '');
              state.business.phone = formatPhone(normalized);
              state.business.phoneFromOAuth = true;
            }
          }
        }).catch(function () {});
      }
      try { window.history.replaceState({}, '', window.location.pathname); } catch (_) {}
      showStep(1);
      return;
    }

    // Supabase OAuth 세션이 이미 있는 경우(메인에서 routeAfterAuth로 /signup으로 온 신규 가입자):
    // hash가 사라졌어도 supabase 세션은 localStorage에 살아있으므로 우선 체크 후 STEP 1로 자동 진행.
    if (window.lumiSupa) {
      window.lumiSupa.auth.getSession().then(function (r) {
        const session = r?.data?.session;
        if (session && session.access_token) {
          state.token = session.access_token;
          try { localStorage.setItem(STORAGE_TOKEN, session.access_token); } catch (_) {}
          const meta = session.user?.user_metadata || {};
          const fullName = meta.full_name || meta.name || '';
          if (fullName && !state.business.ownerName) state.business.ownerName = fullName;
          if (session.user?.email && !state.business.email) state.business.email = session.user.email;
          const rawPhone = meta.phone_number || meta.phone || '';
          if (rawPhone && !state.business.phone) {
            const normalized = rawPhone.replace(/^\+82/, '0').replace(/\D/g, '');
            state.business.phone = formatPhone(normalized);
            state.business.phoneFromOAuth = true;
          }
          // sellers 테이블에 seller-jwt 기반 진행도 있는지 확인 (재방문 가입자 복원용)
          api('/api/me', { method: 'GET' }).then(function (mr) {
            if (mr.status === 200 && mr.data?.success) {
              state.sellerId = mr.data.seller.id;
              if (mr.data.seller.signupCompleted) {
                showDone();
                const nameEl = document.querySelector('[data-done-name]');
                if (nameEl) nameEl.textContent = mr.data.seller.ownerName + '님';
              } else if (mr.data.seller.signupStep && mr.data.seller.signupStep >= 1 && mr.data.seller.signupStep <= 5) {
                showStep(Math.min(5, mr.data.seller.signupStep));
              } else {
                showStep(1);
              }
            } else {
              // Supabase 세션은 있지만 sellers 미생성 = 신규 가입자 정상 흐름
              showStep(1);
            }
          }).catch(function () { showStep(1); });
          return;
        }
        // Supabase 세션 없음 → 기존 seller-jwt 토큰 복원 시도
        let storedToken = null;
        try { storedToken = localStorage.getItem('lumi_seller_jwt') || localStorage.getItem('lumi_seller_token') || localStorage.getItem(STORAGE_TOKEN); } catch (_) {}
        if (storedToken) {
          state.token = storedToken;
          api('/api/me', { method: 'GET' }).then(function (r2) {
            if (r2.status === 200 && r2.data?.success) {
              state.sellerId = r2.data.seller.id;
              if (r2.data.seller.signupCompleted) {
                showDone();
                const nameEl = document.querySelector('[data-done-name]');
                if (nameEl) nameEl.textContent = r2.data.seller.ownerName + '님';
              } else if (r2.data.seller.signupStep && r2.data.seller.signupStep >= 1 && r2.data.seller.signupStep <= 5) {
                showStep(Math.min(5, r2.data.seller.signupStep));
              } else {
                showStep(1);
              }
            } else {
              state.token = null;
              try { localStorage.removeItem(STORAGE_TOKEN); } catch (_) {}
              window.location.replace('/?stay=1');
            }
          }).catch(function () { window.location.replace('/?stay=1'); });
        }
      }).catch(function () { /* 세션 조회 실패 — signup.html 진입 차단이 처리 */ });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready);
  } else {
    ready();
  }
})();
