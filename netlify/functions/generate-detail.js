// 상세페이지 생성 API (고객용 웹서비스) — 비동기 작업 방식.
//   POST {url|title+imageBase64} → 즉시 jobId 반환(202), 백그라운드에서 생성.
//   GET  ?jobId → 상태 조회(pending / done+html / error).
// 생성이 1~3분 걸려서 동기 응답은 프록시·브라우저 타임아웃 위험 → 작업+폴링 방식.
const { generateDetailPage, generateAiPhoto, photoPrompt, cutPlan, assembleCutPage, accentPalette } = require('./_shared/detail-page.js');
const { getItemView } = require('./_shared/domeggook-api.js');

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

// 실제 생성 — 도매꾹 링크/사진 → 베이스 화보 → 카피 → 디자인 컷 → 조립.
async function runGeneration(p) {
  const { url, title, features, imageBase64, quality, skipPhoto } = p || {};
  let product, srcForPhoto;
  if (url) {
    const no = (String(url).match(/(\d{6,})/) || [])[1];
    if (!no) throw new Error('도매꾹 상품 링크가 맞는지 확인해 주세요');
    const item = await getItemView(no);
    if (!item || !item.title) throw new Error('상품 정보를 불러오지 못했습니다. 도매꾹 상품 링크인지 확인해 주세요');
    srcForPhoto = (item.images || [])[0] || null;
    product = { title: item.title, spec: item.spec || {}, options: item.options || [], descImages: item.descImages || [], images: (item.images || []).slice(0, 4), keywords: item.keywords || [], categoryTree: item.categoryTree || [] };
  } else {
    if (!title || !imageBase64) throw new Error('상품 링크를 넣거나, 상품명과 사진을 넣어주세요');
    srcForPhoto = stripDataUri(imageBase64);
    product = { title, spec: {}, options: [], images: [], descImages: [] };
  }

  let baseB64 = null;
  if (!skipPhoto && srcForPhoto) baseB64 = await generateAiPhoto(srcForPhoto, photoPrompt(product.title), { quality: 'low' });

  const result = await generateDetailPage(product, { sellingHook: features || '', skipVision: !url });
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
    if (j.status === 'done') return ok({ status: 'done', title: j.title, html: j.html, copy: j.copy, reviewPoints: j.reviewPoints, cutCount: j.cutCount });
    if (j.status === 'error') return ok({ status: 'error', error: j.error });
    return ok({ status: 'pending' });
  }

  // 작업 시작
  if (event.httpMethod !== 'POST') return err(405, 'POST만 허용됩니다');
  let params;
  try { params = JSON.parse(event.body || '{}'); } catch (_) { return err(400, '잘못된 요청입니다'); }
  if (!params.url && !(params.title && params.imageBase64)) return err(400, '상품 링크를 넣거나, 상품명과 사진을 넣어주세요');

  const jobId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  jobs[jobId] = { status: 'pending', ts: Date.now() };
  gcJobs();
  runGeneration(params)
    .then((r) => { jobs[jobId] = { status: 'done', ts: Date.now(), ...r }; })
    .catch((e) => { jobs[jobId] = { status: 'error', ts: Date.now(), error: (e && e.message) || '생성 중 오류가 발생했습니다' }; });

  return ok({ jobId }, 202);
};
