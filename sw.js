// sw.js — lumi Service Worker (audit 후속, 전체 최적화).
//
// 전략 (사장님 device 두 번째 visit 부터 즉시 로드):
// - 정적 asset (/css/*, /js/*, /assets/*) → cache-first + 백그라운드 갱신
// - HTML (.html, /, /dashboard 등) → network-first (사장님 새 변경 즉시 반영)
// - API (/api/*, /.netlify/*) → sw 우회 (그대로 fetch — 캐시 X)
//
// 캐시 bump: CACHE_VERSION 올리면 옛 cache 삭제 + 새로 받음.
// 사장님 deploy 시 sw 코드 변경되면 자동으로 새 sw 활성화 (skipWaiting).

// v43: hero CTA 칩 "신용카드 안 받음" 제거 (사장님 지시).
// v44: 시그니처 그라데이션 가입 후 5페이지 침투 (디자인 sprint R1)
// v45: 디자인 R2 — paper alpha 2배, 적용 7→3곳 축소, 모바일 정적 시그니처 신설, hand-drawn underline 어법 1종 추가, 핫픽스 6건
// v46: 디자인 R3 — wavy 어법 3곳 확산 (trends meta-cat / history tab / dashboard scheduled-card), 좌측 라인 4px/0.85, SVG path 정렬, besttime 약화
// v49: hero__sub word-break keep-all + weight 통일 (사장님 지적: 단어 잘림 + weight 격차).
// v50: /pricing 요금제 페이지 신설 (비즈니스 심사용 — 베타 무료 + Free/Pro 2단).
// v51: index 페이지에도 요금제 섹션 추가 (benefit 다음 — pricing.css 카드 재사용).
// v52: 전체 퀄리티 업그레이드 — register-product/beta/signup/linktree/guide-ig 시그니처 침투
// v53: 퀄업 R2 — linktree ring 버그 fix, wavy offset 통일, dropzone/guide 가시성, glow 중첩 해소
// v54: linktree ring 매직컬러 #FF8FA3 → --signature-1 토큰화 (시그니처 정색 일치)
// v55: 토스급 인터랙션 — 전역 햅틱, 완료 SVG 체크 draw, 로딩 개선, 스켈레톤 확산, spring
// v57: 트렌드 네이버 소스 단일화 (youtube/ig/news 제거, tier 검색량+velocity 2축)
const CACHE_VERSION = 'lumi-v57';
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
