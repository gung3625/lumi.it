'use strict';
// 상세페이지 생성 (공유 모듈). 도매꾹 상품데이터 + 상세이미지(비전 추출) + 소싱 데이터 → 고급 상세페이지.
// 규칙/구조는 aisyncclub/detail_page_codex_skill(MIT)의 copy-compliance·cut-structure·photo-analysis 표준을 이식.
//  - copy-compliance: 위험표현(절대·의료·순위·안전·통계 단정)만 차단, 주관적 어필(저소음 등)은 허용.
//  - photo-analysis: 도매꾹 상세 이미지에서 "읽히는 사실"을 비전으로 추출(추론 금지) → 카피 정확도↑.
const { llmChat } = require('./llm-call');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 도매꾹 이미지의 사이즈변형(_img_150/_330/_760)을 묶어 distinct 이미지만(가장 큰 사이즈) 반환.
function distinctImages(images) {
  const map = new Map();
  for (const u of images || []) {
    const m = String(u).match(/^(.*_img_)(\d+)/);
    const key = m ? m[1] : String(u);
    const size = m ? Number(m[2]) : 0;
    const cur = map.get(key);
    if (!cur || size > cur.size) map.set(key, { url: u, size });
  }
  return [...map.values()].map((x) => x.url);
}

const SYS = [
  '너는 한국 이커머스 1위 상세페이지 카피라이터 겸 머천다이저다. 주어진 상품데이터로 "스크롤하며 사고 싶어지는" 모바일 상세페이지 카피를 쓴다.',
  '',
  '== 좋은 카피 ==',
  '- 헤드라인: 고객이 얻는 구체적 이익을 말한다(감성만 X).  - 서브: 특징을 구매 이유와 연결(특징 나열 X).',
  '- 신뢰: 제공된 인증·리뷰·수치를 근거로(없는 수치 창작 X).  - CTA: 자연스럽게 유도(과도한 압박 X).',
  '- 혜택 중심: 기능 나열이 아니라 "그래서 뭐가 좋아지는가". 슬롭("안정성과 편리함을 동시에", "다양한 기능") 금지.',
  '',
  '== ★위험 표현 필터(이것만 제거/완화. 나머지 표현은 자유) ==',
  '- 절대 주장: 100%·무조건·완벽·보장·평생·반드시 → 제거/완화.',
  '- 의료·질병(승인 없으면): 치료·완치·예방·약효·효과 단정 → 금지.',
  '- 근거 없는 순위: 국내1위·최고·최저가·유일·압도적 → 금지.',
  '- 근거 없는 안전: 부작용 없음·누구나 안전·독성 없음 → 금지.   - 근거 없는 통계: 만족도·재구매율·판매량·누적고객 → 금지.',
  '- 대체 표현: "도움을 줄 수 있는", "편하게 쓸 수 있는", "개인차가 있을 수 있음", "제공된 인증 기준".',
  '★주관적 상대 표현(저소음·편안한·감각적·강력한·촉촉한·세련된)은 위험표현이 아니다 — 적극 써라. 막는 건 위 5종 단정뿐.',
  '',
  '== 사실 다루기 ==',
  '제품 사실(치수·용량·구성품·인증·기능·옵션·색상)은 [상품데이터]·[이미지분석]에 있는 것을 쓴다. 거기 없거나 안 읽히는 사실(구체 수치·작동시간 등)은 추론·창작하지 말고 빼거나 "상세 참조". [이미지분석]에 기능(예 각도조절·풍량)이 있으면 그건 실제이니 적극 활용.',
  '도매 거래조건(MOQ·도매단가·사업자·재판매)은 소비자 카피에 절대 X. 한국어·모바일 가독성·이모지 금지.',
  '',
  '== 컷 흐름(이 순서) ==',
  '메인히어로 → 문제공감 → 해결혜택 → 핵심차별점 → 실물/사용장면 → 신뢰근거 → 구성/옵션 → 배송/주의 → FAQ → CTA.',
  '',
  '== 출력 JSON 키 ==',
  'seoTitle: 검색 잘되는 60자내 제목.  heroHeadline: 첫화면 후킹(이익 중심 12~22자).  heroSub: 보조 한 줄.',
  'concerns: 고객 고민 2~3개("이런 적 없으세요?" 톤, 불만해소 데이터 반영).',
  'benefits: 핵심 혜택 3~4개(혜택+근거).  sections: 실물/사용장면 1~2개[{name,headline,body}].',
  'comparison: {headline:"왜 이 제품인가", points:[차별점 2~3]}.  faq: 소비자질문 2~3개[{q,a}].  closing: 마무리 한 줄.',
  '[소싱데이터]·[이미지분석]이 있으면 적극 반영. 출력은 위 키의 JSON 하나만.',
].join('\n');

const CHECK = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" style="flex:0 0 auto;margin-top:2px;"><circle cx="12" cy="12" r="11" fill="#1a1a1a"/><path d="M7 12.5l3.2 3.2L17 9" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const DIV = '<div style="height:9px;background:#f6f5f3;"></div>';

function specRows(spec) {
  const rows = [];
  if (spec) {
    if (spec.size && /[x×*]/i.test(String(spec.size))) rows.push(['크기', String(spec.size).replace(/[xX*]/g, ' × ') + ' cm']);
    if (spec.weight && /^[0-9.]+$/.test(String(spec.weight)) && parseFloat(spec.weight) > 0) rows.push(['무게', String(spec.weight) + ' kg']);
    if (spec.model) rows.push(['모델명', spec.model]);
    if (spec.country) rows.push(['원산지', String(spec.country).replace(/_/g, ' ')]);
    if (spec.manufacturer) rows.push(['제조/수입', spec.manufacturer]);
    if (spec.kc && spec.kc.length) rows.push(['인증', spec.kc.join(', ')]);
  }
  // ★공급사(도매꾹 셀러) 이름·연락처는 소비자 상세페이지에 절대 노출 X.
  if (!rows.length) return '';
  const trs = rows.map((r) =>
    '<tr><td style="padding:11px 14px;background:#faf9f7;color:#888;font-size:13px;width:34%;border-bottom:1px solid #f0efec;">' + esc(r[0]) + '</td>'
    + '<td style="padding:11px 14px;color:#333;font-size:14px;border-bottom:1px solid #f0efec;">' + esc(r[1]) + '</td></tr>').join('');
  return '<div style="padding:30px 22px;"><h3 style="font-size:18px;font-weight:700;color:#1a1a1a;margin:0 0 14px;">제품 정보</h3>'
    + '<table style="width:100%;border-collapse:collapse;border:1px solid #f0efec;border-radius:10px;overflow:hidden;">' + trs + '</table></div>';
}

function badges(spec) {
  const b = [];
  if (spec && spec.kc && spec.kc.length) b.push('KC 인증');
  if (spec && spec.country) b.push(/국산|한국/.test(spec.country) ? '국산' : '정식 수입');
  b.push('사업자 판매');
  return '<div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;padding:6px 22px 30px;">'
    + b.map((t) => '<span style="font-size:12.5px;color:#5a5a5a;background:#f3f2ef;border:1px solid #e9e8e4;border-radius:999px;padding:6px 13px;">' + esc(t) + '</span>').join('') + '</div>';
}

function shippingBlock() {
  const items = [
    ['배송', '주문 후 신속하게 발송됩니다.'],
    ['교환 · 반품', '수령 후 문제가 있으면 구매 페이지 안내에 따라 처리됩니다.'],
    ['문의', '궁금한 점은 쿠팡 고객센터를 통해 도와드립니다.'],
  ];
  return '<div style="padding:28px 22px;"><h3 style="font-size:18px;font-weight:700;color:#1a1a1a;margin:0 0 14px;">배송 및 교환·반품 안내</h3>'
    + items.map((it) => '<div style="display:flex;gap:12px;padding:8px 0;border-bottom:1px solid #f3f2ef;">'
      + '<span style="flex:0 0 88px;font-size:13.5px;color:#999;font-weight:600;">' + esc(it[0]) + '</span>'
      + '<span style="font-size:14px;color:#555;line-height:1.6;">' + esc(it[1]) + '</span></div>').join('')
    + '</div>';
}

function buildHtml(product, copy) {
  const imgs = distinctImages(product.images || []);
  const c = copy || {};
  const W = (s) => '<div style="max-width:780px;margin:0 auto;font-family:Pretendard,-apple-system,system-ui,sans-serif;background:#fff;color:#1a1a1a;line-height:1.6;">' + s + '</div>';
  let h = '';
  if (imgs[0]) h += '<img src="' + esc(imgs[0]) + '" alt="' + esc(c.seoTitle || product.title) + '" style="width:100%;display:block;">';
  h += '<div style="padding:38px 24px 24px;text-align:center;">'
    + '<h1 style="font-size:26px;font-weight:800;color:#161616;margin:0 0 12px;line-height:1.35;letter-spacing:-0.3px;">' + esc(c.heroHeadline || c.seoTitle || product.title) + '</h1>'
    + (c.heroSub ? '<p style="font-size:15px;color:#777;margin:0;line-height:1.6;">' + esc(c.heroSub) + '</p>' : '')
    + '</div>';
  if (Array.isArray(c.concerns) && c.concerns.length) {
    h += DIV + '<div style="padding:32px 24px;background:#f8f6f3;">'
      + '<p style="font-size:13px;color:#b08968;font-weight:700;letter-spacing:0.5px;margin:0 0 14px;text-align:center;">혹시, 이런 적 없으세요?</p>'
      + c.concerns.map((x) => '<div style="background:#fff;border:1px solid #efe9e2;border-radius:10px;padding:14px 16px;margin:0 0 10px;font-size:15px;color:#5b5249;line-height:1.55;">' + esc(x) + '</div>').join('')
      + '</div>';
  }
  if (Array.isArray(c.benefits) && c.benefits.length) {
    h += DIV + '<div style="padding:34px 24px 30px;max-width:520px;margin:0 auto;">'
      + '<h3 style="font-size:20px;font-weight:700;color:#1a1a1a;margin:0 0 18px;text-align:center;">이 제품이 해결합니다</h3>'
      + c.benefits.map((b) => '<div style="display:flex;gap:11px;align-items:flex-start;padding:9px 0;">' + CHECK
        + '<span style="font-size:15.5px;color:#2b2b2b;line-height:1.55;">' + esc(b) + '</span></div>').join('')
      + '</div>';
  }
  (Array.isArray(c.sections) ? c.sections : []).forEach((s, i) => {
    const img = imgs.length ? imgs[(i + 1) % imgs.length] : null;
    h += DIV + '<section style="padding:34px 24px;">'
      + (img ? '<img src="' + esc(img) + '" alt="" style="width:100%;display:block;border-radius:12px;margin:0 0 20px;">' : '')
      + (s.headline ? '<h3 style="font-size:21px;font-weight:700;color:#1a1a1a;margin:0 0 12px;line-height:1.4;letter-spacing:-0.2px;">' + esc(s.headline) + '</h3>' : '')
      + '<p style="font-size:15.5px;color:#555;line-height:1.85;margin:0;white-space:pre-line;">' + esc(s.body || '') + '</p>'
      + '</section>';
  });
  if (c.comparison && Array.isArray(c.comparison.points) && c.comparison.points.length) {
    h += DIV + '<div style="padding:34px 24px;background:#f4f6f5;">'
      + '<h3 style="font-size:20px;font-weight:700;color:#1a1a1a;margin:0 0 18px;text-align:center;">' + esc(c.comparison.headline || '왜 이 제품일까요?') + '</h3>'
      + '<div style="max-width:520px;margin:0 auto;">'
      + c.comparison.points.map((p) => '<div style="display:flex;gap:11px;align-items:flex-start;background:#fff;border:1px solid #e6ece9;border-radius:10px;padding:14px 16px;margin:0 0 10px;">' + CHECK
        + '<span style="font-size:15px;color:#2b2b2b;line-height:1.55;">' + esc(p) + '</span></div>').join('')
      + '</div></div>';
  }
  h += DIV + specRows(product.spec);
  h += badges(product.spec);
  if (Array.isArray(c.faq) && c.faq.length) {
    h += DIV + '<div style="padding:30px 22px;">'
      + '<h3 style="font-size:18px;font-weight:700;color:#1a1a1a;margin:0 0 16px;">자주 묻는 질문</h3>'
      + c.faq.map((f) => '<div style="border-bottom:1px solid #f0efec;padding:14px 0;">'
        + '<p style="font-size:15px;font-weight:600;color:#1a1a1a;margin:0 0 6px;">Q. ' + esc(f.q) + '</p>'
        + '<p style="font-size:14.5px;color:#666;margin:0;line-height:1.7;">' + esc(f.a) + '</p></div>').join('')
      + '</div>';
  }
  h += DIV + shippingBlock();
  if (c.closing) h += '<div style="background:#161616;color:#fff;padding:36px 24px;text-align:center;">'
    + '<p style="font-size:18px;font-weight:700;margin:0;line-height:1.5;">' + esc(c.closing) + '</p></div>';
  return W(h);
}

// photo-analysis: 도매꾹 상세 이미지에서 "읽히는 사실"만 비전 추출(추론 금지). 무료 Gemini. best-effort(실패시 null).
async function analyzeProductImages(images, title) {
  const urls = distinctImages(images || []).slice(0, 5);
  if (!urls.length) return null;
  const prompt = '아래는 상품 "' + (title || '') + '"의 상세 이미지들이다. ★오직 이 상품 자체의 사실만 한국어로 추출하라. 같은 페이지에 다른 모델·관련상품·세트 카탈로그·타 사양(제목과 명백히 다른 단수/형태/용도)이 섞여 있으면 그건 무시하라(제목 "' + (title || '') + '"과 맞는 것만). 읽히는 사실(기능 예 각도조절·풍량단수, 옵션·색상, 수치, 인증, 구성품, 소재, 사용법)만. ★제외(절대 포함 금지): 판매자·회사 연락처/전화번호, 상담시간, 배송·교환·반품 정책, 휴무, CCTV, 회사소개. 안 보이거나 불확실하면 추론·창작 금지. JSON으로만: {"facts":["사실1"...]}';
  try {
    const res = await llmChat({
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...urls.map((u) => ({ type: 'image_url', image_url: { url: u } }))] }],
      max_tokens: 700,
      response_format: { type: 'json_object' },
    }, { sensitive: false, provider: 'gemini', label: 'photo-analysis', timeoutMs: 70000 });
    const d = await res.json();
    const txt = d && d.choices && d.choices[0] && d.choices[0].message ? d.choices[0].message.content : '';
    const o = JSON.parse(String(txt).replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim());
    const DROP = /전화|연락처|상담|배송|발송|마감|휴무|cctv|문의|교환|반품|평일|오전|오후|정책|주문\s*변경|\d{2,4}[.\-]\d{3,4}/i;
    const facts = Array.isArray(o.facts) ? o.facts.filter((x) => x && String(x).trim() && !DROP.test(String(x))).slice(0, 12) : [];
    return facts.length ? facts : null;
  } catch (_) { return null; }
}

// 위험 표현 결정적 안전망(프롬프트가 놓친 절대·순위 단정을 부드럽게 치환). copy-compliance 기준.
const SOFTEN = [[/완벽히/g, '세심하게'], [/완벽한/g, '뛰어난'], [/완벽/g, '우수'], [/100\s*%/g, '높은 수준'], [/무조건/g, '언제든'], [/\s?보장(?=[\s.,!]|$)/g, ''], [/평생/g, '오래'], [/최고급/g, '고급'], [/최고의/g, '우수한'], [/최고(?![급])/g, '우수'], [/최저가/g, '합리적인 가격'], [/유일무이한?/g, '특별한'], [/유일한/g, '특별한'], [/국내\s*1위/g, '인기'], [/업계\s*1위/g, '인기']];
function softenClaims(copy) {
  const fix = (s) => typeof s === 'string' ? SOFTEN.reduce((a, [re, to]) => a.replace(re, to), s) : s;
  const walk = (v) => Array.isArray(v) ? v.map(walk) : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : fix(v);
  return walk(copy);
}

// 상품(getItemView 결과) + 소싱 힌트 → { copy, html, imageFacts } 또는 { error }.
async function generateDetailPage(product, { diffHook, painPoints, sellingHook, model, skipVision } = {}) {
  const sp = product.spec || {};
  const visionImgs = (product.descImages && product.descImages.length) ? product.descImages : product.images;
  const imageFacts = skipVision ? null : await analyzeProductImages(visionImgs, product.title);
  const ctx = {
    상품명: product.title,
    카테고리: (product.categoryTree || []).join(' > ') || null,
    키워드: (product.keywords || []).slice(0, 8),
    스펙: { 크기: sp.size || null, 무게: sp.weight || null, 원산지: sp.country || null, 제조사: sp.manufacturer || null, 모델: sp.model || null, 인증: (sp.kc || []) },
    옵션: (product.options || []).slice(0, 10),
    이미지분석: imageFacts,
    소싱데이터: { 차별화: diffHook || null, 불만해소: painPoints || null, 판매전술: sellingHook || null },
  };
  let copy = null, llmErr = null;
  try {
    const res = await llmChat({
      model: model || 'gpt-4o',
      messages: [{ role: 'system', content: SYS }, { role: 'user', content: '상품데이터:\n' + JSON.stringify(ctx, null, 1) + '\n\n위 데이터(상품데이터·이미지분석에 있는 사실만)로 컷 흐름의 고급 상세페이지 카피를 JSON으로 작성.' }],
      max_tokens: 3800,
      response_format: { type: 'json_object' },
    }, { sensitive: false, label: 'detail-page', timeoutMs: 90000 });
    const d = await res.json();
    const txt = d && d.choices && d.choices[0] && d.choices[0].message ? d.choices[0].message.content : '';
    copy = JSON.parse(String(txt).replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim());
  } catch (e) { llmErr = e && e.message ? e.message : 'LLM 생성 실패'; }
  if (!copy || (!copy.heroHeadline && !Array.isArray(copy.sections) && !Array.isArray(copy.benefits))) return { error: llmErr || '빈 응답' };
  if (!Array.isArray(copy.sections)) copy.sections = [];
  copy = softenClaims(copy); // 절대·순위 단정 결정적 제거(안전망)
  return { copy, html: buildHtml(product, copy), imageFacts };
}

module.exports = { generateDetailPage, buildHtml, analyzeProductImages, distinctImages, SYS, esc };
