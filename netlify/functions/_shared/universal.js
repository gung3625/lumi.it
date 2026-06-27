// 범용 상품 파서 + Bright Data Web Unlocker.
// 봇차단 사이트(쿠팡/스마트스토어/알리/G마켓/옥션 등): Web Unlocker로 HTML을 받아
// og / JSON-LD(Product) / 이미지에서 상품명·이미지를 추출한다. 사이트 무관.
//   product = { title, images, descImages, spec, options, keywords, categoryTree }
// 상세정보(스펙/옵션)는 사이트마다 구조가 달라, 상품명+이미지 기반으로 시작하고
// 이미지는 generate-detail의 비전 분석(analyzeProductImages)으로 보완한다.

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

function abs(u, base) {
  if (!u) return '';
  if (u.indexOf('//') === 0) return 'https:' + u;
  if (/^https?:\/\//i.test(u)) return u;
  try { return new URL(u, base).href; } catch (_) { return u; }
}

// Bright Data Web Unlocker — URL을 주면 봇차단을 뚫은 raw HTML을 돌려준다.
async function fetchViaUnlocker(url) {
  const key = process.env.BRIGHTDATA_API_KEY;
  const zone = process.env.BRIGHTDATA_ZONE;
  if (!key || !zone) throw new Error('이 사이트는 링크로 직접 가져올 수 없어요(봇 차단). 아래 "이미지 업로드"에서 상품 페이지를 캡처해 올리면 만들 수 있어요.');
  const res = await fetch('https://api.brightdata.com/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ zone, url, format: 'raw' }),
  });
  if (!res.ok) throw new Error('상품 페이지를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요');
  return await res.text();
}

// HTML → 상품 정보. og:title/og:image 우선, JSON-LD(Product) 보강.
function parseUniversalProduct(html, baseUrl) {
  const meta = (key) => {
    let m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + key + '["\'][^>]+content=["\']([^"\']*)["\']', 'i'));
    if (!m) m = html.match(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']' + key + '["\']', 'i'));
    return m ? m[1] : '';
  };

  let title = meta('og:title') || (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '';
  const imgs = [];
  let mm;
  const reFwd = /<meta[^>]+(?:property|name)=["']og:image(?::secure_url|:url)?["'][^>]+content=["']([^"']*)["']/gi;
  while ((mm = reFwd.exec(html))) imgs.push(mm[1]);
  const reBwd = /<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']og:image["']/gi;
  while ((mm = reBwd.exec(html))) imgs.push(mm[1]);

  // JSON-LD Product
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const b of blocks) {
    try {
      const json = JSON.parse(b.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim());
      const arr = Array.isArray(json) ? json : (json['@graph'] ? json['@graph'] : [json]);
      for (const o of arr) {
        const t = o && o['@type'];
        const ts = Array.isArray(t) ? t.join(',') : String(t || '');
        if (/Product/i.test(ts)) {
          if (o.name && !title) title = o.name;
          if (o.image) {
            const im = Array.isArray(o.image) ? o.image : [o.image];
            im.forEach((x) => imgs.push(typeof x === 'string' ? x : (x && x.url)));
          }
        }
      }
    } catch (_) {}
  }

  const SKIP = /(meta_property|\/logo|noimage|no_image|default_|blank\.|placeholder|favicon|sprite)/i;
  const images = [...new Set(imgs.filter(Boolean).map((u) => abs(u, baseUrl)))].filter((u) => !SKIP.test(u)).slice(0, 8);
  title = decode(title).slice(0, 120);
  if (!title || !images.length) {
    throw new Error('상품 정보를 찾지 못했습니다. 상품 상세 페이지 링크인지 확인해 주세요');
  }
  // 상세 설명 영역의 <img>(상품 상세 컷)까지 추출 — 대표만으론 정보 빈약. lazy(data-src) 포함 + 노이즈 필터.
  const bodyImgs = [];
  let im2; const reImg = /<img[^>]+(?:data-src|data-original|src)=["']([^"']+)["']/gi;
  while ((im2 = reImg.exec(html))) bodyImgs.push(im2[1]);
  const descImages = [...new Set([...images, ...bodyImgs.map((u) => abs(u, baseUrl))])]
    .map((u) => u.replace(/^\/\//, 'https://'))
    .filter((u) => /^https?:/i.test(u) && !SKIP.test(u) && !/icon|btn_|banner|bnr|sprite|_\d{1,3}x\d{1,3}\./i.test(u) && /\.(?:jpe?g|png|webp|gif)(?:[?#]|$)/i.test(u))
    .slice(0, 12);
  return { title, images, descImages, spec: {}, options: [], keywords: [], categoryTree: [] };
}

module.exports = { fetchViaUnlocker, parseUniversalProduct };
