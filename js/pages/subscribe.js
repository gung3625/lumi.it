// subscribe.js — 구독/결제 페이지 로직.
// 인증(seller-jwt) → /api/get-subscription 으로 상태 렌더 → 구독(payapp-subscribe→payurl)·해지(payapp-cancel).
// CSP 준수: 인라인 없음, style 은 classList 로만 토글.
(function () {
  'use strict';

  function getToken() {
    try {
      return localStorage.getItem('lumi-auth')
        || localStorage.getItem('lumi_auth')
        || localStorage.getItem('seller_jwt') || '';
    } catch (_) { return ''; }
  }

  var token = getToken();
  if (!token) { location.replace('/'); return; }
  var authHeaders = { Authorization: 'Bearer ' + token };

  var actions = document.querySelector('[data-sub-actions]');
  var badge = document.querySelector('[data-sub-badge]');
  var nextBillingEl = document.querySelector('[data-next-billing]');
  var phoneWrap = document.querySelector('[data-phone-wrap]');
  var toastEl = document.querySelector('[data-toast]');
  var toastTimer = null;

  function toast(msg, ms) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('is-open');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-open'); }, ms || 2400);
  }

  function showState(name) {
    if (!actions) return;
    actions.querySelectorAll('[data-state]').forEach(function (el) {
      el.hidden = (el.getAttribute('data-state') !== name);
    });
  }

  function setBadge(text, variant) {
    if (!badge) return;
    if (!text) { badge.hidden = true; return; }
    badge.textContent = text;
    badge.className = 'sub-badge' + (variant ? ' is-' + variant : '');
    badge.hidden = false;
  }

  function fmtDate(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return '';
    return m[1] + '년 ' + Number(m[2]) + '월 ' + Number(m[3]) + '일';
  }

  function render(data) {
    var status = (data && data.status) || 'none';
    if (status === 'active') {
      setBadge('구독 중', 'active');
      var d = fmtDate(data.nextBillingDate);
      if (nextBillingEl) nextBillingEl.textContent = d ? ('다음 결제일 ' + d) : '매월 자동 결제 중';
      showState('active');
    } else if (status === 'pending') {
      setBadge('결제 진행 중', 'pending');
      showState('pending');
    } else if (status === 'past_due') {
      setBadge('결제 실패', 'pastdue');
      showState('pastdue');
    } else {
      setBadge('', null);
      showState('subscribe');
    }
  }

  function load() {
    showState('loading');
    fetch('/api/get-subscription', { headers: authHeaders })
      .then(function (r) {
        if (r.status === 401) { location.replace('/'); return null; }
        return r.json();
      })
      .then(function (data) { if (data) render(data); })
      .catch(function () { toast('상태를 불러오지 못했어요. 새로고침 해주세요.'); showState('subscribe'); });
  }

  function busy(btn, on) {
    if (!btn) return;
    btn.disabled = on;
    btn.classList.toggle('is-busy', on);
  }

  function startSubscribe(phone) {
    var btns = actions.querySelectorAll('[data-subscribe], [data-phone-submit]');
    btns.forEach(function (b) { busy(b, true); });
    var payload = phone ? { phone: phone } : {};
    fetch('/api/payapp-subscribe', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders),
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }, function () { return { ok: r.ok, status: r.status, j: {} }; }); })
      .then(function (res) {
        if (res.ok && res.j && res.j.payurl) {
          location.href = res.j.payurl; // PayApp 결제창으로 이동 (카드 등록 + 최초 승인)
          return;
        }
        btns.forEach(function (b) { busy(b, false); });
        if (res.j && res.j.code === 'phone_required') {
          if (phoneWrap) phoneWrap.hidden = false;
          toast('결제 안내를 받을 휴대폰 번호를 입력해주세요.');
          return;
        }
        if (res.status === 401) { location.replace('/'); return; }
        if (res.status === 409) { toast('이미 구독 중이에요.'); load(); return; }
        toast((res.j && res.j.error) || '구독 시작에 실패했어요. 잠시 후 다시 시도해주세요.');
      })
      .catch(function () {
        btns.forEach(function (b) { busy(b, false); });
        toast('네트워크 오류. 다시 시도해주세요.');
      });
  }

  function cancelSubscribe() {
    if (!window.confirm('구독을 해지하시겠어요? 다음 청구부터 결제되지 않습니다.')) return;
    var btn = actions.querySelector('[data-cancel]');
    busy(btn, true);
    fetch('/api/payapp-cancel', { method: 'POST', headers: authHeaders })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }, function () { return { ok: r.ok, status: r.status, j: {} }; }); })
      .then(function (res) {
        busy(btn, false);
        if (res.ok) {
          toast(res.j && res.j.warning ? res.j.warning : '구독이 해지됐어요.', 3200);
          load();
          return;
        }
        if (res.status === 401) { location.replace('/'); return; }
        toast((res.j && res.j.error) || '해지에 실패했어요. 잠시 후 다시 시도해주세요.');
      })
      .catch(function () { busy(btn, false); toast('네트워크 오류. 다시 시도해주세요.'); });
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-subscribe], [data-cancel], [data-phone-submit], [data-logout]');
    if (!t) return;
    if (t.hasAttribute('data-logout')) {
      try { ['lumi-auth', 'lumi_auth', 'seller_jwt', 'lumi_refresh'].forEach(function (k) { localStorage.removeItem(k); }); } catch (_) {}
      location.replace('/');
      return;
    }
    if (t.hasAttribute('data-cancel')) { cancelSubscribe(); return; }
    if (t.hasAttribute('data-phone-submit')) {
      var inp = document.querySelector('[data-phone-input]');
      var phone = ((inp && inp.value) || '').replace(/[^0-9]/g, '');
      if (!/^010\d{7,8}$/.test(phone)) { toast('올바른 휴대폰 번호를 입력해주세요.'); return; }
      startSubscribe(phone);
      return;
    }
    if (t.hasAttribute('data-subscribe')) { startSubscribe(null); return; }
  });

  load();
})();
