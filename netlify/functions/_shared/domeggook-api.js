'use strict';
// 도매꾹 OpenAPI getItemList — 키워드 검색 → [{name, w}] (coupang-scan domeSample과 동일 형태).
// 멀티 도매처 비교용 2차 매입가 소스. 스크래핑 아님(공개 API라 도매토피아보다 안정적).
//
// 환경변수: DOMEGGOOK_API_KEY (domeggook.com 로그인 > API Key 무료 발급, 아이디당 5개).
//   검색(getItemList)은 Open API라 사업자 인증 불필요. 미설정 시 빈 배열 → 도매토피아만 (graceful).
//
// 공식 문서 검증(openapi.domeggook.com): v4.1, GET https://domeggook.com/ssl/api/
//   응답 = { header, list: { item: [{ title, price, unitQty, url, ... }] } }
//   아래 파싱은 j.list.item[].title/.price 를 잡음(공식 구조). 다른 경로도 방어적으로 시도.

async function domeggookSearch(kw) {
  const key = process.env.DOMEGGOOK_API_KEY;
  if (!key || !kw) return [];
  const url = 'https://domeggook.com/ssl/api/?ver=4.1&mode=getItemList&aid=' + encodeURIComponent(key)
    + '&market=dome&om=json&sz=20&pg=1&so=rd&kw=' + encodeURIComponent(kw);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const j = await res.json().catch(() => null);
    if (!j) return [];
    // 방어적 탐색: 응답 구조가 확정 전이라 가능한 위치를 순서대로 시도
    let list = (j.domeggook && j.domeggook.list && j.domeggook.list.item)
      || (j.list && j.list.item) || j.items || j.list || [];
    if (!Array.isArray(list)) list = [list];
    return list.map((it) => {
      const name = String(it.title || it.name || it.itemTitle || it.subject || '').trim();
      const w = parsePrice(it.price || it.salePrice || it.lowestPrice || it.unitPrice || it.amount);
      return { name: name.slice(0, 40), w };
    }).filter((x) => x.name && x.w);
  } catch (_) { return []; }
}

// 가격 파싱 — 단일("15000") 또는 도매 수량티어("3+15000|30+14800|100+14500") → 최소수량 단가 반환.
function parsePrice(p) {
  if (p == null) return null;
  const s = String(p);
  if (s.indexOf('+') >= 0) return Number(s.split('|')[0].split('+').pop()) || null;
  return Number(s) || null;
}

// 상품 상세 — getItemView(4.6). 제목·키워드·도매가·MOQ·카테고리·이미지 반환. 키 없으면 null.
async function getItemView(no) {
  const key = process.env.DOMEGGOOK_API_KEY;
  if (!key || !no) return null;
  const url = 'https://domeggook.com/ssl/api/?ver=4.6&mode=getItemView&aid=' + encodeURIComponent(key) + '&om=json&no=' + encodeURIComponent(no);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    const r = j && (j.domeggook || j);
    if (!r || !r.basis) return null;
    const images = [...new Set(JSON.stringify(r).match(/https:\/\/cdn[0-9]*\.domeggook\.com[^"\\]+?_img_[0-9]+[^"\\]*/g) || [])].slice(0, 6);
    return {
      no: r.basis.no,
      title: r.basis.title || '',
      keywords: (r.basis.keywords && r.basis.keywords.kw) || [],
      domePrice: parsePrice(r.price && r.price.dome),
      moq: (r.qty && r.qty.domeMoq) || null,
      category: r.category || null,
      images,
      thumb: images[0] || null,
    };
  } catch (_) { return null; }
}

module.exports = { domeggookSearch, getItemView, parsePrice };
