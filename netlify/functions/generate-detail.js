// 상세페이지 생성 API (고객용 웹서비스) — 비동기 작업 방식.
//   POST {url|title+imageBase64} → 즉시 jobId 반환(202), 백그라운드에서 생성.
//   GET  ?jobId → 상태 조회(pending / done+html / error).
// 생성이 1~3분 걸려서 동기 응답은 프록시·브라우저 타임아웃 위험 → 작업+폴링 방식.
const { generateDetailPage, generateAiPhoto, photoPrompt, scenePlan, copyToBlocks, renderBlocks, accentPalette, extractProductTitle, analyzeProductImages, analyzeReferenceStyle, refStylePrompt, verifyGenerated, refBlockPlan, stitchBlocks, renderBlockText, recomposeBlocks, recomposeBlock } = require('./_shared/detail-page.js');
const { getItemView } = require('./_shared/domeggook-api.js');
const { getDometopiaItem, parseNo } = require('./_shared/dometopia.js');
const { fetchViaUnlocker, parseUniversalProduct } = require('./_shared/universal.js');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt.js');
const { getAdminClient } = require('./_shared/supabase-admin.js');
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

// 관리자(사장님 등) 계정은 무료 크레딧 체크 면제 — 무제한 생성.
function isAdminSeller(id) {
  if (!id) return false;
  const ids = String(process.env.LUMI_ADMIN_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const brand = (process.env.LUMI_BRAND_USER_ID || '').trim();
  return ids.includes(id) || (!!brand && id === brand);
}
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
    // 입력은 가장 큰 이미지로(작은 썸네일은 날개 등 디테일이 뭉개짐). 도매꾹 760 우선, 없으면 마지막(보통 최대).
    srcForPhoto = (item.images || []).find((u) => /760|_l\b|large|origin/i.test(String(u))) || (item.images || []).slice(-1)[0] || (item.images || [])[0] || null;
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
  const result = await generateDetailPage(product, { sellingHook: features || '', skipVision: false, imageFacts: confirmedFacts, userRequest: p.userRequest, tone: p.tone });
  if (!result || result.error) throw new Error(result && result.error ? result.error : '카피 생성 실패');
  // ★거짓 방지(업로드 모드): 사진 비전·캡처·입력 어디에도 정보가 없으면 거부 → 지어내기 차단.
  if (!url && !(result.imageFacts || []).length && !String(features || '').trim()) {
    throw new Error('올리신 사진에 상품 정보가 없어요. ① 상품 정보를 입력하거나, 정보(스펙·설명)가 적힌 상세페이지 사진을 올려주세요.');
  }
  const copy = result.copy || {};
  const factsForPrompt = (Array.isArray(p.facts) ? p.facts : (result.imageFacts || []));

  // ★레퍼런스 스타일 모드 — 레퍼런스 이미지를 통째로 넣지 않고, 스타일 텍스트만 추출해 주입(비타민/엉뚱제품 복제 차단).
  if ((p.referenceImageBase64 || p.referenceUrl) && srcForPhoto) {
    // 레퍼런스에서 디자인 스타일(palette·mood·layout)만 비전 추출 → 블록 플랜에 텍스트로 주입.
    // 이미지 base64 또는 링크(페이지 스크래핑 → 대표 이미지) 둘 다 지원. 실패 시 레퍼런스 없이 진행.
    let refImgs = null;
    if (p.referenceImageBase64) {
      refImgs = ['data:image/jpeg;base64,' + stripDataUri(p.referenceImageBase64)];
    } else if (p.referenceUrl) {
      try {
        const rhtml = await fetchViaUnlocker(p.referenceUrl);
        const ritem = parseUniversalProduct(rhtml, p.referenceUrl);
        const rims = ((ritem.descImages && ritem.descImages.length) ? ritem.descImages : (ritem.images || [])) || [];
        if (rims.length) refImgs = rims.slice(0, 2);
      } catch (_) {}
    }
    let styleHint = null;
    try { if (refImgs) styleHint = await analyzeReferenceStyle(refImgs); } catch (_) {}
    const plan = refBlockPlan(product, copy, factsForPrompt, styleHint);
    const blockResults = [];
    // 비타민은 레퍼런스 이미지 미입력으로 이미 차단됨 → verify 불필요. 블록을 3개씩 병렬 생성(속도: 순차 18분 → 수분).
    const sharpLib = require('sharp');
    const fsq = require('fs'); const pathq = require('path');
    // ★화보 캐시: 블록 화보(텍스트0)를 jobId별로 저장 → 편집·재합성 시 gpt 재호출 X(크레딧 0).
    const cacheDir = pathq.join(process.env.HOME || '/home/lumi', 'lumi', 'cache', String(jobId || 'tmp'));
    try { fsq.mkdirSync(cacheDir, { recursive: true }); } catch (_) {}
    for (let i = 0; i < plan.length; i += 3) {
      // gpt-image-2가 한글 글씨까지 직접 생성 → 결과 그대로 사용(renderBlockText/SVG 합성 미사용). 캐시는 재생성 편집용.
      const batch = await Promise.all(plan.slice(i, i + 3).map((blk) => generateAiPhoto(srcForPhoto, blk.prompt, { quality: blk.quality }).then((photo) => {
        if (!photo) return null;
        try { fsq.writeFileSync(pathq.join(cacheDir, blk.key + '.png'), Buffer.from(photo, 'base64')); } catch (_) {}
        return { key: blk.key, b64: photo };
      })));
      batch.forEach((x) => { if (x) blockResults.push(x); });
    }
    // 플랜·스타일 메타 저장(편집/재합성용 — 화보 재생성 없이 텍스트만 다시 얹음).
    try { fsq.writeFileSync(pathq.join(cacheDir, '_meta.json'), JSON.stringify({ plan: plan.map((b) => ({ key: b.key, text: b.text, prompt: b.prompt, quality: b.quality })), styleHint })); } catch (_) {}
    try { fsq.writeFileSync(pathq.join(cacheDir, '_src.txt'), String(srcForPhoto || '')); } catch (_) {}
    if (!blockResults.length) throw new Error('이미지 생성에 실패했습니다. 다시 시도해 주세요');
    // ★블록별 결과 — 개별 저장(/r/img/{jobId}-{key}.png) + URL → 편집 화면(블록 편집)용. blocks=[{key,img,text}].
    try { fsq.mkdirSync(pathq.join(RESULTS_DIR, 'img'), { recursive: true }); } catch (_) {}
    const blocks = blockResults.map((br) => {
      const fn = String(jobId) + '-' + br.key + '.png';
      try { fsq.writeFileSync(pathq.join(RESULTS_DIR, 'img', fn), Buffer.from(br.b64, 'base64')); } catch (_) {}
      const pm = plan.find((p) => p.key === br.key);
      return { key: br.key, img: 'https://lumi.it.kr/r/img/' + fn, text: pm ? pm.text : {} };
    });
    const stitched = await stitchBlocks(blockResults.map((b) => b.b64));
    return { title: product.title, image: stitched || blockResults[0].b64, copy, reviewPoints: result.reviewPoints || [], mode: 'image', blockCount: blockResults.length, blocks, styleHint: styleHint || null, jobId: String(jobId || '') };
  }

  // (레퍼런스 없을 때) 기존 블록 흐름
  let styleHint = null;

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

exports.runGeneration = runGeneration; // 테스트/재사용용 노출
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  // 인증: 로그인 회원만 (비로그인 API 직접호출 차단 → 비용 안전). create.html 이 Bearer 토큰 전송.
  const { payload: _auth, error: _authErr } = verifySellerToken(extractBearerToken(event));
  if (_authErr || !_auth) return err(401, '로그인이 필요합니다. 다시 로그인해 주세요.');
  const sellerId = _auth.seller_id;

  // 상태 조회
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    // 내 작품 목록 (대시보드 갤러리) — 로그인 회원의 detail_jobs 최신순
    if (q.action === 'list') {
      try {
        const { data } = await getAdminClient().from('detail_jobs').select('job_id,title,result_url,mode,created_at').eq('seller_id', sellerId).order('created_at', { ascending: false }).limit(60);
        return ok({ items: data || [] });
      } catch (e) { return ok({ items: [] }); }
    }
    // 공개 샘플(관리자가 is_sample=true로 지정) — 빈 작업실에 "이렇게 만들어져요"로 노출. seller 무관 공개.
    if (q.action === 'samples') {
      try {
        const { data } = await getAdminClient().from('detail_jobs').select('job_id,title,result_url,mode,created_at').eq('is_sample', true).order('created_at', { ascending: false }).limit(12);
        return ok({ items: data || [] });
      } catch (e) { return ok({ items: [] }); }
    }
    const id = q.jobId;
    const j = id && jobs[id];
    if (!j) return err(404, '작업을 찾을 수 없습니다. 다시 시도해 주세요');
    if (j.status === 'done') return ok({ status: 'done', mode: j.mode || 'html', title: j.title, html: j.html, blocks: j.blocks, palette: j.palette, copy: j.copy, reviewPoints: j.reviewPoints, sceneCount: j.sceneCount, resultUrl: j.resultUrl, jobId: j.jobId || id, creditRemaining: j.creditRemaining });
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
  // 편집/재합성: 저장된 화보 캐시 + 폰트·색·문구 override → 재합성(gpt 0원, rate 무관).
  if (params.action === 'recompose') {
    const jid = String(params.jobId || '').replace(/[^a-z0-9-]/gi, '');
    if (!jid) return err(400, 'jobId가 필요합니다');
    try {
      const cacheDir = path.join(process.env.HOME || '/home/lumi', 'lumi', 'cache', jid);
      const style = { fontOverride: params.fontOverride, inkOverride: params.inkOverride, accentOverride: params.accentOverride, subOverride: params.subOverride };
      const imgDir = path.join(RESULTS_DIR, 'img');
      try { fs.mkdirSync(imgDir, { recursive: true }); } catch (_) {}
      // (a) 블록 1개 실시간 갱신 — 편집기에서 글자 고칠 때(무료, gpt 0).
      if (params.blockKey) {
        const b64 = await recomposeBlock(cacheDir, params.blockKey, params.textOverride || null, style);
        if (!b64) return err(404, '블록을 재합성할 수 없습니다');
        const fn = jid + '-' + params.blockKey + '.png';
        fs.writeFileSync(path.join(imgDir, fn), Buffer.from(b64, 'base64'));
        return ok({ recomposed: true, blockKey: params.blockKey, img: 'https://lumi.it.kr/r/img/' + fn });
      }
      // (b) 저장 — blocks 순서·문구 그대로 각 블록 재합성 → 이어붙여 최종 1장(무료).
      if (Array.isArray(params.blocks) && params.blocks.length) {
        const parts = [];
        for (const b of params.blocks) {
          const b64 = await recomposeBlock(cacheDir, b.key, (b.text || null), style);
          if (b64) parts.push(b64);
        }
        const stitched = await stitchBlocks(parts);
        if (!stitched) return err(404, '저장된 화보가 없습니다. 먼저 생성해 주세요');
        fs.writeFileSync(path.join(imgDir, jid + '.jpg'), Buffer.from(stitched, 'base64'));
        return ok({ recomposed: true, resultUrl: 'https://lumi.it.kr/r/img/' + jid + '.jpg' });
      }
      // (c) 전체 재합성(기존 — 폰트·색 일괄 변경).
      const stitched = await recomposeBlocks(cacheDir, style, params.textOverride);
      if (!stitched) return err(404, '저장된 화보가 없습니다. 먼저 생성해 주세요');
      fs.writeFileSync(path.join(imgDir, jid + '.jpg'), Buffer.from(stitched, 'base64'));
      return ok({ recomposed: true, resultUrl: 'https://lumi.it.kr/r/img/' + jid + '.jpg' });
    } catch (e) { return err(500, '재합성에 실패했습니다'); }
  }
  // 이미지 교체(무료) — 고객이 올린 사진으로 블록 화보 교체 후 텍스트 재합성. gpt 0.
  if (params.action === 'replace-image') {
    const jid = String(params.jobId || '').replace(/[^a-z0-9-]/gi, '');
    if (!jid || !params.blockKey || !params.imageBase64) return err(400, '교체 정보가 부족합니다');
    try {
      const cacheDir = path.join(process.env.HOME || '/home/lumi', 'lumi', 'cache', jid);
      const raw = String(params.imageBase64).replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(path.join(cacheDir, params.blockKey + '.png'), Buffer.from(raw, 'base64'));
      const style = { fontOverride: params.fontOverride, inkOverride: params.inkOverride, accentOverride: params.accentOverride, subOverride: params.subOverride };
      const out = await recomposeBlock(cacheDir, params.blockKey, params.textOverride || null, style);
      if (!out) return err(404, '교체에 실패했습니다. 다시 시도해 주세요');
      const imgDir = path.join(RESULTS_DIR, 'img'); try { fs.mkdirSync(imgDir, { recursive: true }); } catch (_) {}
      const fn = jid + '-' + params.blockKey + '.png';
      fs.writeFileSync(path.join(imgDir, fn), Buffer.from(out, 'base64'));
      return ok({ replaced: true, blockKey: params.blockKey, img: 'https://lumi.it.kr/r/img/' + fn });
    } catch (e) { return err(500, '이미지 교체에 실패했습니다'); }
  }
  // AI 재생성(유료) — 원본 사진+프롬프트로 해당 블록 화보만 다시 생성. 회원만(handler 진입부 인증).
  if (params.action === 'regen-block') {
    const jid = String(params.jobId || '').replace(/[^a-z0-9-]/gi, '');
    if (!jid || !params.blockKey) return err(400, '재생성 정보가 부족합니다');
    try {
      const cacheDir = path.join(process.env.HOME || '/home/lumi', 'lumi', 'cache', jid);
      let meta; try { meta = JSON.parse(fs.readFileSync(path.join(cacheDir, '_meta.json'), 'utf8')); } catch (_) { return err(404, '원본 정보가 없습니다. 다시 생성해 주세요'); }
      const blk = (meta.plan || []).find((b) => b.key === params.blockKey);
      if (!blk || !blk.prompt) return err(404, '이 블록은 재생성을 지원하지 않습니다');
      let src = ''; try { src = fs.readFileSync(path.join(cacheDir, '_src.txt'), 'utf8'); } catch (_) {}
      if (!src) return err(404, '원본 사진이 없습니다. 다시 생성해 주세요');
      const photo = await generateAiPhoto(src, blk.prompt, { quality: blk.quality || 'medium' });
      if (!photo) return err(502, 'AI 재생성에 실패했습니다. 다시 시도해 주세요');
      fs.writeFileSync(path.join(cacheDir, params.blockKey + '.png'), Buffer.from(photo, 'base64'));
      const style = { fontOverride: params.fontOverride, inkOverride: params.inkOverride, accentOverride: params.accentOverride, subOverride: params.subOverride };
      const out = await recomposeBlock(cacheDir, params.blockKey, params.textOverride || null, style);
      const imgDir = path.join(RESULTS_DIR, 'img'); try { fs.mkdirSync(imgDir, { recursive: true }); } catch (_) {}
      const fn = jid + '-' + params.blockKey + '.png';
      fs.writeFileSync(path.join(imgDir, fn), Buffer.from(out || photo, 'base64'));
      return ok({ regenerated: true, blockKey: params.blockKey, img: 'https://lumi.it.kr/r/img/' + fn });
    } catch (e) { return err(500, 'AI 재생성에 실패했습니다'); }
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

  // 무료 크레딧 체크 — 관리자 면제. 잔여 0이면 생성 차단(유료 안내). 조회 실패 시엔 막지 않고 진행(사용자 우선).
  const _isAdmin = isAdminSeller(sellerId);
  let _credit = null;
  if (!_isAdmin) {
    try {
      const { data: _s } = await getAdminClient().from('sellers').select('free_credits_remaining').eq('id', sellerId).single();
      _credit = _s ? (_s.free_credits_remaining == null ? 0 : _s.free_credits_remaining) : 0;
    } catch (_) { _credit = null; }
    if (_credit !== null && _credit <= 0) return err(403, '무료 생성 2회를 모두 사용했어요. 더 만들려면 곧 열릴 유료 플랜을 이용해 주세요.');
  }

  const jobId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  jobs[jobId] = { status: 'pending', ts: Date.now() };
  gcJobs();
  runGeneration(params, jobId)
    .then((r) => {
      try {
        if (r.image) {
          fs.writeFileSync(path.join(RESULTS_DIR, jobId + '.jpg'), Buffer.from(r.image, 'base64'));
          r.resultUrl = 'https://lumi.it.kr/r/' + jobId + '.jpg';
          delete r.image; // b64는 응답에서 제거(경량). stitchBlocks가 JPG q95로 반환.
        } else {
          fs.writeFileSync(path.join(RESULTS_DIR, jobId + '.html'), r.html || '');
          r.resultUrl = 'https://lumi.it.kr/r/' + jobId + '.html';
        }
      } catch (_) {}
      let _remain = null;
      if (!_isAdmin && _credit !== null) _remain = Math.max(0, _credit - 1);
      jobs[jobId] = { status: 'done', ts: Date.now(), ...r, creditRemaining: _remain };
      // 생성 성공 → 무료 크레딧 1 차감 (관리자·조회실패 제외). fire-and-forget.
      if (!_isAdmin && _credit !== null && _credit > 0) {
        getAdminClient().from('sellers').update({ free_credits_remaining: _credit - 1 }).eq('id', sellerId).then(function () {}, function () {});
      }
      // 내 작품 갤러리용 — 회원별 작업 기록 저장 (fire-and-forget)
      getAdminClient().from('detail_jobs').insert({ seller_id: sellerId, job_id: jobId, title: r.title || null, result_url: r.resultUrl || null, mode: r.mode || 'html' }).then(function () {}, function () {});
    })
    .catch((e) => { jobs[jobId] = { status: 'error', ts: Date.now(), error: (e && e.message) || '생성 중 오류가 발생했습니다' }; });

  return ok({ jobId }, 202);
};
