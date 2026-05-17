// error-track.js — 사장님 device JS 에러 자동 수집 (audit 후속).
//
// window.onerror + unhandledrejection → POST /api/error-log.
// 로그인 사장님 token 도 같이 보내서 seller_id 바인딩 (DB).
//
// 보안 / 안정성:
// - lumi.it.kr 도메인에서만 활성 (localhost / preview 는 console 그대로 — 디버그 보존).
// - dedupe: 같은 에러 message+stack 1분 내 1번만 보냄 (production 페이지 새로고침마다 같은 에러 spam 차단).
// - max 10건 / 페이지 (악의적 무한 에러 spam 차단).
// - 자체 에러 catch — POST 실패해도 무한 loop 없게.
// - 외부 origin script 에러 (CORS) 는 message="Script error." 만 들어옴 — 자동 무시.

(function () {
  if (window.__lumiErrorTrackInstalled) return;
  window.__lumiErrorTrackInstalled = true;

  var host = (location && location.hostname) || '';
  var isProd = host === 'lumi.it.kr' || host === 'www.lumi.it.kr';
  if (!isProd) return;

  var sent = new Map();   // dedupe: key → expiresAt (1분)
  var sentCount = 0;
  var MAX_PER_PAGE = 10;
  var DEDUPE_TTL_MS = 60 * 1000;

  function getAuthToken() {
    try {
      return localStorage.getItem('lumi-auth')
        || localStorage.getItem('lumi_auth')
        || localStorage.getItem('seller_jwt')
        || '';
    } catch (_) { return ''; }
  }

  function shouldSend(message, stack) {
    if (sentCount >= MAX_PER_PAGE) return false;
    if (!message || message === 'Script error.') return false;
    var key = (message + '|' + (stack || '')).slice(0, 200);
    var now = Date.now();
    var exp = sent.get(key);
    if (exp && exp > now) return false;
    sent.set(key, now + DEDUPE_TTL_MS);
    // 정리
    if (sent.size > 50) {
      for (var entry of sent) {
        if (entry[1] < now) sent.delete(entry[0]);
      }
    }
    return true;
  }

  function send(payload) {
    if (!shouldSend(payload.message, payload.stack)) return;
    sentCount++;
    try {
      var token = getAuthToken();
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      // navigator.sendBeacon 은 unload 시에도 보내짐 — 단 Authorization 헤더 안 됨.
      // fetch keepalive 사용 — 동등 효과 + 헤더 지원.
      fetch('/api/error-log', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(function () { /* 자체 에러 무시 — 무한 loop 차단 */ });
    } catch (_) { /* keepalive 미지원 등 — 조용히 무시 */ }
  }

  window.addEventListener('error', function (ev) {
    // resource load 에러 (img/script 404 등) 는 ev.error 없고 target 만. 제외.
    if (!ev.message || !ev.error) return;
    send({
      message:   String(ev.message),
      stack:     ev.error && ev.error.stack ? String(ev.error.stack) : '',
      url:       String(ev.filename || location.href),
      line:      ev.lineno || 0,
      col:       ev.colno || 0,
      userAgent: navigator.userAgent,
    });
  });

  window.addEventListener('unhandledrejection', function (ev) {
    var reason = ev.reason;
    var message = '';
    var stack = '';
    if (reason instanceof Error) {
      message = reason.message || String(reason);
      stack = reason.stack || '';
    } else if (typeof reason === 'string') {
      message = reason;
    } else {
      try { message = JSON.stringify(reason); } catch (_) { message = String(reason); }
    }
    send({
      message:   '[unhandledrejection] ' + message,
      stack:     stack,
      url:       location.href,
      userAgent: navigator.userAgent,
    });
  });
})();
