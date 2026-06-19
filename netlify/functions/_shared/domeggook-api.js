'use strict';
// 도매꾹 OpenAPI getItemList — 키워드 검색 → [{name, w}] (coupang-scan domeSample과 동일 형태).
// 멀티 도매처 비교용 2차 매입가 소스. 스크래핑 아님(공개 API라 도매토피아보다 안정적).
//
// 환경변수: DOMEGGOOK_API_KEY (domeggook.com 사업자회원 > API Key 관리에서 무료 발급).
//   미설정 시 빈 배열 → 기존 도매토피아만 사용 (graceful).
//
// ⚠ 응답 필드명은 도매꾹 실응답 1회로 확정 필요 — 아래는 방어적 다중 파싱(여러 형태 탐색).
//    키 발급 후 첫 호출 결과를 보고 맞는 경로/키로 좁히면 됨.

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
      const w = Number(it.price || it.salePrice || it.lowestPrice || it.unitPrice || it.amount) || null;
      return { name: name.slice(0, 40), w };
    }).filter((x) => x.name && x.w);
  } catch (_) { return []; }
}

module.exports = { domeggookSearch };
