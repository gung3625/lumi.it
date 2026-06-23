// 도매토피아(dometopia.com) 상품 파서.
// 봇차단이 없어 서버에서 직접 fetch → HTML 파싱. 도매꾹 getItemView와 같은 형식 반환.
//   { title, images, descImages, spec, options, keywords, categoryTree }
// 상세정보 테이블은 안내 템플릿이 섞여 정밀 파싱이 어려워, 상품명+이미지 기반으로 시작하고
// 이미지는 generate-detail의 비전 분석(analyzeProductImages)으로 보완한다.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

// 상품번호(no) 추출: /goods/view?no=104480 형태.
function parseNo(url) {
  return (String(url).match(/[?&]no=(\d+)/) || [])[1] || null;
}

async function getDometopiaItem(no) {
  const url = `https://dometopia.com/goods/view?no=${encodeURIComponent(no)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('도매토피아 상품을 불러오지 못했습니다. 링크를 확인해 주세요');
  const html = await res.text();

  const tm = html.match(/og:title"\s+content="([^"]*)"/i);
  const title = decode(tm && tm[1]);
  if (!title || /대한민국 최대 도매 쇼핑몰/.test(title)) {
    throw new Error('상품 정보를 찾지 못했습니다. 도매토피아 상품 상세 링크인지 확인해 주세요');
  }

  // 상품 이미지(vipweb/goods_img CDN). 썸네일·아이콘 제외, large/view 우선.
  const all = [...new Set((html.match(/https?:\/\/[^"'\s)]*(?:vipweb|goods_img|dmtusr)[^"'\s)]*\.(?:jpe?g|png)/gi) || []))];
  const big = all.filter((u) => /(large|view)/i.test(u) && !/thumb/i.test(u));
  const images = (big.length ? big : all).slice(0, 8);

  return {
    title,
    images,
    descImages: images,
    spec: {},
    options: [],
    keywords: [],
    categoryTree: [],
  };
}

module.exports = { getDometopiaItem, parseNo };
