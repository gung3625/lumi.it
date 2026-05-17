// linktree-og.js — /r/{slug} 요청 시 매장별 OG meta 동적 inject (audit 후속).
//
// 흐름:
//   1) /r/{slug} request → slug 추출
//   2) Supabase 조회 (slug → store_name, store_desc, avatar_url)
//   3) origin /linktree.html fetch (정적 HTML)
//   4) HTML 안 head 에 <meta property="og:*"> 동적 inject
//   5) response — 클라이언트 JS 는 그대로 동작 (slug 클라이언트 path parse 후 /api/linktree fetch)
//
// 사장님이 인스타 bio 에 lumi.it.kr/r/<slug> 공유 → 카카오톡/메시지/인스타 미리보기 카드 시
//   매장 이름 + 설명 + 프로필 사진 표시. brand awareness ↑.
//
// 정적 페이지 (linktree.html) 는 그대로 — slug 못 찾거나 에러 시 정적 응답 그대로 fallback.

const SLUG_RE = /^[a-z0-9-]{3,30}$/;

function envGet(name) {
  try {
    if (typeof Netlify !== 'undefined' && Netlify.env && typeof Netlify.env.get === 'function') {
      return Netlify.env.get(name);
    }
  } catch (_) {}
  try {
    if (typeof Deno !== 'undefined' && Deno.env && typeof Deno.env.get === 'function') {
      return Deno.env.get(name);
    }
  } catch (_) {}
  return undefined;
}

function htmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default async (request, context) => {
  const url = new URL(request.url);
  // path: /r/{slug} (netlify.toml redirect 가 /linktree.html 로 바꿈 — Edge 는 /r/ 그대로 받음)
  const pathMatch = url.pathname.match(/^\/r\/([^/]+)\/?$/);
  if (!pathMatch) {
    return context.next();
  }
  const slug = decodeURIComponent(pathMatch[1] || '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    return context.next();
  }

  const SUPABASE_URL = envGet('SUPABASE_URL');
  const SUPABASE_SERVICE_ROLE_KEY = envGet('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return context.next();
  }

  // 1) Supabase 조회
  let seller = null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/sellers?linktree_slug=eq.${encodeURIComponent(slug)}&select=store_name,store_desc,avatar_url`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows) && rows[0]) seller = rows[0];
    }
  } catch (e) {
    // 조회 실패 — 정적 HTML 그대로 fallback
  }

  if (!seller) {
    return context.next();
  }

  // 2) 정적 linktree.html fetch
  let html;
  try {
    const originRes = await fetch(new URL('/linktree.html', url.origin), {
      headers: { 'accept': 'text/html' },
    });
    if (!originRes.ok) return context.next();
    html = await originRes.text();
  } catch (e) {
    return context.next();
  }

  // 3) OG meta 생성
  const storeName = (seller.store_name || 'lumi 매장').slice(0, 80);
  const storeDesc = (seller.store_desc || '루미(lumi) 매장 페이지 — 메뉴 · 예약 · 배달 · 지도 한곳에').slice(0, 200);
  const avatarUrl = seller.avatar_url || 'https://lumi.it.kr/assets/logo-wordmark.png';
  const pageUrl = `https://lumi.it.kr/r/${slug}`;

  const ogBlock =
    `\n  <!-- linktree dynamic OG (Edge inject) -->\n` +
    `  <meta property="og:type" content="website">\n` +
    `  <meta property="og:site_name" content="루미(lumi)">\n` +
    `  <meta property="og:locale" content="ko_KR">\n` +
    `  <meta property="og:url" content="${htmlEscape(pageUrl)}">\n` +
    `  <meta property="og:title" content="${htmlEscape(storeName)}">\n` +
    `  <meta property="og:description" content="${htmlEscape(storeDesc)}">\n` +
    `  <meta property="og:image" content="${htmlEscape(avatarUrl)}">\n` +
    `  <meta property="og:image:alt" content="${htmlEscape(storeName + ' 프로필')}">\n` +
    `  <meta name="twitter:card" content="summary">\n` +
    `  <meta name="twitter:title" content="${htmlEscape(storeName)}">\n` +
    `  <meta name="twitter:description" content="${htmlEscape(storeDesc)}">\n` +
    `  <meta name="twitter:image" content="${htmlEscape(avatarUrl)}">\n` +
    `  <title>${htmlEscape(storeName)} · 루미(lumi)</title>\n`;

  // 4) HTML <head> 안에 inject — 기존 <title> 도 store name 으로 교체 (중복 차단).
  //    정적 linktree.html 의 <title>루미(lumi)</title> 는 제거 후 새 title 로.
  let injected = html.replace(/<title>[^<]*<\/title>/i, ''); // 기존 title 제거
  injected = injected.replace(/<\/head>/i, ogBlock + '</head>');

  return new Response(injected, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // 공유 카드용 — crawler (kakao/facebook) 가 자주 fetch 함. 짧은 캐시 OK.
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
};

export const config = {
  path: '/r/*',
};
