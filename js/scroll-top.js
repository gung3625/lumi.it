// scroll-top.js — 새로고침 시 항상 페이지 최상단으로 (audit #1: CSP unsafe-inline 제거).
// hash 가 있으면 브라우저 기본 앵커 스크롤 보존 (settings.html 등 deep link 호환).
// 기존: 페이지별 head 의 1~2줄 inline script (`<script data-scroll-top-on-reload>...`).
// 새: 외부 .js — CSP 'self' 만으로 동작 (unsafe-inline 제거 가능).
if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}
if (!location.hash) {
  window.scrollTo(0, 0);
}
window.addEventListener('DOMContentLoaded', function () {
  if (!location.hash) {
    window.scrollTo(0, 0);
    return;
  }
  var el = document.getElementById(location.hash.slice(1));
  if (el) el.scrollIntoView({ block: 'start' });
});
