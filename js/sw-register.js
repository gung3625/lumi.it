// sw-register.js — Service Worker 등록 (lumi.it.kr production 만).
// 사장님 두 번째 visit 부터 정적 asset 즉시 로드 (cache-first).
// HTML 은 network-first — 사장님 deploy 즉시 반영.
//
// localhost / preview 는 sw 등록 안 함 (개발 시 캐시 혼란 차단).

(function () {
  if (!('serviceWorker' in navigator)) return;
  var host = (location && location.hostname) || '';
  var isProd = host === 'lumi.it.kr' || host === 'www.lumi.it.kr';
  if (!isProd) return;

  // DOMContentLoaded 후 register — 첫 paint 안 방해
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function (err) {
      // 등록 실패 — 페이지 동작에 영향 X, 조용히 무시
      console.warn('[sw-register] 실패:', err && err.message);
    });
  });
})();
