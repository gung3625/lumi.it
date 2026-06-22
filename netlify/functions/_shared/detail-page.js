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
  '== ★기획 설계가 먼저(가장 중요) ==',
  '그냥 구조만 채우지 마라. 먼저 [상품명]·[카테고리]·[이미지분석]으로 "이 제품군에서 고객의 구매를 결정하는 핵심 축"을 파악하고, 그 축으로 카피를 설계한다.',
  '- 제품군별 핵심 축 예시: 화장품=텍스처·성분근거·사용감·인증 / 텀블러·주방=용량·보온보냉·재질·세척 / 의류=핏·소재·착용감 / 가전·전자=성능·호환·안전 / 생활용품=편의·내구·공간활용.',
  '- 그 제품군에서 고객이 사기 전 가장 궁금·불안해하는 것을 반드시 다룬다(텀블러=보온지속·세척·용량 / 화장품=텍스처·자극감). 이게 빠지면 실패한 카피다.',
  '- 다른 제품에도 그대로 통하는 일반 카피(예 "안정성과 편리함을 동시에")는 설계 실패다. 오직 [상품명]의 실제 소구점에만 맞춘다.',
  '',
  '== 좋은 카피 ==',
  '- 헤드라인: 고객이 얻는 구체적 이익을 말한다(감성만 X).  - 서브: 특징을 구매 이유와 연결(특징 나열 X).',
  '- 신뢰: 제공된 인증·리뷰·수치를 근거로(없는 수치 창작 X).  - CTA: 자연스럽게 유도(과도한 압박 X).',
  '- 혜택 중심: 기능 나열이 아니라 "그래서 뭐가 좋아지는가". 슬롭("안정성과 편리함을 동시에", "다양한 기능") 금지.',
  '- 섹션 연결(브릿지): concerns(고민)→benefits(해결)→comparison(차별점)이 논리로 이어지게 쓴다. "우리가 답이다"식 단절 금지 — 고민 제기→그 원인·신호→해결로 흐른다.',
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
  'reviewPoints: 판매자가 출고 전 꼭 확인할 항목 2~4개(추정으로 채운 사양, 강하게 단정한 카피, 빠졌을 수 있는 정보). 소비자 비노출 — 판매자 검수용.',
  '[소싱데이터]·[이미지분석]이 있으면 적극 반영. 출력은 위 키의 JSON 하나만.',
].join('\n');

const A = '#b3724a', INK = '#1a1613', MUT = '#8c8279', PAPER = '#f4f0ea', LINE = '#e9e3d9';
const eyebrow = (t) => '<p style="font-size:12px;font-weight:700;letter-spacing:2.5px;color:' + A + ';margin:0 0 16px;text-transform:uppercase;">' + esc(t) + '</p>';

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
  const rowsH = rows.map((r) =>
    '<div style="display:flex;justify-content:space-between;gap:20px;padding:15px 0;border-top:1px solid ' + LINE + ';">'
    + '<span style="font-size:14px;color:' + MUT + ';">' + esc(r[0]) + '</span>'
    + '<span style="font-size:14px;color:' + INK + ';font-weight:500;text-align:right;">' + esc(r[1]) + '</span></div>').join('');
  return '<div style="padding:52px 34px;">' + eyebrow('Product Info')
    + '<h2 style="font-size:22px;font-weight:800;letter-spacing:-0.5px;color:' + INK + ';margin:0 0 18px;">제품 정보</h2>'
    + '<div style="border-bottom:1px solid ' + LINE + ';">' + rowsH + '</div></div>';
}

function badges(spec) {
  const b = [];
  if (spec && spec.kc && spec.kc.length) b.push('KC 인증');
  if (spec && spec.country) b.push(/국산|한국/.test(spec.country) ? '국산' : '정식 수입');
  b.push('사업자 판매');
  return '<div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:center;padding:0 34px 52px;">'
    + b.map((t) => '<span style="font-size:12.5px;letter-spacing:0.3px;color:' + INK + ';border:1px solid ' + LINE + ';border-radius:2px;padding:8px 16px;">' + esc(t) + '</span>').join('') + '</div>';
}

function shippingBlock() {
  const items = [
    ['배송', '주문 후 신속하게 발송됩니다.'],
    ['교환 · 반품', '수령 후 문제가 있으면 구매 페이지 안내에 따라 처리됩니다.'],
    ['문의', '궁금한 점은 쿠팡 고객센터를 통해 도와드립니다.'],
  ];
  return '<div style="padding:48px 34px;background:' + PAPER + ';">' + eyebrow('Notice')
    + '<h2 style="font-size:20px;font-weight:800;color:' + INK + ';margin:0 0 18px;letter-spacing:-0.5px;">배송 · 교환 · 반품</h2>'
    + items.map((it) => '<div style="display:flex;gap:16px;padding:13px 0;border-top:1px solid ' + LINE + ';">'
      + '<span style="flex:0 0 84px;font-size:13px;color:' + A + ';font-weight:700;">' + esc(it[0]) + '</span>'
      + '<span style="font-size:14px;color:#6b6259;line-height:1.7;">' + esc(it[1]) + '</span></div>').join('')
    + '</div>';
}

function buildHtml(product, copy) {
  const imgs = distinctImages(product.images || []);
  const c = copy || {};
  const W = (s) => '<div style="max-width:720px;margin:0 auto;font-family:Pretendard,-apple-system,system-ui,sans-serif;background:#fff;color:' + INK + ';line-height:1.6;">' + s + '</div>';
  let h = '';

  // HERO — 풀블리드 이미지 + 에디토리얼 타이틀 블록(크림)
  if (imgs[0]) h += '<img src="' + esc(imgs[0]) + '" alt="' + esc(c.seoTitle || product.title) + '" style="width:100%;display:block;">';
  h += '<div style="padding:58px 32px 50px;text-align:center;background:' + PAPER + ';">'
    + '<div style="width:36px;height:2px;background:' + A + ';margin:0 auto 22px;"></div>'
    + '<h1 style="font-size:33px;font-weight:800;letter-spacing:-1px;line-height:1.28;margin:0 0 18px;color:' + INK + ';">' + esc(c.heroHeadline || c.seoTitle || product.title) + '</h1>'
    + (c.heroSub ? '<p style="font-size:16px;color:' + MUT + ';line-height:1.75;margin:0 auto;max-width:430px;">' + esc(c.heroSub) + '</p>' : '')
    + '</div>';

  // 고객 고민 — 중앙 정렬, 큰 헤드라인, 헤어라인
  if (Array.isArray(c.concerns) && c.concerns.length) {
    h += '<div style="padding:56px 34px;text-align:center;">' + eyebrow('Your Concern')
      + '<h2 style="font-size:24px;font-weight:800;letter-spacing:-0.6px;color:' + INK + ';margin:0 0 28px;line-height:1.4;">혹시, 이런 고민<br>있으셨나요?</h2>'
      + '<div style="max-width:460px;margin:0 auto;">'
      + c.concerns.map((x, i) => '<p style="font-size:17px;color:#544c44;line-height:1.6;margin:0;padding:18px 0;' + (i ? 'border-top:1px solid ' + LINE + ';' : '') + '">' + esc(x) + '</p>').join('')
      + '</div></div>';
  }

  // 혜택 — 번호 매긴 리스트(크림)
  if (Array.isArray(c.benefits) && c.benefits.length) {
    h += '<div style="padding:56px 34px;background:' + PAPER + ';"><div style="text-align:center;">' + eyebrow('Why It Matters')
      + '<h2 style="font-size:24px;font-weight:800;letter-spacing:-0.6px;color:' + INK + ';margin:0 0 32px;">이런 점이 다릅니다</h2></div>'
      + '<div style="max-width:480px;margin:0 auto;">'
      + c.benefits.map((b, i) => '<div style="display:flex;gap:18px;align-items:baseline;padding:18px 0;' + (i ? 'border-top:1px solid ' + LINE + ';' : '') + '">'
        + '<span style="flex:0 0 auto;font-size:15px;font-weight:800;color:' + A + ';letter-spacing:0.5px;">' + String(i + 1).padStart(2, '0') + '</span>'
        + '<span style="font-size:17px;color:' + INK + ';line-height:1.55;font-weight:500;">' + esc(b) + '</span></div>').join('')
      + '</div></div>';
  }

  // 실물/사용 섹션 — 풀블리드 이미지 + 번호 + 큰 헤드라인
  (Array.isArray(c.sections) ? c.sections : []).forEach((s, i) => {
    const img = imgs.length ? imgs[(i + 1) % imgs.length] : null;
    h += (img ? '<img src="' + esc(img) + '" alt="" style="width:100%;display:block;">' : '')
      + '<div style="padding:50px 34px;">'
      + '<span style="font-size:14px;font-weight:800;color:' + A + ';letter-spacing:1px;">' + String(i + 2).padStart(2, '0') + '</span>'
      + (s.headline ? '<h2 style="font-size:25px;font-weight:800;color:' + INK + ';margin:14px 0 14px;line-height:1.35;letter-spacing:-0.5px;">' + esc(s.headline) + '</h2>' : '')
      + '<p style="font-size:16px;color:#5f574e;line-height:1.9;margin:0;white-space:pre-line;">' + esc(s.body || '') + '</p>'
      + '</div>';
  });

  // 경쟁 비교 — 다크 포인트 섹션
  if (c.comparison && Array.isArray(c.comparison.points) && c.comparison.points.length) {
    h += '<div style="padding:56px 34px;background:' + INK + ';color:#fff;text-align:center;">'
      + '<p style="font-size:12px;font-weight:700;letter-spacing:2.5px;color:' + A + ';margin:0 0 16px;text-transform:uppercase;">The Difference</p>'
      + '<h2 style="font-size:24px;font-weight:800;letter-spacing:-0.6px;margin:0 0 30px;color:#fff;">' + esc(c.comparison.headline || '왜 이 제품일까요?') + '</h2>'
      + '<div style="max-width:460px;margin:0 auto;">'
      + c.comparison.points.map((p, i) => '<p style="font-size:16.5px;color:#e8e2da;line-height:1.6;margin:0;padding:17px 0;' + (i ? 'border-top:1px solid rgba(255,255,255,0.12);' : '') + '">' + esc(p) + '</p>').join('')
      + '</div></div>';
  }

  h += specRows(product.spec);
  h += badges(product.spec);

  // FAQ (크림)
  if (Array.isArray(c.faq) && c.faq.length) {
    h += '<div style="padding:50px 34px;background:' + PAPER + ';">' + eyebrow('FAQ')
      + '<h2 style="font-size:22px;font-weight:800;color:' + INK + ';margin:0 0 20px;letter-spacing:-0.5px;">자주 묻는 질문</h2>'
      + c.faq.map((f, i) => '<div style="padding:18px 0;' + (i ? 'border-top:1px solid ' + LINE + ';' : '') + '">'
        + '<p style="font-size:16px;font-weight:700;color:' + INK + ';margin:0 0 8px;">' + esc(f.q) + '</p>'
        + '<p style="font-size:14.5px;color:#6b6259;margin:0;line-height:1.75;">' + esc(f.a) + '</p></div>').join('')
      + '</div>';
  }

  h += shippingBlock();

  // CTA — 다크 + 악센트 룰
  if (c.closing) h += '<div style="background:' + INK + ';color:#fff;padding:60px 34px;text-align:center;">'
    + '<div style="width:36px;height:2px;background:' + A + ';margin:0 auto 24px;"></div>'
    + '<p style="font-size:21px;font-weight:700;margin:0;line-height:1.55;letter-spacing:-0.3px;">' + esc(c.closing) + '</p></div>';

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
  return { copy, html: buildHtml(product, copy), imageFacts, reviewPoints: Array.isArray(copy.reviewPoints) ? copy.reviewPoints : [] };
}

// gpt-image-2 edits로 도매꾹 사진→고급 화보(제품 유지). src=https URL 또는 base64 PNG. 실패 시 null. low=장당 ~19원.
async function generateAiPhoto(src, prompt, { quality = 'low', size = '1024x1536' } = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !src) return null;
  let buf, ct = 'image/png';
  try {
    if (/^https?:/i.test(src)) {
      const r = await fetch(src, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) return null;
      buf = Buffer.from(await r.arrayBuffer());
      const c = (r.headers.get('content-type') || '').toLowerCase();
      if (/jpe?g/.test(c)) ct = 'image/jpeg'; else if (/webp/.test(c)) ct = 'image/webp'; else if (/png/.test(c)) ct = 'image/png'; else ct = 'image/jpeg'; // 도매꾹 octet-stream → jpeg 가정
    } else { buf = Buffer.from(src, 'base64'); }
  } catch (_) { return null; }
  const ext = (ct.split('/')[1] || 'jpg');
  // gpt-image-2 edits — 일시 실패/rate limit가 있어 최대 3회 시도(컷 누락 방지). 재시도 전 점증 대기.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
    try {
      const form = new FormData();
      form.append('model', 'gpt-image-2');
      form.append('prompt', prompt);
      form.append('image', new Blob([buf], { type: ct }), 'src.' + ext);
      form.append('size', size);
      form.append('quality', quality);
      const res = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form, signal: AbortSignal.timeout(120000) });
      const j = await res.json();
      if (j && !j.error && j.data && j.data[0] && j.data[0].b64_json) return j.data[0].b64_json;
    } catch (_) {}
  }
  return null;
}

// 제품 유지 + 어울리는 라이프스타일 연출 프롬프트.
// 입력이 도매꾹 막샷(여러 제품·텍스트·잡배경)이어도 깨끗한 단일 화보가 나오도록 강하게 지시.
function photoPrompt(title) {
  return 'Take the single main product from this image (' + String(title || '').slice(0, 60) + ') and create a premium lifestyle marketing photo of it. '
    + 'Show ONLY ONE product — if the input shows several units, keep just the single most prominent one and remove the rest. '
    + 'COMPLETELY REPLACE the background with a clean, tasteful real-life scene (marble counter or styled tabletop), soft natural window light, minimal complementary props. '
    + 'REMOVE every text overlay, price tag, korean caption, logo banner and watermark that exists in the original photo. '
    + "Keep the product's true shape, color and material, but compose a fresh studio-quality scene. "
    + 'Photorealistic high-end commercial product photography, vertical composition, no text anywhere.';
}

// ===== 디자인 컷 방식(레퍼런스급) — 베이스 화보 → 컷별 다른 연출 디자인 이미지 + 설명 텍스트 교대 =====
const CUT_BASE = 'Vibrant premium Korean e-commerce product detail page section. Keep THIS exact product faithful in shape and design. Soft tasteful gradient background with decorative graphics matching the product mood. ABSOLUTELY NO shopping-mall navigation bar, NO brand logo, NO fake website UI on top. Polished colorful commercial marketing design, vertical, clean Korean typography, no watermark. ';

// 카피·옵션 기반 컷 계획 → [{key, prompt(컷 생성용), title/desc(설명 텍스트용)}]. 연출을 컷마다 다르게(히어로·손모델·혜택·색상·비교·CTA).
function cutPlan(product, copy) {
  const c = copy || {};
  const colors = [...new Set((product.options || []).map((o) => String(o).replace(/\(.*?\)/g, '').replace(/[[\]]/g, '').trim()).filter(Boolean))].slice(0, 6);
  const cut = (s) => String(s || '').slice(0, 30);
  const plan = [
    { key: 'hero', title: c.heroHeadline || product.title, desc: c.heroSub || '',
      prompt: CUT_BASE + 'HERO section. The product as centerpiece at a dynamic three-quarter TILTED angle with energy and motion. Large bold Korean headline: "' + cut(c.heroHeadline || product.title) + '". Add a small highlight badge.' },
    { key: 'scene', title: (c.sections && c.sections[0] && c.sections[0].headline) || '일상 속에서', desc: (c.sections && c.sections[0] && c.sections[0].body) || '',
      prompt: CUT_BASE + 'LIFESTYLE section: a person naturally using or holding this exact product, eye-level candid angle, hand visible, warm authentic mood, soft natural light.' },
    { key: 'detail', title: '꼼꼼한 디테일', desc: '',
      prompt: CUT_BASE + 'DETAIL section. Extreme CLOSE-UP macro shot of the product key parts (lid, opening, handle), shallow depth of field, showing premium texture and build quality.' },
    { key: 'benefit', title: '이런 점이 다릅니다', desc: (c.benefits || []).join('  ·  '),
      prompt: CUT_BASE + 'BENEFITS section, the product shown from a clean TOP-DOWN flat-lay angle. Korean headline "이런 점이 다릅니다". Three benefit points with simple clean icons and short Korean labels reflecting: ' + (c.benefits || []).slice(0, 3).join(' / ').slice(0, 110) + '.' },
  ];
  if (colors.length >= 2) plan.push({ key: 'color', title: '다양한 컬러', desc: '컬러 옵션: ' + colors.join(', '),
    prompt: CUT_BASE + 'COLOR LINEUP section. Korean headline "다양한 컬러". Show this exact product rendered in several real colors (' + colors.join(', ') + ') arranged neatly like a color lineup photo.' });
  if (c.comparison && Array.isArray(c.comparison.points) && c.comparison.points.length) plan.push({ key: 'compare', title: c.comparison.headline || '왜 이 제품인가', desc: (c.comparison.points || []).join('  ·  '),
    prompt: CUT_BASE + 'COMPARISON section. Korean headline "' + cut(c.comparison.headline || '왜 이 제품인가') + '". A clean comparison graphic highlighting the product advantage.' });
  plan.push({ key: 'cta', title: c.closing || '지금 만나보세요', desc: '',
    prompt: CUT_BASE + 'CLOSING section. Large elegant Korean headline "' + cut(c.closing || '지금 만나보세요') + '". Refined gradient, subtle sparkles, premium finish.' });
  return plan;
}

// HSL → hex (h:0~360, s/l:0~1)
function hslHex(h, s, l) {
  h /= 360; const f = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  let r, g, b; if (s === 0) { r = g = b = l; } else { const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3); }
  return '#' + [r, g, b].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

// 이미지(화보)에서 제품 대표색 추출 → {accent, soft(연한 배경), ink(짙은 제목)}. 무채색이면 null(기본 팔레트). 무료 sharp.
async function accentPalette(src) {
  let sharp; try { sharp = require('sharp'); } catch (_) { return null; }
  try {
    const buf = /^https?:/i.test(src) ? Buffer.from(await (await fetch(src)).arrayBuffer()) : Buffer.from(src, 'base64');
    const { data, info } = await sharp(buf).resize(64, 64, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const ch = info.channels, bk = {};
    for (let i = 0; i < data.length; i += ch) {
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
      if (d < 0.001) continue;
      const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (s < 0.22 || l < 0.16 || l > 0.9) continue;
      let h; if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)); else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
      h = (Math.round(h * 60) % 360 + 360) % 360; const key = (Math.round(h / 15) * 15) % 360;
      if (!bk[key]) bk[key] = { c: 0, s: 0 }; bk[key].c++; bk[key].s += s;
    }
    let best = null; for (const k in bk) if (best === null || bk[k].c > bk[best].c) best = k;
    if (best === null) return null;
    const h = Number(best), s = Math.min(0.6, bk[best].s / bk[best].c);
    return { accent: hslHex(h, s, 0.45), soft: hslHex(h, Math.min(0.38, s), 0.95), ink: hslHex(h, Math.min(0.5, s + 0.1), 0.18) };
  } catch (_) { return null; }
}

// 컷 이미지(base64) + 설명 텍스트(제품색 연한배경/흰 교대) 조립 → 풀 상세페이지 HTML.
function assembleCutPage(cuts, palette) {
  const p = palette || {};
  const T1 = p.ink || '#15302c', SOFT = p.soft || '#eef7f5', MUT2 = '#5a6864';
  let h = '', ti = 0;
  (cuts || []).forEach((c) => {
    if (c.img) h += '<img src="data:image/png;base64,' + c.img + '" alt="" style="width:100%;display:block;">';
    if (c.desc) {
      const tint = ti % 2 === 0; ti++;
      h += '<div style="padding:56px 54px;text-align:center;background:' + (tint ? SOFT : '#fff') + ';">'
        + (c.title ? '<h3 style="font-size:30px;font-weight:800;letter-spacing:-1px;color:' + T1 + ';line-height:1.35;margin:0 0 16px;">' + esc(c.title) + '</h3>' : '')
        + '<p style="font-size:18px;color:' + MUT2 + ';line-height:1.85;max-width:760px;margin:0 auto;">' + esc(c.desc) + '</p></div>';
    }
  });
  return '<div style="max-width:1024px;margin:0 auto;background:#fff;font-family:Pretendard,-apple-system,system-ui,sans-serif;">' + h + '</div>';
}

module.exports = { generateDetailPage, buildHtml, analyzeProductImages, distinctImages, generateAiPhoto, photoPrompt, cutPlan, assembleCutPage, accentPalette, SYS, esc };
