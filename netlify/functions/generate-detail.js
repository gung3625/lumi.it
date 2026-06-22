// 상세페이지 생성 API (고객용 웹서비스)
// 핵심: 도매꾹 상품 링크(url) 붙여넣기 → getItemView로 페이지 읽고 → 상세컷 비전 분석 → AI 화보 + 카피 + 디자인 컷.
// 보조: 사진 직접 업로드(title + imageBase64) 모드도 지원.
const { generateDetailPage, generateAiPhoto, photoPrompt, cutPlan, assembleCutPage } = require('./_shared/detail-page.js');
const { getItemView } = require('./_shared/domeggook-api.js');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const stripDataUri = (s) => String(s || '').replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
const err = (code, msg) => ({ statusCode: code, headers, body: JSON.stringify({ error: msg }) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return err(405, 'POST만 허용됩니다');

  try {
    const { url, title, features, imageBase64, quality, skipPhoto } = JSON.parse(event.body || '{}');
    let product, srcForPhoto;

    if (url) {
      // ── URL 모드: 도매꾹 상품 링크 → 페이지 분석 ──
      const no = (String(url).match(/(\d{6,})/) || [])[1];
      if (!no) return err(400, '도매꾹 상품 링크가 맞는지 확인해 주세요');
      const item = await getItemView(no);
      if (!item || !item.title) return err(502, '상품 정보를 불러오지 못했습니다. 도매꾹 상품 링크인지 확인해 주세요');
      srcForPhoto = (item.images || [])[0] || null;
      product = {
        title: item.title,
        spec: item.spec || {},
        options: item.options || [],
        descImages: item.descImages || [],
        images: (item.images || []).slice(0, 4),
        keywords: item.keywords || [],
        categoryTree: item.categoryTree || [],
      };
    } else {
      // ── 업로드 모드: 사진 직접 ──
      if (!title || !imageBase64) return err(400, '상품 링크를 넣거나, 상품명과 사진을 넣어주세요');
      srcForPhoto = stripDataUri(imageBase64);
      product = { title, spec: {}, options: [], images: [], descImages: [] };
    }

    // 1) 베이스 화보(깨끗한 단일 제품) — 모든 디자인 컷의 입력이 됨
    let baseB64 = null;
    if (!skipPhoto && srcForPhoto) baseB64 = await generateAiPhoto(srcForPhoto, photoPrompt(product.title), { quality: 'low' });

    // 2) 카피(URL 모드는 도매꾹 상세컷 비전 그라운딩)
    const result = await generateDetailPage(product, { sellingHook: features || '', skipVision: !url });
    if (!result || result.error) return err(502, result && result.error ? result.error : '카피 생성 실패');
    const copy = result.copy || {};

    // 3) 디자인 컷 — 베이스 화보를 입력으로 컷별 다른 연출(히어로·손모델·혜택·색상·비교·CTA) 병렬 생성 → 컷+설명 조립
    let html = result.html, cutCount = 0;
    if (baseB64) {
      const plan = cutPlan(product, copy);
      const cuts = await Promise.all(plan.map(async (p) => ({ img: await generateAiPhoto(baseB64, p.prompt, { quality: quality || 'medium' }), title: p.title, desc: p.desc })));
      cutCount = cuts.filter((c) => c.img).length;
      if (cutCount >= 2) html = assembleCutPage(cuts); // 컷 대부분 성공 → 디자인 컷 페이지(아니면 buildHtml 폴백)
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        title: product.title,
        html,
        copy,
        reviewPoints: result.reviewPoints || [],
        photoGenerated: !!baseB64,
        cutCount,
      }),
    };
  } catch (e) {
    console.log('[generate-detail] 처리 실패');
    return err(500, '상세페이지 생성 중 오류가 발생했습니다');
  }
};
