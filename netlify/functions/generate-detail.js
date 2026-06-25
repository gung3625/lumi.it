// 상세페이지 생성 API (고객용 웹서비스) — 비동기 작업 방식.
//   POST {url|title+imageBase64} → 즉시 jobId 반환(202), 백그라운드에서 생성.
//   GET  ?jobId → 상태 조회(pending / done+html / error).
// 생성이 1~3분 걸려서 동기 응답은 프록시·브라우저 타임아웃 위험 → 작업+폴링 방식.
const { generateDetailPage, generateAiPhoto, photoPrompt, scenePlan, copyToBlocks, renderBlocks, accentPalette, extractProductTitle, analyzeProductImages, analyzeReferenceStyle } = require('./_shared/detail-page.js');
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

// 레퍼런스 hex 팔레트 → {accent, ink(가장 어두운), soft(가장 밝은)}. 6자리 hex만 사용.
function lum(hex) { const h = hex.replace('#', ''); return 0.299 * parseInt(h.slice(0, 2), 16) + 0.587 * parseInt(h.slice(2, 4), 16) + 0.114 * parseInt(h.slice(4, 6), 16); }
function paletteFromHex(arr) {
  const hs = (arr || []).filter((c) => /^#[0-9a-f]{6}$/i.test(String(c)));
  if (!hs.length) return null;
  const sorted = [...hs].sort((a, b) => lum(a) - lum(b));
  return { accent: hs[0], ink: sorted[0], soft: sorted[sorted.length - 1] };
}

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

// 분석 단계(업로드 모드) — 사진/캡처에서 상품명·정보만 추출(화보·컷 없이). 사용자 확인·수정용.
async function runAnalysis(p) {
  const { title, imageBase64, features } = p || {};
  if (!imageBase64) throw new Error('상품 사진을 올려주세요');
  const mainUri = 'data:image/jpeg;base64,' + stripDataUri(imageBase64);
  const cap = p.captureBase64 ? ('data:image/png;base64,' + stripDataUri(p.captureBase64)) : null;
  const descImages = [mainUri, cap].filter(Boolean);
  let t = String(title || '').trim();
  if (!t) t = await extractProductTitle(cap || mainUri);
  const facts = (await analyzeProductImages(descImages, t || '상품')) || [];
  const info = String(features || '').trim();
  const allFacts = info ? [info, ...facts] : facts;
  return { title: t || '', facts: allFacts };
}

// 실제 생성 — 도매꾹 링크/사진 → 베이스 화보 → 카피 → 디자인 컷 → 조립.
async function runGeneration(p, jobId) {
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
    if (!imageBase64) throw new Error('상품 대표 사진을 올려주세요');
    srcForPhoto = stripDataUri(imageBase64);
    const mainUri = 'data:image/jpeg;base64,' + srcForPhoto;
    const cap = p.captureBase64 ? ('data:image/png;base64,' + stripDataUri(p.captureBase64)) : null;
    // 대표사진·캡처 모두 비전 분석 대상 — 올린 사진 자체가 정보가 적힌 상세페이지 사진일 수 있다.
    // (정보 유무는 비전 분석 후 판단 → 거짓 방지는 카피 단계에서)
    const descImages = [mainUri, cap].filter(Boolean);
    // 상품명 미입력 → 캡처/사진에서 자동 인식.
    let t = String(title || '').trim();
    if (!t) {
      t = await extractProductTitle(cap || mainUri);
      if (!t) throw new Error('상품명을 인식하지 못했어요. 상품명을 직접 입력해 주세요.');
    }
    product = { title: t, spec: {}, options: [], images: [], descImages };
  }

  // 2단계 확정 정보(facts)가 오면 재분석 없이 그대로 사용. 없으면 비전 분석.
  const confirmedFacts = Array.isArray(p.facts) ? p.facts : undefined;
  const result = await generateDetailPage(product, { sellingHook: features || '', skipVision: false, imageFacts: confirmedFacts });
  if (!result || result.error) throw new Error(result && result.error ? result.error : '카피 생성 실패');
  // ★거짓 방지(업로드 모드): 사진 비전·캡처·입력 어디에도 정보가 없으면 거부 → 지어내기 차단.
  if (!url && !(result.imageFacts || []).length && !String(features || '').trim()) {
    throw new Error('올리신 사진에 상품 정보가 없어요. ① 상품 정보를 입력하거나, 정보(스펙·설명)가 적힌 상세페이지 사진을 올려주세요.');
  }
  const copy = result.copy || {};

  // 레퍼런스 스타일 분석(있으면) — 콘텐츠 아닌 비주얼 스타일만(법적 안전선).
  let styleHint = null;
  if (p.referenceImageBase64) {
    try { styleHint = await analyzeReferenceStyle(['data:image/png;base64,' + stripDataUri(p.referenceImageBase64)]); } catch (_) {}
  }

  let baseB64 = null;
  if (!skipPhoto && srcForPhoto) baseB64 = await generateAiPhoto(srcForPhoto, photoPrompt(product.title), { quality: 'low' });

  // 글자 없는 깨끗한 화보 컷 생성(편집은 텍스트 레이어가 담당) → 편집가능 블록 조립.
  let blocks = copyToBlocks(product, copy, []);
  let palette = (styleHint && styleHint.palette && styleHint.palette.length) ? paletteFromHex(styleHint.palette) : null;
  let sceneCount = 0;
  if (baseB64) {
    const plan = scenePlan(product, copy, styleHint);
    const scenes = [];
    for (let i = 0; i < plan.length; i += 3) {
      const batch = await Promise.all(plan.slice(i, i + 3).map(async (c) => ({ key: c.key, img: await generateAiPhoto(baseB64, c.prompt, { quality: quality || 'medium' }) })));
      scenes.push(...batch);
    }
    sceneCount = scenes.filter((s) => s.img).length;
    if (!palette) palette = await accentPalette((scenes.find((s) => s.img) || {}).img || baseB64);
    // 화보(base64)를 파일로 분리 저장 → blocks엔 URL만 (HTML/blocks 경량화: 9MB→수십KB, 모바일서 결과 열림).
    const IMG_DIR = path.join(RESULTS_DIR, 'img');
    try { fs.mkdirSync(IMG_DIR, { recursive: true }); } catch (_) {}
    scenes.forEach((s, i) => {
      if (!s.img) return;
      try { fs.writeFileSync(path.join(IMG_DIR, jobId + '-' + i + '.png'), Buffer.from(s.img, 'base64')); s.img = 'https://lumi.it.kr/r/img/' + jobId + '-' + i + '.png'; } catch (_) {}
    });
    blocks = copyToBlocks(product, copy, scenes);
  }
  const html = renderBlocks(blocks, palette);
  return { title: product.title, html, blocks, palette, copy, reviewPoints: result.reviewPoints || [], photoGenerated: !!baseB64, sceneCount, styleHint: styleHint || null };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  // 상태 조회
  if (event.httpMethod === 'GET') {
    const id = (event.queryStringParameters || {}).jobId;
    const j = id && jobs[id];
    if (!j) return err(404, '작업을 찾을 수 없습니다. 다시 시도해 주세요');
    if (j.status === 'done') return ok({ status: 'done', title: j.title, html: j.html, blocks: j.blocks, palette: j.palette, styleHint: j.styleHint, copy: j.copy, reviewPoints: j.reviewPoints, sceneCount: j.sceneCount, resultUrl: j.resultUrl });
    if (j.status === 'error') return ok({ status: 'error', error: j.error });
    return ok({ status: 'pending' });
  }

  // 작업 시작
  if (event.httpMethod !== 'POST') return err(405, 'POST만 허용됩니다');
  let params;
  try { params = JSON.parse(event.body || '{}'); } catch (_) { return err(400, '잘못된 요청입니다'); }
  // 생성 후 편집 저장: 수정된 HTML을 결과 파일에 덮어쓴다(생성 아님 → rate 무관).
  if (params.action === 'save') {
    const jid = String(params.jobId || '').replace(/[^a-z0-9]/gi, '');
    if (!jid || !params.html) return err(400, '저장 정보가 부족합니다');
    try { fs.writeFileSync(path.join(RESULTS_DIR, jid + '.html'), String(params.html)); return ok({ saved: true, resultUrl: 'https://lumi.it.kr/r/' + jid + '.html' }); }
    catch (_) { return err(500, '저장에 실패했습니다'); }
  }
  if (!params.url && !params.imageBase64) return err(400, '상품 링크를 넣거나, 대표 사진을 올려주세요');

  // 분석 단계(업로드 모드): 정보만 추출해 동기 반환 → 프론트에서 확인·수정 후 생성 요청. (rate 면제)
  if (params.step === 'analyze') {
    try { return ok(await runAnalysis(params)); }
    catch (e) { return err(400, (e && e.message) || '분석에 실패했어요. 다시 시도해 주세요.'); }
  }

  // 생성 단계: 비용 발생 → rate 체크
  var ip = String(event.headers['x-forwarded-for'] || '').split(',')[0].trim() || event.headers['x-real-ip'] || 'ip';
  if (!allowRate(ip)) return err(429, '하루 생성 한도(' + RATE_LIMIT + '회)를 초과했습니다. 내일 다시 이용해 주세요.');

  const jobId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  jobs[jobId] = { status: 'pending', ts: Date.now() };
  gcJobs();
  runGeneration(params, jobId)
    .then((r) => {
      try { fs.writeFileSync(path.join(RESULTS_DIR, jobId + '.html'), r.html || ''); r.resultUrl = 'https://lumi.it.kr/r/' + jobId + '.html'; } catch (_) {}
      jobs[jobId] = { status: 'done', ts: Date.now(), ...r };
    })
    .catch((e) => { jobs[jobId] = { status: 'error', ts: Date.now(), error: (e && e.message) || '생성 중 오류가 발생했습니다' }; });

  return ok({ jobId }, 202);
};
