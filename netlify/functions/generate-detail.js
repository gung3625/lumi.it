// 상세페이지 생성 API (고객용 웹서비스) — 비동기 작업 방식.
//   POST {url|title+imageBase64} → 즉시 jobId 반환(202), 백그라운드에서 생성.
//   GET  ?jobId → 상태 조회(pending / done+html / error).
// 생성이 1~3분 걸려서 동기 응답은 프록시·브라우저 타임아웃 위험 → 작업+폴링 방식.
const { generateDetailPage, generateAiPhoto, photoPrompt, cutPlan, assembleCutPage, accentPalette } = require('./_shared/detail-page.js');
const { getItemView } = require('./_shared/domeggook-api.js');
const { getDometopiaItem, parseNo } = require('./_shared/dometopia.js');
const { fetchViaUnlocker, parseUniversalProduct } = require('./_shared/universal.js');
const fs = require('fs');
const path = require('path');
// 결과 영구 저장 폴더(~/lumi/r) — server.js 정적 서빙으로 lumi.it.kr/r/<jobId>.html 접근.
const RESULTS_DIR = path.join(__dirname, '..', '..', 'r');
try { fs.mkdirSync(RESULTS_DIR, { recursive: true }); } catch (_) {}

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Content-Type': 'application/json',
};
const ok = (obj, code) => ({ statusCode: code || 200, headers, body: JSON.stringify(obj) });
const err = (code, msg) => ({ statusCode: code, headers, body: JSON.stringify({ error: msg }) });
const stripDataUri = (s) => String(s || '').replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');

// 작업 저장소(모듈 스코프 — server.js가 1회 require하므로 프로세스 동안 유지). 30분 TTL.
const jobs = {};
function gcJobs() { const now = Date.now(); for (const id in jobs) { if (now - jobs[id].ts > 1800000) delete jobs[id]; } }

// 비용 방어: IP당 일일 생성 한도(무인증 공개 시 악용·비용폭탄 차단). 상품당 ~400원이라 필수.
const RATE_LIMIT = 5;
const rate = {};
function allowRate(ip) {
  const day = new Date().toISOString().slice(0, 10);
  if (!rate[ip] || rate[ip].day !== day) rate[ip] = { day: day, n: 0 };
  if (rate[ip].n >= RATE_LIMIT) return false;
  rate[ip].n++; return true;
}

// 실제 생성 — 도매꾹 링크/사진 → 베이스 화보 → 카피 → 디자인 컷 → 조립.
async function runGeneration(p) {
  const { url, title, features, imageBase64, quality, skipPhoto } = p || {};
  let product, srcForPhoto;
  if (url) {
    let item;
    if (/dometopia\.com/i.test(url)) {
      const no = parseNo(url);
      if (!no) throw new Error('도매토피아 상품 링크가 맞는지 확인해 주세요');
      item = await getDometopiaItem(no);
    } else if (/^https?:\/\//i.test(url) && !/domeggook/i.test(url)) {
      // 도매꾹·도매토피아 외 사이트(쿠팡/스마트스토어/알리/G마켓 등) → Web Unlocker로 봇차단 우회 + 범용 파서
      const html = await fetchViaUnlocker(url);
      item = parseUniversalProduct(html, url);
    } else {
      const no = (String(url).match(/(\d{6,})/) || [])[1];
      if (!no) throw new Error('도매꾹 상품 링크가 맞는지 확인해 주세요');
      item = await getItemView(no);
    }
    if (!item || !item.title) throw new Error('상품 정보를 불러오지 못했습니다. 링크를 확인해 주세요');
    srcForPhoto = (item.images || [])[0] || null;
    product = { title: item.title, spec: item.spec || {}, options: item.options || [], descImages: item.descImages || [], images: (item.images || []).slice(0, 4), keywords: item.keywords || [], categoryTree: item.categoryTree || [] };
  } else {
    if (!title || !imageBase64) throw new Error('상품명과 대표 사진을 넣어주세요');
    srcForPhoto = stripDataUri(imageBase64);
    // 전체 캡처(선택) → 비전 분석으로 상품 정보(스펙·특징·설명) 추출 → 카피 보강. data URI로 넘긴다.
    const cap = p.captureBase64 ? ('data:image/png;base64,' + stripDataUri(p.captureBase64)) : null;
    product = { title, spec: {}, options: [], images: [], descImages: cap ? [cap] : [] };
  }

  let baseB64 = null;
  if (!skipPhoto && srcForPhoto) baseB64 = await generateAiPhoto(srcForPhoto, photoPrompt(product.title), { quality: 'low' });

  const result = await generateDetailPage(product, { sellingHook: features || '', skipVision: !url && !(product.descImages || []).length });
  if (!result || result.error) throw new Error(result && result.error ? result.error : '카피 생성 실패');
  const copy = result.copy || {};

  let html = result.html, cutCount = 0;
  if (baseB64) {
    const plan = cutPlan(product, copy);
    const cuts = [];
    for (let i = 0; i < plan.length; i += 3) {
      const batch = await Promise.all(plan.slice(i, i + 3).map(async (c) => ({ img: await generateAiPhoto(baseB64, c.prompt, { quality: quality || 'medium' }), title: c.title, desc: c.desc })));
      cuts.push(...batch);
    }
    cutCount = cuts.filter((c) => c.img).length;
    if (cutCount >= 2) { const palette = await accentPalette(((cuts.find((c) => c.img) || {}).img) || baseB64); html = assembleCutPage(cuts, palette); }
  }
  return { title: product.title, html, copy, reviewPoints: result.reviewPoints || [], photoGenerated: !!baseB64, cutCount };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  // 상태 조회
  if (event.httpMethod === 'GET') {
    const id = (event.queryStringParameters || {}).jobId;
    const j = id && jobs[id];
    if (!j) return err(404, '작업을 찾을 수 없습니다. 다시 시도해 주세요');
    if (j.status === 'done') return ok({ status: 'done', title: j.title, html: j.html, copy: j.copy, reviewPoints: j.reviewPoints, cutCount: j.cutCount, resultUrl: j.resultUrl });
    if (j.status === 'error') return ok({ status: 'error', error: j.error });
    return ok({ status: 'pending' });
  }

  // 작업 시작
  if (event.httpMethod !== 'POST') return err(405, 'POST만 허용됩니다');
  var ip = String(event.headers['x-forwarded-for'] || '').split(',')[0].trim() || event.headers['x-real-ip'] || 'ip';
  if (!allowRate(ip)) return err(429, '하루 생성 한도(' + RATE_LIMIT + '회)를 초과했습니다. 내일 다시 이용해 주세요.');
  let params;
  try { params = JSON.parse(event.body || '{}'); } catch (_) { return err(400, '잘못된 요청입니다'); }
  if (!params.url && !(params.title && params.imageBase64)) return err(400, '상품 링크를 넣거나, 상품명과 사진을 넣어주세요');

  const jobId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  jobs[jobId] = { status: 'pending', ts: Date.now() };
  gcJobs();
  runGeneration(params)
    .then((r) => {
      try { fs.writeFileSync(path.join(RESULTS_DIR, jobId + '.html'), r.html || ''); r.resultUrl = 'https://lumi.it.kr/r/' + jobId + '.html'; } catch (_) {}
      jobs[jobId] = { status: 'done', ts: Date.now(), ...r };
    })
    .catch((e) => { jobs[jobId] = { status: 'error', ts: Date.now(), error: (e && e.message) || '생성 중 오류가 발생했습니다' }; });

  return ok({ jobId }, 202);
};
