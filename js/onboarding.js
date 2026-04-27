// =====================================================
// 루미 Sprint 1 — 가입 플로우 (5단계)
// API:
//   POST /api/business-verify
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

  // -------- 상태 --------
  const state = {
    step: 1,                // 1..5
    token: null,
    sellerId: null,
    business: {
      businessNumber: '',
      ownerName: '',
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
    const d = normalizeBusinessNumber(s);
    if (d.length !== 10) return s;
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
  function normalizePhone(s) { return String(s || '').replace(/\D/g, ''); }
  function formatPhone(s) {
    const d = normalizePhone(s);
    if (d.length === 11) return `${d.slice(0,3)}-${d.slice(3,7)}-${d.slice(7)}`;
    if (d.length === 10) return `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`;
    return s;
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
    if (label) label.textContent = `사장님 첫 쇼핑몰까지 5분 — ${state.step} / 5`;
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
    const birthInput = document.querySelector('[data-input="birthDate"]');
    const phoneInput = document.querySelector('[data-input="phone"]');
    const storeInput = document.querySelector('[data-input="storeName"]');
    const submit = document.querySelector('[data-action="step1-submit"]');
    const errEl = document.querySelector('[data-error="step1"]');

    if (bizInput) {
      bizInput.value = state.business.businessNumber || bizInput.value || '';
      bizInput.addEventListener('blur', function () {
        bizInput.value = formatBusinessNumber(bizInput.value);
      });
    }
    if (ownerInput) ownerInput.value = state.business.ownerName || ownerInput.value || '';
    if (birthInput) birthInput.value = state.business.birthDate || birthInput.value || '';
    if (phoneInput) {
      phoneInput.value = state.business.phone || phoneInput.value || '';
      phoneInput.addEventListener('blur', function () {
        phoneInput.value = formatPhone(phoneInput.value);
      });
    }
    if (storeInput) storeInput.value = state.business.storeName || storeInput.value || '';

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

        submit.disabled = true;
        const orig = submit.innerHTML;
        submit.innerHTML = '<span class="spinner"></span> 인증 중...';

        try {
          // 1) 사업자 인증 호출
          const verifyRes = await api('/api/business-verify', {
            method: 'POST',
            body: JSON.stringify({ businessNumber, ownerName, birthDate, phone }),
          });
          if (verifyRes.status !== 200 || !verifyRes.data || !verifyRes.data.success) {
            setError(verifyRes.data?.error || '인증에 실패했습니다. 잠시 후 다시 시도해주세요.');
            return;
          }

          state.business = { businessNumber, ownerName, birthDate, phone, storeName, verified: true };
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
              email: null,
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
          try { localStorage.setItem(STORAGE_USER, JSON.stringify(createRes.data.seller)); } catch (_) {}

          showToast('사업자 인증이 완료됐어요', 'success');
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

  // =====================================================
  // STEP 2: 마켓 OAuth (쿠팡 + 네이버)
  // =====================================================
  function initStep2() {
    // 쿠팡
    const coupangCard = document.querySelector('[data-market="coupang"]');
    const coupangForm = document.querySelector('[data-form="coupang"]');
    const coupangVendor = document.querySelector('[data-input="coupangVendor"]');
    const coupangAccess = document.querySelector('[data-input="coupangAccess"]');
    const coupangSecret = document.querySelector('[data-input="coupangSecret"]');
    const coupangSubmit = document.querySelector('[data-action="connect-coupang"]');
    const coupangError = document.querySelector('[data-error="coupang"]');

    if (coupangCard) {
      coupangCard.addEventListener('click', function (e) {
        if (e.target.closest('.connect-form') || e.target.closest('[data-action="connect-coupang"]')) return;
        const isOpen = coupangForm.style.display !== 'none';
        coupangForm.style.display = isOpen ? 'none' : 'block';
      });
    }

    if (coupangSubmit) {
      coupangSubmit.addEventListener('click', async function (e) {
        e.stopPropagation();
        if (coupangError) coupangError.textContent = '';

        const vendorId = (coupangVendor?.value || '').trim();
        const accessKey = (coupangAccess?.value || '').trim();
        const secretKey = (coupangSecret?.value || '').trim();

        // 베타 모킹 검증용 TEST_xxx 패턴은 클라이언트 형식 검증 bypass
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

        coupangSubmit.disabled = true;
        const orig = coupangSubmit.innerHTML;
        coupangSubmit.innerHTML = '<span class="spinner"></span> 검증 중...';

        try {
          const res = await api('/api/connect-coupang', {
            method: 'POST',
            body: JSON.stringify({ vendorId, accessKey, secretKey }),
          });
          if (res.status === 200 && res.data?.success && res.data?.verified) {
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
            coupangForm.style.display = 'none';
            showToast('쿠팡 연결이 완료됐어요', 'success');
            // Principle 1·2: 백그라운드 권한 검증
            triggerPermissionCheck('coupang', coupangCard);
          } else {
            const errObj = res.data?.error;
            if (errObj && typeof errObj === 'object') {
              if (coupangError) coupangError.textContent = errObj.cause || errObj.title || '연결에 실패했어요';
              showFriendlyError(errObj);
            } else {
              const msg = (typeof errObj === 'string' ? errObj : null) || '연결에 실패했습니다.';
              if (coupangError) coupangError.textContent = msg;
              showToast(msg, 'error');
            }
          }
        } catch (err) {
          if (coupangError) coupangError.textContent = '네트워크 오류가 발생했습니다.';
        } finally {
          coupangSubmit.disabled = false;
          coupangSubmit.innerHTML = orig;
        }
      });
    }

    // 네이버
    const naverCard = document.querySelector('[data-market="naver"]');
    const naverForm = document.querySelector('[data-form="naver"]');
    const naverApp = document.querySelector('[data-input="naverApp"]');
    const naverSecret = document.querySelector('[data-input="naverSecret"]');
    const naverSubmit = document.querySelector('[data-action="connect-naver"]');
    const naverError = document.querySelector('[data-error="naver"]');

    if (naverCard) {
      naverCard.addEventListener('click', function (e) {
        if (e.target.closest('.connect-form') || e.target.closest('[data-action="connect-naver"]')) return;
        const isOpen = naverForm.style.display !== 'none';
        naverForm.style.display = isOpen ? 'none' : 'block';
      });
    }

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

        naverSubmit.disabled = true;
        const orig = naverSubmit.innerHTML;
        naverSubmit.innerHTML = '<span class="spinner"></span> 검증 중...';

        try {
          const res = await api('/api/connect-naver', {
            method: 'POST',
            body: JSON.stringify({ applicationId, applicationSecret }),
          });
          if (res.status === 200 && res.data?.success && res.data?.verified) {
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
            naverForm.style.display = 'none';
            showToast('네이버 연결이 완료됐어요', 'success');
            triggerPermissionCheck('naver', naverCard);
          } else {
            const errObj = res.data?.error;
            if (errObj && typeof errObj === 'object') {
              if (naverError) naverError.textContent = errObj.cause || errObj.title || '연결에 실패했어요';
              showFriendlyError(errObj);
            } else {
              const msg = (typeof errObj === 'string' ? errObj : null) || '연결에 실패했습니다.';
              if (naverError) naverError.textContent = msg;
              showToast(msg, 'error');
            }
          }
        } catch (err) {
          if (naverError) naverError.textContent = '네트워크 오류가 발생했습니다.';
        } finally {
          naverSubmit.disabled = false;
          naverSubmit.innerHTML = orig;
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
        showStep(3);
      });
    }
    const back = document.querySelector('[data-action="step2-back"]');
    if (back) back.addEventListener('click', function () { showStep(1); });

    // 가이드 토글
    document.querySelectorAll('[data-guide-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        const target = btn.getAttribute('data-guide-toggle');
        const guide = document.querySelector(`[data-guide="${target}"]`);
        if (!guide) return;
        const open = guide.style.display !== 'none';
        guide.style.display = open ? 'none' : 'block';
        btn.textContent = open ? '키 발급 방법 보기' : '가이드 닫기';
      });
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
    const marketingChk = document.querySelector('[data-consent="marketing"]');
    const submit = document.querySelector('[data-action="step5-submit"]');
    const back = document.querySelector('[data-action="step5-back"]');
    const errEl = document.querySelector('[data-error="step5"]');

    function syncAll() {
      const all = termsChk?.checked && privacyChk?.checked && marketingChk?.checked;
      if (allChk) allChk.checked = Boolean(all);
    }
    if (allChk) {
      allChk.addEventListener('change', function () {
        const v = allChk.checked;
        if (termsChk) termsChk.checked = v;
        if (privacyChk) privacyChk.checked = v;
        if (marketingChk) marketingChk.checked = v;
      });
    }
    [termsChk, privacyChk, marketingChk].forEach(function (el) {
      if (el) el.addEventListener('change', syncAll);
    });

    if (submit) submit.addEventListener('click', async function () {
      if (errEl) errEl.textContent = '';
      if (!termsChk?.checked || !privacyChk?.checked) {
        if (errEl) errEl.textContent = '필수 항목 (이용약관, 개인정보 처리방침)에 동의해주세요.';
        return;
      }
      state.consent.terms = true;
      state.consent.privacy = true;
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
            signupStep: 5,
          }),
        });
        if (res.status !== 200 || !res.data || !res.data.success) {
          if (errEl) errEl.textContent = res.data?.error || '가입 완료에 실패했습니다.';
          return;
        }
        state.token = res.data.token;
        try { localStorage.setItem(STORAGE_TOKEN, state.token); } catch (_) {}
        try { localStorage.setItem(STORAGE_USER, JSON.stringify(res.data.seller)); } catch (_) {}
        clearDraft();

        // /api/me 호출로 검증 (성공 시 done 화면)
        const meRes = await api('/api/me', { method: 'GET' });
        if (meRes.status === 200 && meRes.data?.success) {
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
    showStep(1);

    // 기존 토큰이 있으면 /api/me로 진행도 복원 시도
    let storedToken = null;
    try { storedToken = localStorage.getItem(STORAGE_TOKEN); } catch (_) {}
    if (storedToken) {
      state.token = storedToken;
      api('/api/me', { method: 'GET' }).then(function (r) {
        if (r.status === 200 && r.data?.success) {
          state.sellerId = r.data.seller.id;
          if (r.data.seller.signupCompleted) {
            showDone();
            const nameEl = document.querySelector('[data-done-name]');
            if (nameEl) nameEl.textContent = r.data.seller.ownerName + '님';
          } else if (r.data.seller.signupStep && r.data.seller.signupStep >= 1 && r.data.seller.signupStep <= 5) {
            // 진행 중이었던 단계 복원
            const next = Math.min(5, r.data.seller.signupStep);
            showStep(next);
          }
        } else {
          // 토큰 무효 → 정리
          state.token = null;
          try { localStorage.removeItem(STORAGE_TOKEN); } catch (_) {}
        }
      }).catch(function () { /* offline / etc */ });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready);
  } else {
    ready();
  }
})();
