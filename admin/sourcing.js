// admin/sourcing.js — 운영자 매입 분석 페이지.
// 토큰 있으면 '분석 실행' → /api/admin-sourcing-analysis (서버가 admin 검증).
// CSP 준수: 인라인 style 없음(클래스/textContent/안전 innerHTML만).
(function () {
  'use strict';

  function getToken() {
    try {
      return localStorage.getItem('lumi-auth')
        || localStorage.getItem('lumi_auth')
        || localStorage.getItem('seller_jwt') || '';
    } catch (_) { return ''; }
  }

  var $ = function (s) { return document.querySelector(s); };
  var intro = $('[data-intro]');
  var result = $('[data-result]');
  var loading = $('[data-loading]');
  var authErr = $('[data-auth-err]');
  var toastEl = $('[data-toast]');
  var toastTimer = null;

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('is-open');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-open'); }, 2600);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function showAuthErr(title, msg, showLogin) {
    if (intro) intro.hidden = true;
    if (result) result.hidden = true;
    if (loading) loading.hidden = true;
    var t = document.querySelector('[data-autherr-title]');
    var m = document.querySelector('[data-autherr-msg]');
    var l = document.querySelector('[data-login-link]');
    if (t && title) t.textContent = title;
    if (m && msg) m.textContent = msg;
    if (l) l.hidden = false; // 인증 실패 상태에선 항상 '로그인' 노출 (재로그인 가능)
    if (authErr) authErr.hidden = false;
  }

  var token = getToken();
  if (!token) { showAuthErr('로그인이 필요해요', '운영자 계정으로 루미에 로그인한 뒤 이용할 수 있어요.', true); return; }
  var authHeaders = { Authorization: 'Bearer ' + token };

  // 간단 마크다운 → HTML (제목/리스트/볼드/번호) — 추천 텍스트용. 인라인 style 미사용.
  function mdToHtml(md) {
    var lines = String(md || '').split('\n');
    var out = [];
    var inUl = false;
    function closeUl() { if (inUl) { out.push('</ul>'); inUl = false; } }
    lines.forEach(function (raw) {
      var html = esc(raw).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      if (/^\s*[-*]\s+/.test(raw)) {
        if (!inUl) { out.push('<ul>'); inUl = true; }
        out.push('<li>' + html.replace(/^\s*[-*]\s+/, '') + '</li>');
        return;
      }
      closeUl();
      if (/^\s*#{1,3}\s+/.test(raw)) { out.push('<h3>' + html.replace(/^\s*#{1,3}\s+/, '') + '</h3>'); return; }
      if (/^\s*\d+[).]/.test(raw)) { out.push('<p class="adm__rec-step">' + html + '</p>'); return; }
      if (html.trim() === '') return;
      out.push('<p>' + html + '</p>');
    });
    closeUl();
    return out.join('');
  }

  function render(d) {
    $('[data-meta-season]').textContent = (d.year || '') + '년 ' + (d.month || '') + '월 · ' + (d.season || '');
    $('[data-meta-when]').textContent = '분석: ' + (d.generatedAt || '');
    var body = $('[data-kw-body]');
    var table = $('[data-kw-table]');
    var empty = $('[data-kw-empty]');
    if (d.keywords && d.keywords.length) {
      body.innerHTML = d.keywords.map(function (k) {
        return '<tr><td>' + esc(k.keyword) + '</td><td class="num">'
          + (k.monthlyTotal || 0).toLocaleString() + '</td><td>' + esc(k.competition || '-') + '</td></tr>';
      }).join('');
      table.hidden = false; empty.hidden = true;
    } else {
      table.hidden = true; empty.hidden = false;
    }
    $('[data-rec]').innerHTML = d.recommendation
      ? mdToHtml(d.recommendation)
      : '<p class="adm__empty">추천을 생성하지 못했어요. 다시 시도해주세요.</p>';
    intro.hidden = true; result.hidden = false;
  }

  var running = false;
  function run() {
    if (running) return;
    running = true;
    loading.hidden = false; result.hidden = true; intro.hidden = true;
    fetch('/api/admin-sourcing-analysis', { headers: authHeaders })
      .then(function (r) {
        return r.json().then(function (j) { return { status: r.status, ok: r.ok, j: j }; },
          function () { return { status: r.status, ok: r.ok, j: {} }; });
      })
      .then(function (res) {
        running = false; loading.hidden = true;
        if (res.status === 401) { showAuthErr('로그인이 필요해요', '세션이 만료됐어요. 다시 로그인해주세요.', true); return; }
        if (res.status === 403) { showAuthErr('운영자 권한이 없어요', '이 계정은 운영자가 아니에요. (로그인 계정을 확인해주세요)', false); return; }
        if (!res.ok) { intro.hidden = false; toast((res.j && res.j.error) || '분석에 실패했어요'); return; }
        render(res.j);
      })
      .catch(function () { running = false; loading.hidden = true; intro.hidden = false; toast('네트워크 오류. 다시 시도해주세요.'); });
  }

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-run]')) run();
  });
})();
