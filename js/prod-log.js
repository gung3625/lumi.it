// prod-log.js — production (lumi.it.kr) 환경에서 console.log/.debug 무력화.
// console.error / console.warn 은 유지 (사장님 문제 진단·디버깅).
// 사장님 메모리 [feedback_production_grade] 적용 — 정식 운영 환경 logging cleanup (audit #7).
//
// 로드: 모든 HTML 의 head 에 tokens.css/base.css 다음에 link.
//   <script src="/js/prod-log.js"></script>
//
// localhost / Netlify deploy preview 에서는 그대로 유지 (개발·디버그 보존).
(function () {
  try {
    var host = (location && location.hostname) || '';
    var isProd = host === 'lumi.it.kr' || host === 'www.lumi.it.kr';
    if (isProd) {
      var noop = function () {};
      console.log = noop;
      console.debug = noop;
      console.info = noop;
      // console.warn / console.error 는 유지 — 사장님 문제 발생 시 source 추적 가능.
    }
  } catch (_) { /* console 객체 자체가 없으면 무시 */ }
})();
