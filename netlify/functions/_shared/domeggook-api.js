'use strict';
const fs = require('fs');
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

// ===== 자동매입(매입 주문) =====
const HOME = process.env.HOME || '/home/lumi';
const PW_FILE = HOME + '/.dgk_pw';        // 도매꾹 비번 (사장님이 직접 저장, 600)
const SESS_FILE = HOME + '/.dgk_session'; // 발급된 세션(sId) 캐시

// 비번으로 로그인 → sId 세션 발급(30일) + 캐시. 검증된 스펙(POST body, ver4.1).
async function domeLogin() {
  const key = process.env.DOMEGGOOK_API_KEY, id = process.env.DOMEGGOOK_USER_ID;
  let pw = ''; try { pw = fs.readFileSync(PW_FILE, 'utf8'); } catch (_) {}
  if (!key || !id || !pw) return null;
  const body = new URLSearchParams({
    ver: '4.1', mode: 'setLogin', aid: key, id, pw,
    loginKeep: 'on', ip: process.env.SERVER_IP || '34.158.206.244', device: 'Third Party', om: 'json',
  }).toString();
  try {
    const r = await fetch('https://domeggook.com/ssl/api/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => null); const root = j && (j.domeggook || j);
    if (root && root.sId) {
      const ses = { sId: root.sId, id, sIdRenewDate: root.sIdRenewDate || null, at: Date.now() };
      try { fs.writeFileSync(SESS_FILE, JSON.stringify(ses)); fs.chmodSync(SESS_FILE, 0o600); } catch (_) {}
      return ses;
    }
  } catch (_) {}
  return null;
}

// 캐시 세션 재사용(25일 이내), 없으면 재로그인.
async function getDomeSession() {
  try { const s = JSON.parse(fs.readFileSync(SESS_FILE, 'utf8')); if (s.sId && (Date.now() - s.at) < 25 * 864e5) return s; } catch (_) {}
  return domeLogin();
}

// 매입 주문 생성(setOrder v4.3). ⚠ item 포맷은 연동매뉴얼 기준 — 첫 실주문 전 검증 필요. dryRun 기본 true(미발사).
// deliinfo: "이름|이메일|우편번호|주소|상세주소|휴대폰|전화|회사명"
async function setOrderDome({ no, qty = 1, optCode = '', deliinfo, sellerMsg = '', deliReq = '', receipt = '0', dryRun = true }) {
  if (!no || !deliinfo) return { ok: false, error: 'no/deliinfo 필요' };
  const ses = await getDomeSession();
  if (!ses) return { ok: false, error: '도매꾹 세션 발급 실패(비번/키/아이디 확인)' };
  const params = { ver: '4.3', mode: 'setOrder', aid: process.env.DOMEGGOOK_API_KEY, id: ses.id, sId: ses.sId, receipt: String(receipt), om: 'json' };
  params['item[' + no + ']'] = 'dome||P||' + optCode + '|' + qty + '||' + sellerMsg + '||' + deliReq;
  params.deliinfo = deliinfo;
  if (dryRun) return { ok: true, dryRun: true, request: { ...params, sId: '***', aid: '***' } };
  try {
    const r = await fetch('https://domeggook.com/ssl/api/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => null); const root = j && (j.domeggook || j);
    if (root && root.result === 'SUCCESS') return { ok: true, orderNo: root.order && root.order.orderNo, raw: root };
    return { ok: false, error: root && root.errors ? JSON.stringify(root.errors) : '주문 실패', raw: root };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { domeggookSearch, getItemView, parsePrice, getDomeSession, domeLogin, setOrderDome };
