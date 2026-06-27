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
    // 상세설명 컷 이미지(실제 기능·스펙 텍스트가 박혀있음 — 비전 추출용). desc HTML에서 추출(_stt_ + 외부CDN).
    const descImages = [...new Set((JSON.stringify(r.desc || {}).match(/(?:https?:)?\/\/[^"\\\s]+?\.(?:jpg|jpeg|png|gif|webp)/gi) || []))]
      .map((u) => u.replace(/^\/\//, 'https://'))
      .filter((u) => !/_stt_(50|150)[^0-9]|icon|logo|notice|cou-notice|btn_|bnr|banner/i.test(u)).slice(0, 12);
    // 실제 스펙(고시정보·skuInfo 자동채움 원천) — 제목만 보고 GPT가 지어내지 않게.
    const d = r.detail || {};
    const clean = (v) => { const s = String(v == null ? '' : v).trim(); return (!s || /^[.\-_\s]+$/.test(s) || /^(해당\s*없음|없음|n\/?a|0|미상)$/i.test(s)) ? null : s; };
    const spec = {
      size: clean(d.size), weight: clean(d.weight), country: clean(d.country),
      manufacturer: clean(d.manufacturer), model: clean(d.model),
      kc: Array.isArray(d.safetyCert) ? d.safetyCert.filter((c) => c.cert === 'Y').map((c) => [c.type, c.name].filter(Boolean).join(' ').trim()).filter((s) => s && !/참조|해당\s*없음/.test(s)) : [],
    };
    let options = [];
    try { const so = typeof r.selectOpt === 'string' ? JSON.parse(r.selectOpt) : r.selectOpt; if (so && Array.isArray(so.set)) options = [...new Set(so.set.flatMap((s) => s.opts || []))].slice(0, 20); } catch (_) {}
    // 재판매(오픈마켓) 가능 여부 — 불가면 쿠팡에 올리면 안 됨(중요 게이트).
    const licMsg = (r.desc && r.desc.license && r.desc.license.msg) || '';
    const resale = { allowed: !/재판매\s*불가|오픈마켓[^]{0,12}불가|불가\s*상품/.test(licMsg), msg: licMsg || null };
    const catTree = ((r.category && r.category.parents && r.category.parents.elem) || []).map((e) => e.name)
      .concat((r.category && r.category.current && r.category.current.name) ? [r.category.current.name] : []);
    const seller = (r.seller && r.seller.company) ? { name: r.seller.company.name || null, phone: r.seller.company.phone || null } : null;
    return {
      no: r.basis.no,
      title: r.basis.title || '',
      keywords: (r.basis.keywords && r.basis.keywords.kw) || [],
      domePrice: parsePrice(r.price && r.price.dome),
      moq: (r.qty && r.qty.domeMoq) || null,
      category: r.category || null,
      categoryTree: catTree,
      spec, options, resale, seller,
      images, descImages,
      thumb: images[0] || null,
    };
  } catch (_) { return null; }
}

// ===== 자동매입(매입 주문) =====
const HOME = process.env.HOME || '/home/lumi';
const PW_FILE = HOME + '/.dgk_pw';        // 도매꾹 비번 (사장님이 직접 저장, 600)
const SESS_FILE = HOME + '/.dgk_session'; // 발급된 세션(sId) 캐시
const DELI_FILE = HOME + '/.dgk_deliinfo'; // 기본 매입 배송지 "이름|이메일|우편|주소|상세|휴대폰|전화|회사" (개인정보, 600)

const GEMI_DELI_FILE = HOME + '/.dgk_deliinfo_gemi'; // 개미창고 입고 배송지(로켓그로스 직배송, 600)

// 기본 배송지 로드(사장님 집). 매입 시 deliinfo 미지정이면 이걸 사용. 미설정이면 null.
function getDefaultDeliinfo() {
  try { const s = fs.readFileSync(DELI_FILE, 'utf8').trim(); return s || null; } catch (_) { return null; }
}
// 개미창고 배송지 로드(로켓그로스 직배송용 — 매입을 개미창고로 직배송). 미설정이면 null.
function getGemiDeliinfo() {
  try { const s = fs.readFileSync(GEMI_DELI_FILE, 'utf8').trim(); return s || null; } catch (_) { return null; }
}

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
async function setOrderDome({ no, qty = 1, optCode = '', deliinfo, deliMode = 'gemi', sellerMsg = '', deliReq = '', receipt = '0', dryRun = true }) {
  if (!deliinfo) deliinfo = (deliMode === 'home') ? getDefaultDeliinfo() : getGemiDeliinfo(); // 기본=개미창고(로켓그로스 직배송), home=사장님 집
  if (!deliReq && deliMode === 'gemi') deliReq = '도매꾹 쿠팡로켓그로스';
  if (!no || !deliinfo) return { ok: false, error: 'no/deliinfo 필요(' + deliMode + ' 배송지 미설정)' };
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

// 매입 주문 취소 신청(setOrdDeny v1.0, type=buy). ⚠배송중 이전 단계까지만 가능(이후엔 반품). e-money 환불.
// result: true(승인 후 취소처리)/complete(취소완료)/req(배송준비중 취소요청 접수). dryRun 기본 true.
async function cancelOrderDome({ orderNo, memo = '구매 취소', dryRun = true }) {
  if (!orderNo) return { ok: false, error: 'orderNo 필요' };
  const ses = await getDomeSession();
  if (!ses) return { ok: false, error: '도매꾹 세션 발급 실패' };
  const params = { ver: '1.0', mode: 'setOrdDeny', aid: process.env.DOMEGGOOK_API_KEY, id: ses.id, sId: ses.sId, type: 'buy', no: String(orderNo), memo, om: 'json' };
  if (dryRun) return { ok: true, dryRun: true, request: { ...params, sId: '***', aid: '***' } };
  try {
    const r = await fetch('https://domeggook.com/ssl/api/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => null); const root = j && (j.domeggook || j);
    const res = root && root.result;
    if (res === true || res === 'true' || res === 'complete' || res === 'req') return { ok: true, result: res, raw: root };
    return { ok: false, error: root && root.errors ? JSON.stringify(root.errors) : '취소 실패', raw: root };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { domeggookSearch, getItemView, parsePrice, getDomeSession, domeLogin, setOrderDome, cancelOrderDome, getDefaultDeliinfo, getGemiDeliinfo };
