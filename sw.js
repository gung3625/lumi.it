// sw.js — lumi Service Worker (audit 후속, 전체 최적화).
//
// 전략 (사장님 device 두 번째 visit 부터 즉시 로드):
// - 정적 asset (/css/*, /js/*, /assets/*) → cache-first + 백그라운드 갱신
// - HTML (.html, /, /dashboard 등) → network-first (사장님 새 변경 즉시 반영)
// - API (/api/*, /.netlify/*) → sw 우회 (그대로 fetch — 캐시 X)
//
// 캐시 bump: CACHE_VERSION 올리면 옛 cache 삭제 + 새로 받음.
// 사장님 deploy 시 sw 코드 변경되면 자동으로 새 sw 활성화 (skipWaiting).

// v34: 경쟁 카피 분석 적용 — hero diff/chips, 대행사 비교, 독점 배지, 신뢰 카운터/후기, 자는 동안 카피.
const CACHE_VERSION = 'lumi-v34';
const STATIC_CACHE  = `${CACHE_VERSION}-static`;

const STATIC_RE = /\.(css|js|woff2?|ttf|otf|png|jpg|jpeg|webp|svg|ico|gif)$/i;
const API_RE    = /\/(api|\.netlify\/functions|r)\//;

self.addEventListener('install', (event) => {
  // 즉시 활성화 — waiting state skip
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 옛 버전 캐시 삭제
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k.startsWith('lumi-') && !k.startsWith(CACHE_VERSION)).map(k => caches.delete(k))
    );
    // 모든 클라이언트 즉시 sw 사용
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 외부 origin (jsdelivr / supabase / kakao) — sw 우회
  if (url.origin !== self.location.origin) return;
  // API call — sw 우회 (실시간 데이터 보존)
  if (API_RE.test(url.pathname)) return;

  // 정적 asset — cache-first + 백그라운드 갱신
  if (STATIC_RE.test(url.pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // HTML 또는 기타 — network-first (새 변경 즉시 반영 + offline fallback)
  event.respondWith(networkFirst(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req);
  // 백그라운드 갱신 (stale-while-revalidate)
  const fetchPromise = fetch(req).then((res) => {
    if (res && res.status === 200) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || fetchPromise || fetch(req);
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    // HTML 도 캐시에 두기 (offline fallback 용) — 단 sub-resource 우선 cache-first.
    if (res && res.status === 200) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch (e) {
    // 오프라인 — 캐시에서 fallback
    const cache = await caches.open(STATIC_CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;
    // 최종 fallback — 간단한 offline 안내
    return new Response(
      '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>오프라인</title></head>' +
      '<body style="font-family:sans-serif;padding:40px;text-align:center;">' +
      '<h1>인터넷 연결 없음</h1><p>연결 복구 후 새로고침 해주세요.</p>' +
      '</body></html>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}
