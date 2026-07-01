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
  'seoTitle: 검색 잘되는 60자내 제목.  heroKicker: 헤드라인 위 작은 영문 라벨(대문자 영어 2~4단어, 예 WINTER COLLECTION/DAILY ESSENTIAL — 제품 카테고리·콘셉트를 영어로).  heroHeadline: 첫화면 후킹(이익 중심 12~22자).  heroEmphasis: heroHeadline 안에서 강조할 핵심 단어/구 1개 — heroHeadline에 "그대로 포함된" 부분 문자열이어야 함(색 강조용).  heroSub: 보조 한 줄.',
  'concerns: 고객 고민 2~3개("이런 적 없으세요?" 톤, 불만해소 데이터 반영).',
  'benefits: 핵심 혜택 3~4개(혜택+근거).  featureLabels: 핵심 기능/특징을 아이콘 옆에 넣을 "짧은 명사 키워드" 4개(각 4~7자, 예 "기모 안감"·"퀼팅 패턴"·"세트 구성" — 완전한 문장 금지, 서술형 금지).  sections: 실물/사용장면·핵심기능 2~4개[{name,headline,body,visual}]. ★visual = 이 섹션의 "의미"를 보여줄 이미지를 영어 한 줄로 구체 지시(제품이 무엇과·어떻게 보이는지). 단순 "제품 정면"이 아니라 그 섹션이 말하는 바를 시각화 — 예: 보온강조면 "ice cubes still fully frozen inside the cup after hours, cold condensation"; 대용량이면 "filled to the brim beside a regular cup for size comparison"; 휴대편의면 "held in a hand or clipped to a bag on the go"; 디자인소개면 "clean premium studio hero shot, 3/4 angle". 기능 섹션엔 그 기능을 시연/은유하는 장면을, 디자인 섹션엔 예쁜 구도를.',
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

// 세로로 긴 상세이미지는 통째로 넣으면 AI vision이 축소→작은 글씨가 깨짐. 세로 타일로 잘라 각 조각 고해상도 유지 → 정확한 분석.
async function tileTall(src, maxTiles) {
  const sharp = require('sharp');
  try {
    let buf;
    if (/^https?:/i.test(src)) { const r = await fetch(src, { signal: AbortSignal.timeout(20000) }); if (!r.ok) return [src]; buf = Buffer.from(await r.arrayBuffer()); }
    else if (/^data:/i.test(src)) buf = Buffer.from(String(src).replace(/^data:[^,]+,/, ''), 'base64');
    else buf = Buffer.from(src, 'base64');
    const m = await sharp(buf).metadata();
    const W = m.width || 0, H = m.height || 0;
    // 세로가 가로의 1.8배 이하면 분할 불필요(그대로 1장). 1.8로 낮춤 — 여주환(비율 2.0)처럼 작은 상세도 분할되게.
    if (!W || !H || H <= W * 1.8) return ['data:image/jpeg;base64,' + (await sharp(buf).jpeg({ quality: 88 }).toBuffer()).toString('base64')];
    const tiles = Math.min(maxTiles || 8, Math.max(2, Math.round(H / (W * 1.3))));
    const th = Math.ceil(H / tiles);
    const out = [];
    for (let i = 0; i < tiles; i++) { const top = i * th, h = Math.min(th, H - top); if (h <= 10) break; const t = await sharp(buf).extract({ left: 0, top, width: W, height: h }).jpeg({ quality: 88 }).toBuffer(); out.push('data:image/jpeg;base64,' + t.toString('base64')); }
    return out.length ? out : [src];
  } catch (_) { return [src]; }
}

// photo-analysis: 상세 이미지에서 "읽히는 사실"만 비전 추출(추론 금지). 긴 이미지는 타일 분할로 작은 글씨까지 정확히. best-effort(실패시 null).
async function analyzeProductImages(images, title, model) {
  const srcs = distinctImages(images || []).slice(0, 5);
  if (!srcs.length) return null;
  // 긴 상세이미지는 세로로 잘라 조각마다 고해상도 분석(작은 글씨 보존). 전체 조각 최대 12장.
  let urls = [];
  for (const s of srcs) { const tiles = await tileTall(s, 8); for (const u of tiles) { if (urls.length < 12) urls.push(u); } if (urls.length >= 12) break; }
  if (!urls.length) return null;
  const prompt = '아래는 상품 "' + (title || '') + '"의 상세 이미지들이다. ★오직 이 상품 자체의 사실만 한국어로 "빠짐없이 전부" 추출하라. 같은 페이지에 다른 모델·관련상품·세트 카탈로그·타 사양이 섞여 있으면 무시(제목 "' + (title || '') + '"과 맞는 것만). 다음 항목을 이미지에 보이는 대로 전부 뽑아라: 크기·치수, 무게, 용량, 재질·소재, ★성분·영양성분표(비타민·미네랄·아미노산·추출물 등 모든 성분명과 함량 수치를 표/리스트에 적힌 그대로 하나도 빠짐없이), 색상·옵션 전종류, 구성품·세트구성, 핵심기능·작동방식(예 각도조절·풍량단수·온도·모드), 사용법·작동순서, 인증(KC·식약처 등), 원산지, 제조사·수입사, 모델명/품번, 정격(전압·소비전력·배터리·용량), 주의사항, 그 외 모든 수치·스펙. 같은 항목이 여러 번 나와도 가장 구체적인 것으로. ★제외(절대 포함 금지): 판매자·회사 연락처/전화번호, 상담시간, 배송·교환·반품 정책, 휴무, CCTV, 회사소개. ★제조사·브랜드·원산지·인증번호·모델명은 이미지에 적힌 글자 그대로만 추출하고, 안 보이면 절대 지어내지 말 것(환각 금지). 원료 형태(분말/추출물/농축액/환 등)도 표기된 그대로 쓰고 임의로 바꾸지 말 것. 안 보이거나 불확실하면 추론·창작 금지(없는 건 빼라). JSON으로만: {"facts":["사실1"...]}';
  try {
    const _mdl = model || 'gpt-5.5';
    const _payload = {
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...urls.map((u) => ({ type: 'image_url', image_url: { url: u } }))] }],
      model: _mdl,
      max_tokens: 5000,
      response_format: { type: 'json_object' },
    };
    if (/^(gpt-5|o\d)/.test(_mdl)) _payload.reasoning_effort = 'none'; // reasoning_effort는 gpt-5/o 계열만
    const res = await llmChat(_payload, { sensitive: false, label: 'photo-analysis', timeoutMs: 120000 });
    const d = await res.json();
    const txt = d && d.choices && d.choices[0] && d.choices[0].message ? d.choices[0].message.content : '';
    const o = JSON.parse(String(txt).replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim());
    const DROP = /전화|연락처|상담|배송|발송|마감|휴무|cctv|문의|교환|반품|평일|오전|오후|정책|주문\s*변경|\d{2,4}[.\-]\d{3,4}/i;
    const facts = Array.isArray(o.facts) ? o.facts.filter((x) => x && String(x).trim() && !DROP.test(String(x))).slice(0, 30) : [];
    return facts.length ? facts : null;
  } catch (_) { return null; }
}

// 상품명 미입력 시(업로드 모드) 캡처/사진에서 상품명만 비전으로 추출.
async function extractProductTitle(image) {
  if (!image) return '';
  try {
    const res = await llmChat({
      messages: [{ role: 'user', content: [{ type: 'text', text: '이 상품 이미지/캡처에서 정확한 상품명만 한국어 한 줄로 답하라. 브랜드+제품명만(설명·수식어·가격·옵션·배송 제외). 모르면 빈 문자열만.' }, { type: 'image_url', image_url: { url: image } }] }],
      max_tokens: 60,
    }, { sensitive: false, provider: 'gemini', label: 'title-extract', timeoutMs: 30000 });
    const d = await res.json();
    const txt = d && d.choices && d.choices[0] && d.choices[0].message ? d.choices[0].message.content : '';
    return String(txt).trim().replace(/^["'`\s]+|["'`\s]+$/g, '').slice(0, 100);
  } catch (_) { return ''; }
}

// 레퍼런스 상세페이지(캡처 이미지)에서 "디자인 스타일"만 비전 추출(콘텐츠·문구·사진 복제 X = 법적 안전선). 무료 Gemini. 실패 시 null.
// 반환: { palette:[hex...], mood, layout, typography, graphics, stylePrompt(영문, 이미지 생성기 주입용) }.
async function analyzeReferenceStyle(images) {
  const urls = (Array.isArray(images) ? images : [images]).filter(Boolean).slice(0, 3);
  if (!urls.length) return null;
  const prompt = '아래는 사용자가 "이런 디자인 느낌으로 만들어줘"라고 가져온 상세페이지 레퍼런스다. ★디자인 스타일과 레이아웃 구조만 분석하라(실제 문구·상품·사진은 복제 대상 아님 — 오직 비주얼). 추출: 색 팔레트(주요 hex 2~4개), 전체 무드(예 고급/미니멀/키치/내추럴/팝), 레이아웃 방식 한줄 요약(layout), 타이포 느낌(굵기·크기감·세리프 여부), 그래픽 요소(그라디언트·도형·뱃지·라인 등). '
    + '★그리고 페이지를 위→아래로 보며 "섹션 구조"(structure)를 처음부터 끝까지 하나도 빠짐없이 순서대로 배열로 적어라(섹션이 10개·15개면 그 개수만큼 전부 — 절대 요약하거나 합치지 마라). 각 섹션 type은 반드시 다음 중 하나: "hero"(상단 대표 풀폭컷), "full"(풀폭 단일 이미지), "grid2"(좌우 2단 나란히), "grid3"(3단), "text"(텍스트 단락 중심), "spec"(표/스펙 리스트). note는 그 섹션을 설명하는 한국어 한 줄. '
    + '이 스타일을 영어 이미지 생성 프롬프트 한 문장으로 요약(stylePrompt). JSON으로만: {"palette":["#xxxxxx"],"mood":"...","layout":"...","typography":"...","graphics":"...","structure":[{"type":"hero","note":"..."},{"type":"grid2","note":"..."}],"stylePrompt":"english one-line visual style directive"}';
  try {
    const res = await llmChat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...urls.map((u) => ({ type: 'image_url', image_url: { url: u } }))] }],
      max_tokens: 1500,
      response_format: { type: 'json_object' },
    }, { sensitive: false, label: 'reference-style', timeoutMs: 60000 });
    const d = await res.json();
    const txt = d && d.choices && d.choices[0] && d.choices[0].message ? d.choices[0].message.content : '';
    const o = JSON.parse(String(txt).replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim());
    if (!o || (!o.stylePrompt && !o.mood && !(o.palette && o.palette.length))) return null;
    if (o.palette) o.palette = (Array.isArray(o.palette) ? o.palette : []).filter((c) => /^#?[0-9a-f]{3,8}$/i.test(String(c))).map((c) => String(c)[0] === '#' ? String(c) : '#' + c).slice(0, 4);
    // 레이아웃 구조(섹션 순서·타입) — 유효 타입만 남김. refBlockPlan이 이 순서대로 블록을 배치.
    o.structure = Array.isArray(o.structure) ? o.structure.filter((s) => s && /^(hero|full|grid2|grid3|text|spec)$/.test(String(s.type))).slice(0, 20) : null;
    return o;
  } catch (_) { return null; }
}

// 위험 표현 결정적 안전망(프롬프트가 놓친 절대·순위 단정을 부드럽게 치환). copy-compliance 기준.
const SOFTEN = [[/완벽히/g, '세심하게'], [/완벽한/g, '뛰어난'], [/완벽/g, '우수'], [/100\s*%/g, '높은 수준'], [/무조건/g, '언제든'], [/\s?보장(?=[\s.,!]|$)/g, ''], [/평생/g, '오래'], [/최고급/g, '고급'], [/최고의/g, '우수한'], [/최고(?![급])/g, '우수'], [/최저가/g, '합리적인 가격'], [/유일무이한?/g, '특별한'], [/유일한/g, '특별한'], [/국내\s*1위/g, '인기'], [/업계\s*1위/g, '인기'], [/완치|치유/g, '관리'], [/부작용\s*(?:이|은|는)?\s*없[다어요음습는]\S*/g, '순한 사용감'], [/즉각적?\s*효과|즉시\s*효과/g, '꾸준한 도움'], [/(?:질병|질환|병)\s*(?:을|를)?\s*(?:치료|예방)\S*/g, '건강 관리에 도움']];
function softenClaims(copy) {
  const fix = (s) => typeof s === 'string' ? SOFTEN.reduce((a, [re, to]) => a.replace(re, to), s) : s;
  const walk = (v) => Array.isArray(v) ? v.map(walk) : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : fix(v);
  return walk(copy);
}

// 상품(getItemView 결과) + 소싱 힌트 → { copy, html, imageFacts } 또는 { error }.
async function generateDetailPage(product, { diffHook, painPoints, sellingHook, model, skipVision, imageFacts: injectedFacts, userRequest, tone } = {}) {
  const sp = product.spec || {};
  const visionImgs = (product.descImages && product.descImages.length) ? product.descImages : product.images;
  // 확정된 정보(사용자 검수)가 주입되면 재분석하지 않고 그대로 사용 — 2단계(분석→확인→생성) 흐름.
  const imageFacts = injectedFacts !== undefined ? injectedFacts : (skipVision ? null : await analyzeProductImages(visionImgs, product.title));
  const ctx = {
    상품명: product.title,
    카테고리: (product.categoryTree || []).join(' > ') || null,
    키워드: (product.keywords || []).slice(0, 8),
    스펙: { 크기: sp.size || null, 무게: sp.weight || null, 원산지: sp.country || null, 제조사: sp.manufacturer || null, 모델: sp.model || null, 인증: (sp.kc || []) },
    옵션: (product.options || []).slice(0, 10),
    이미지분석: imageFacts,
    소싱데이터: { 차별화: diffHook || null, 불만해소: painPoints || null, 판매전술: sellingHook || null },
    고객요청: userRequest || null,
    톤: tone || null,
  };
  let copy = null, llmErr = null;
  try {
    const res = await llmChat({
      model: model || 'gpt-4o',
      messages: [{ role: 'system', content: SYS }, { role: 'user', content: '상품데이터:\n' + JSON.stringify(ctx, null, 1) + '\n\n위 데이터(상품데이터·이미지분석에 있는 사실만)로 컷 흐름의 고급 상세페이지 카피를 JSON으로 작성. 단, 「고객요청」·「톤」이 있으면 그것을 ★최우선으로 반영(다른 기본 구성·톤보다 우선)하되, 거기 적힌 내용이라도 상품데이터·이미지분석에 없는 사실(효능·성분·수치)은 절대 지어내지 말 것. 「고객요청」이 없으면 상품데이터 기준으로 그냥 진행.' }],
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
async function generateAiPhoto(src, prompt, { quality = 'low', size = '1024x1536', refImage = null, styleRefImage = null } = {}) {
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
    } else {
      buf = Buffer.from(src, 'base64');
      // base64 입력 포맷 자동 감지(jpeg/png/webp) — ct 불일치 시 gpt-image-2가 거부할 수 있어 magic-byte로 판별.
      if (buf[0] === 0xFF && buf[1] === 0xD8) ct = 'image/jpeg';
      else if (buf[0] === 0x89 && buf[1] === 0x50) ct = 'image/png';
      else if (buf.length > 12 && buf.toString('ascii', 8, 12) === 'WEBP') ct = 'image/webp';
    }
  } catch (_) { return null; }
  const ext = (ct.split('/')[1] || 'jpg');
  // gpt-image-2 edits — 일시 실패/rate limit가 있어 최대 3회 시도(컷 누락 방지). 재시도 전 점증 대기.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
    try {
      const form = new FormData();
      form.append('model', 'gpt-image-2');
      let fullPrompt = prompt;
      if (refImage || styleRefImage) fullPrompt += ' ★The FIRST attached image is the REAL product — replicate its exact form, silhouette, all parts (handle, lid, straw, etc.) and color precisely; keep the product identical.';
      if (refImage) fullPrompt += ' The next attached image is a previously generated section of the SAME product — match ONLY its color tone, lighting and visual style for page cohesion; do NOT reinterpret, simplify or alter the product form.';
      if (styleRefImage) fullPrompt += ' ★The LAST attached image is a DESIGN STYLE REFERENCE (a detail-page the user likes) — closely adopt its color palette, overall mood, layout/composition, spacing and graphic treatment so this section FEELS like that reference, but do NOT copy its product, its text, or its photos; apply only its visual design language to THIS product.';
      form.append('prompt', fullPrompt);
      if (refImage || styleRefImage) {
        // 멀티이미지 — 제품(첫째, 형태 기준) + hero 앵커(톤) + 디자인 레퍼런스(스타일). 제품 형태는 첫째에서, 디자인은 레퍼런스에서.
        form.append('image[]', new Blob([buf], { type: ct }), 'src.' + ext);
        if (refImage) { try { const rb = Buffer.from(String(refImage).replace(/^data:image\/[a-z0-9.+-]+;base64,/i, ''), 'base64'); form.append('image[]', new Blob([rb], { type: 'image/jpeg' }), 'anchor.jpg'); } catch (_) {} }
        if (styleRefImage) { try { const sb = Buffer.from(String(styleRefImage).replace(/^data:image\/[a-z0-9.+-]+;base64,/i, ''), 'base64'); form.append('image[]', new Blob([sb], { type: 'image/jpeg' }), 'styleref.jpg'); } catch (_) {} }
      } else {
        form.append('image', new Blob([buf], { type: ct }), 'src.' + ext);
      }
      form.append('size', size);
      form.append('quality', quality);
      const res = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form, signal: AbortSignal.timeout(240000) });
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

// ===== 블록 기반 편집가능 상세페이지 (제디터/캔바식: 이미지 슬롯 + 진짜 편집되는 텍스트 레이어) =====
// 핵심 전환: AI 사진은 "글자 없는 깨끗한 화보"(이미지 슬롯), 텍스트는 전부 HTML 블록 레이어
//   → 퀄리티(화보) + 편집(텍스트) 동시. 글자를 이미지에 굽던 cutPlan/assembleCutPage 방식의 편집불가 문제 해소.
// 블록 = { type, ...fields }. renderBlocks가 HTML 생성, 편집 텍스트에 data-b(블록 인덱스)/data-f(필드)/data-i(배열 항목) 마킹 → 에디터가 역매핑해 저장.

// 글자 없는 연출 화보 프롬프트(컷마다 다른 앵글). cutPlan과 달리 텍스트를 굽지 않는다 — 편집은 HTML 레이어가 담당.
function scenePlan(product, copy, styleHint) {
  const colors = [...new Set((product.options || []).map((o) => String(o).replace(/\(.*?\)/g, '').replace(/[[\]]/g, '').trim()).filter(Boolean))].slice(0, 6);
  // 레퍼런스 스타일이 있으면 화보 무드에 반영(콘텐츠 아닌 비주얼 톤만).
  const styleTag = styleHint && styleHint.stylePrompt ? (' Match this visual mood: ' + String(styleHint.stylePrompt).slice(0, 240) + ' ') : '';
  const BASE = 'Premium Korean e-commerce lifestyle product photo. Keep THIS exact product faithful in shape, color and material. Clean tasteful real-life scene, soft natural light, minimal complementary props matching the product mood. ABSOLUTELY NO text, NO korean letters, NO captions, NO badges, NO logo, NO website UI anywhere in the image. Photorealistic high-end commercial photography, vertical.' + styleTag + ' ';
  const plan = [
    { key: 'hero', prompt: BASE + 'HERO: the product as centerpiece at a dynamic three-quarter tilted angle, styled tabletop, editorial mood.' },
    { key: 'scene', prompt: BASE + 'LIFESTYLE: a person naturally using or holding this exact product, eye-level candid, hand visible, warm authentic mood.' },
    { key: 'detail', prompt: BASE + 'DETAIL: extreme close-up macro of the product key parts, shallow depth of field, premium texture.' },
    { key: 'benefit', prompt: BASE + 'TOP-DOWN flat-lay of the product neatly arranged with a few tasteful props, clean negative space.' },
  ];
  if (colors.length >= 2) plan.push({ key: 'color', prompt: BASE + 'COLOR LINEUP: this exact product shown in several real colors arranged neatly in a row.' });
  return plan;
}

// 스펙 행 데이터만 추출(specRows의 HTML 생성 전 단계). 블록 모델용.
function specRowsData(spec) {
  const rows = [];
  if (spec) {
    if (spec.size && /[x×*]/i.test(String(spec.size))) rows.push(['크기', String(spec.size).replace(/[xX*]/g, ' × ') + ' cm']);
    if (spec.weight && /^[0-9.]+$/.test(String(spec.weight)) && parseFloat(spec.weight) > 0) rows.push(['무게', String(spec.weight) + ' kg']);
    if (spec.model) rows.push(['모델명', spec.model]);
    if (spec.country) rows.push(['원산지', String(spec.country).replace(/_/g, ' ')]);
    if (spec.manufacturer) rows.push(['제조/수입', spec.manufacturer]);
    if (spec.kc && spec.kc.length) rows.push(['인증', spec.kc.join(', ')]);
  }
  return rows;
}

// 카피(copy) + 글자없는 화보(scenes=[{key,img}]) → 편집가능 블록 배열. 컷 흐름 순서대로.
function copyToBlocks(product, copy, scenes) {
  const c = copy || {};
  const byKey = {};
  (scenes || []).forEach((s) => { if (s && s.img) byKey[s.key] = s.img; });
  const sections = Array.isArray(c.sections) ? c.sections : [];
  const blocks = [];
  blocks.push({ type: 'hero', image: byKey.hero || null, eyebrow: '', headline: c.heroHeadline || c.seoTitle || product.title, sub: c.heroSub || '' });
  if (Array.isArray(c.concerns) && c.concerns.length) blocks.push({ type: 'concern', eyebrow: 'Your Concern', headline: '혹시, 이런 고민 있으셨나요?', items: c.concerns });
  if (byKey.scene || (sections[0])) blocks.push({ type: 'scene', image: byKey.scene || null, eyebrow: '', headline: (sections[0] && sections[0].headline) || '일상 속에서', body: (sections[0] && sections[0].body) || '' });
  if (Array.isArray(c.benefits) && c.benefits.length) blocks.push({ type: 'benefit', eyebrow: 'Why It Matters', headline: '이런 점이 다릅니다', items: c.benefits });
  if (byKey.detail) blocks.push({ type: 'image', image: byKey.detail });
  if (c.comparison && Array.isArray(c.comparison.points) && c.comparison.points.length) blocks.push({ type: 'comparison', headline: c.comparison.headline || '왜 이 제품일까요?', points: c.comparison.points });
  if (byKey.color) blocks.push({ type: 'image', image: byKey.color });
  sections.slice(1).forEach((s) => blocks.push({ type: 'scene', image: byKey.benefit || null, eyebrow: '', headline: s.headline || '', body: s.body || '' }));
  const rows = specRowsData(product.spec);
  if (rows.length) blocks.push({ type: 'spec', rows });
  if (Array.isArray(c.faq) && c.faq.length) blocks.push({ type: 'faq', headline: '자주 묻는 질문', items: c.faq });
  if (c.closing) blocks.push({ type: 'cta', headline: c.closing });
  return blocks;
}

// 레퍼런스급 아이콘셋(원형 배지용) — receipt 렌더러 아이콘 이식(HTML/SVG, 장식).
const DICONS = {
  thermo: '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 9v6"/>',
  feather: '<path d="M19 5a6 6 0 0 0-8.5 0L4 11.5V20h8.5L19 13.5A6 6 0 0 0 19 5z"/><path d="M5 19L12 12"/>',
  droplet: '<path d="M12 3s6 6.4 6 10a6 6 0 1 1-12 0c0-3.6 6-10 6-10z"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  leaf: '<path d="M4 20C4 11 11 4 20 4c0 9-7 16-16 16z"/><path d="M5 19c4-6 8-9 13-11"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2.2"/>',
  bolt: '<path d="M13 2L4 14h6l-1 8 9-12h-6z"/>',
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
  sparkle: '<path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z"/>',
};
function pickIcon(text, seq) {
  const s = String(text || '');
  if (/온도|보온|보냉|단열|따뜻|시원|냉방|난방/.test(s)) return 'thermo';
  if (/가벼|무게|그립|휴대|슬림|콤팩트|미니|한\s?손/.test(s)) return 'feather';
  if (/세척|물|방수|위생|청결|관리|먼지/.test(s)) return 'droplet';
  if (/안전|인증|KC|튼튼|내구|견고|안심|보호/.test(s)) return 'shield';
  if (/친환경|자연|식물|원목|소재/.test(s)) return 'leaf';
  if (/시간|오래|지속|충전|배터리|연속/.test(s)) return 'clock';
  if (/전원|풍량|바람|강력|파워|모터|성능|속도|각도|회전/.test(s)) return 'bolt';
  if (/간편|편리|손쉽|호환|사용|조작|버튼/.test(s)) return 'check';
  return ['sparkle', 'shield', 'bolt', 'leaf'][(seq || 0) % 4];
}
function iconSvg(name, color, size) {
  const sz = size || 24;
  return '<svg viewBox="0 0 24 24" width="' + sz + '" height="' + sz + '" fill="none" stroke="' + color + '" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + (DICONS[name] || DICONS.sparkle) + '</svg>';
}

// 단일 블록 → HTML. 편집 텍스트엔 data-b/data-f(/data-i) 마킹. 아이콘 배지·카드·섹션 색교대로 레퍼런스급 디자인.
function renderBlock(b, i, pal) {
  const p = pal || {};
  const ACC = p.accent || A, T = p.ink || INK, SOFT = p.soft || PAPER;
  const E = (f, tag, style, val) => (val != null && val !== '') ? '<' + tag + ' data-b="' + i + '" data-f="' + f + '" style="' + style + '">' + esc(val) + '</' + tag + '>' : '';
  const EI = (f, ii, tag, style, val) => '<' + tag + ' data-b="' + i + '" data-f="' + f + '" data-i="' + ii + '" style="' + style + '">' + esc(val) + '</' + tag + '>';
  const eb = (f, val) => val ? '<p data-b="' + i + '" data-f="' + f + '" style="font-size:12px;font-weight:700;letter-spacing:2.5px;color:' + ACC + ';margin:0 0 16px;text-transform:uppercase;">' + esc(val) + '</p>' : '';
  const img = (src) => src ? '<img src="' + (/^https?:|^data:/.test(src) ? esc(src) : ('data:image/png;base64,' + src)) + '" alt="" style="width:100%;display:block;">' : '';
  switch (b.type) {
    case 'hero':
      return img(b.image)
        + '<div style="padding:60px 32px 54px;text-align:center;background:' + SOFT + ';">'
        + '<div style="width:40px;height:3px;background:' + ACC + ';margin:0 auto 24px;border-radius:2px;"></div>'
        + E('headline', 'h1', 'font-size:clamp(28px,6vw,38px);font-weight:800;letter-spacing:-1.2px;line-height:1.25;margin:0 0 18px;color:' + T + ';', b.headline)
        + E('sub', 'p', 'font-size:17px;color:' + MUT + ';line-height:1.7;margin:0 auto;max-width:440px;', b.sub)
        + '</div>';
    case 'concern':
      return '<div style="padding:60px 34px;text-align:center;">' + eb('eyebrow', b.eyebrow)
        + E('headline', 'h2', 'font-size:clamp(22px,5vw,28px);font-weight:800;letter-spacing:-0.6px;color:' + T + ';margin:0 0 32px;line-height:1.4;', b.headline)
        + '<div style="max-width:460px;margin:0 auto;text-align:left;">'
        + (b.items || []).map((x, ii) => '<div style="display:flex;gap:14px;align-items:flex-start;padding:16px 0;' + (ii ? 'border-top:1px solid ' + LINE + ';' : '') + '">'
          + '<span style="flex:0 0 auto;width:26px;height:26px;border-radius:50%;background:' + SOFT + ';display:inline-flex;align-items:center;justify-content:center;margin-top:1px;">' + iconSvg('check', ACC, 15) + '</span>'
          + EI('items', ii, 'span', 'font-size:16.5px;color:#544c44;line-height:1.6;', x) + '</div>').join('')
        + '</div></div>';
    case 'benefit':
      return '<div style="padding:60px 30px;background:' + SOFT + ';"><div style="text-align:center;margin-bottom:38px;">' + eb('eyebrow', b.eyebrow)
        + E('headline', 'h2', 'font-size:clamp(22px,5vw,28px);font-weight:800;letter-spacing:-0.6px;color:' + T + ';margin:0;', b.headline) + '</div>'
        + '<div style="max-width:500px;margin:0 auto;display:flex;flex-direction:column;gap:14px;">'
        + (b.items || []).map((x, ii) => '<div style="display:flex;gap:18px;align-items:center;background:#fff;border-radius:18px;padding:20px 22px;box-shadow:0 4px 20px rgba(0,0,0,0.05);">'
          + '<span style="flex:0 0 auto;width:52px;height:52px;border-radius:50%;background:' + ACC + ';display:inline-flex;align-items:center;justify-content:center;">' + iconSvg(pickIcon(x, ii), '#fff', 26) + '</span>'
          + EI('items', ii, 'span', 'font-size:16.5px;color:' + T + ';line-height:1.5;font-weight:500;', x) + '</div>').join('')
        + '</div></div>';
    case 'scene':
      return img(b.image)
        + '<div style="padding:54px 34px;">' + eb('eyebrow', b.eyebrow)
        + E('headline', 'h2', 'font-size:clamp(21px,4.6vw,26px);font-weight:800;color:' + T + ';margin:0 0 14px;line-height:1.35;letter-spacing:-0.5px;', b.headline)
        + E('body', 'p', 'font-size:16px;color:#5f574e;line-height:1.9;margin:0;white-space:pre-line;', b.body)
        + '</div>';
    case 'image':
      return img(b.image);
    case 'comparison':
      return '<div style="padding:60px 34px;background:' + T + ';color:#fff;text-align:center;">'
        + '<p style="font-size:12px;font-weight:700;letter-spacing:2.5px;color:' + ACC + ';margin:0 0 16px;text-transform:uppercase;">The Difference</p>'
        + E('headline', 'h2', 'font-size:clamp(22px,5vw,27px);font-weight:800;letter-spacing:-0.6px;margin:0 0 34px;color:#fff;', b.headline)
        + '<div style="max-width:480px;margin:0 auto;display:flex;flex-direction:column;gap:14px;text-align:left;">'
        + (b.points || []).map((x, ii) => '<div style="display:flex;gap:16px;align-items:center;background:rgba(255,255,255,0.07);border-radius:14px;padding:18px 20px;">'
          + '<span style="flex:0 0 auto;width:30px;height:30px;border-radius:50%;background:' + ACC + ';display:inline-flex;align-items:center;justify-content:center;">' + iconSvg('check', '#fff', 18) + '</span>'
          + EI('points', ii, 'span', 'font-size:16px;color:#fff;line-height:1.55;', x) + '</div>').join('')
        + '</div></div>';
    case 'spec':
      return '<div style="padding:54px 34px;">' + eb('eyebrow', 'Product Info')
        + '<h2 style="font-size:22px;font-weight:800;letter-spacing:-0.5px;color:' + T + ';margin:0 0 18px;">제품 정보</h2>'
        + '<div style="border-bottom:1px solid ' + LINE + ';">'
        + (b.rows || []).map((r) => '<div style="display:flex;justify-content:space-between;gap:20px;padding:15px 0;border-top:1px solid ' + LINE + ';">'
          + '<span style="font-size:14px;color:' + MUT + ';">' + esc(r[0]) + '</span>'
          + '<span style="font-size:14px;color:' + T + ';font-weight:500;text-align:right;">' + esc(r[1]) + '</span></div>').join('')
        + '</div></div>';
    case 'faq':
      return '<div style="padding:54px 34px;background:' + SOFT + ';">' + eb('eyebrow', 'FAQ')
        + E('headline', 'h2', 'font-size:22px;font-weight:800;color:' + T + ';margin:0 0 22px;letter-spacing:-0.5px;', b.headline)
        + (b.items || []).map((f, ii) => '<div style="background:#fff;border-radius:14px;padding:20px 22px;margin-bottom:12px;">'
          + '<div style="display:flex;gap:8px;margin:0 0 8px;"><span style="color:' + ACC + ';font-weight:800;font-size:16px;flex:0 0 auto;">Q.</span>'
          + '<p data-b="' + i + '" data-f="faq.q" data-i="' + ii + '" style="font-size:16px;font-weight:700;color:' + T + ';margin:0;">' + esc(f.q) + '</p></div>'
          + '<p data-b="' + i + '" data-f="faq.a" data-i="' + ii + '" style="font-size:14.5px;color:#6b6259;margin:0;line-height:1.75;">' + esc(f.a) + '</p></div>').join('')
        + '</div>';
    case 'cta':
      return '<div style="background:' + ACC + ';color:#fff;padding:64px 34px;text-align:center;">'
        + '<div style="width:40px;height:3px;background:rgba(255,255,255,0.7);margin:0 auto 24px;border-radius:2px;"></div>'
        + E('headline', 'p', 'font-size:clamp(20px,4.5vw,24px);font-weight:800;margin:0;line-height:1.5;letter-spacing:-0.4px;', b.headline) + '</div>';
    default:
      return '';
  }
}

// 블록 배열 → 풀 상세페이지 HTML. 각 블록은 <section data-block> 래퍼(에디터가 블록 단위로 조작).
function renderBlocks(blocks, palette) {
  const inner = (blocks || []).map((b, i) => '<section data-block="' + i + '" data-type="' + esc(b.type) + '">' + renderBlock(b, i, palette) + '</section>').join('');
  return '<div class="lumi-detail" style="max-width:720px;margin:0 auto;font-family:Pretendard,-apple-system,system-ui,sans-serif;background:#fff;color:' + INK + ';line-height:1.6;">' + inner + '</div>';
}

// 레퍼런스 스타일 통이미지 프롬프트 — 제품 변형금지 + 레퍼런스 스타일 + 정보 카피 박기(글자 포함).
function refStylePrompt(product, copy, facts) {
  const c = copy || {};
  // 색상은 옵션(정확)으로 따로 다루므로 facts에서 색상 항목 제외(비전 색상 환각 차단)
  const info = (Array.isArray(facts) ? facts : []).filter((f) => !/색상|컬러|color|옵션|option/i.test(String(f))).slice(0, 8).join(' / ');
  const colors = (product.options || []).map((o) => String((o && (o.name || o.value)) || o).trim()).filter(Boolean).slice(0, 6);
  const head = String(c.heroHeadline || c.seoTitle || product.title || '').slice(0, 28);
  const sub = String(c.heroSub || '').slice(0, 40);
  return 'You are given TWO images. The SECOND image is the ACTUAL product. The FIRST image is ONLY a visual STYLE reference. '
    + '★★ABSOLUTE RULE: NEVER copy, include, draw, or show the reference\'s product, box, package, bottle, label, or any of its letters/text. The first image exists SOLELY so you copy its visual STYLE (color palette, layout structure, mood, icon/graphic treatment). The ONLY product that may appear anywhere in the output is the one in the SECOND image. Drawing anything from the first image besides its style is WRONG. '
    + 'Create ONE premium vertical Korean e-commerce detail-page for the SECOND product, in the reference STYLE. '
    + '★The product must stay 100% IDENTICAL to the SECOND image: exact shape, color, proportions, every detail — do NOT alter, recolor or beautify it. '
    + (colors.length ? '★Color options: show EXACTLY these ' + colors.length + ' color(s) and NO others — ' + colors.join(', ') + '. Do NOT invent extra colors, do NOT add any "random" or "?" swatch. ' : '')
    + 'Bake Korean marketing text into the design: headline "' + head + '"' + (sub ? ', subtitle "' + sub + '"' : '') + (info ? ', feature points: ' + info : '') + '. '
    + 'When the SAME product appears multiple times (wind-speed steps, usage scenes, etc.), use ONE consistent color for it across all those repetitions — NEVER switch its color between steps. Color variety belongs ONLY in the dedicated color-options section. '
    + 'High quality, vertical Korean detail-page format.';
}

// 생성 결과 검증 — 레퍼런스에서 넘어온 엉뚱한 제품(약·박스 등)이 박혔는지 비전으로 검사. 발견 시 재생성용.
async function verifyGenerated(imageB64, title) {
  if (!imageB64) return { ok: true };
  const prompt = '이 상품 상세페이지 이미지를 검사하라. 주 상품은 "' + (title || '') + '"다. '
    + '이 상품과 무관한 "다른 제품"(예: 약·알약·건강기능식품·영양제·음료·화장품·엉뚱한 박스나 패키지)이 이미지 어딘가에 그려져 있는지 확인하라. '
    + '주 상품(' + (title || '') + ') 본체와 그 부속품·구성품은 정상이다. 오직 "전혀 다른 종류의 제품"이 섞였을 때만 true. '
    + 'JSON으로만: {"hasForeignProduct": true/false, "what": "발견한 엉뚱한 제품(없으면 빈 문자열)"}';
  try {
    const res = await llmChat({
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + imageB64 } }] }],
      max_tokens: 150, response_format: { type: 'json_object' },
    }, { sensitive: false, provider: 'gemini', label: 'verify-gen', timeoutMs: 45000 });
    const d = await res.json();
    const txt = d && d.choices && d.choices[0] && d.choices[0].message ? d.choices[0].message.content : '';
    const o = JSON.parse(String(txt).replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim());
    return { ok: !o.hasForeignProduct, foreign: o.what || '' };
  } catch (_) { return { ok: true }; } // 검증 실패 시 통과(생성 막지 않음)
}

// 카테고리별 표준 섹션 템플릿(type 순서) — 레퍼런스 structure가 없을 때 fallback으로 사용.
// 출처: 2026-06-27 리서치(화장품/건기식/가전/패션/식품 베스트프랙티스).
const CATEGORY_TEMPLATES = {
  beauty: ['hero', 'text', 'full', 'grid3', 'full', 'grid2', 'text', 'spec'],
  supplement: ['hero', 'text', 'spec', 'grid3', 'full', 'grid2', 'text', 'spec'],
  appliance: ['hero', 'grid3', 'full', 'spec', 'full', 'grid2', 'spec', 'text'],
  fashion: ['hero', 'full', 'grid2', 'text', 'spec', 'grid3', 'full', 'text'],
  food: ['hero', 'full', 'grid2', 'text', 'spec', 'text', 'grid3', 'spec'],
};
// 상품명·카테고리·키워드에서 5종 카테고리 감지(키워드 매칭). 못 찾으면 null → 공통 기본흐름.
function detectCategory(product) {
  const hay = [(product.categoryTree || []).join(' '), product.title || '', (product.keywords || []).join(' ')].join(' ').toLowerCase();
  const RULES = [
    ['supplement', /영양제|비타민|유산균|건강기능|밀크씨슬|실리마린|오메가|홍삼|루테인|프로바이오|콜라겐|효소|보충제|supplement|probiotic/],
    ['beauty', /토너|세럼|크림|로션|에센스|클렌징|화장품|스킨케어|선크림|마스크팩|앰플|미스트|쿠션|파운데이션|cosmetic|serum|skincare/],
    ['appliance', /에어컨|청소기|냉장고|세탁기|노트북|모니터|선풍기|가전|전자제품|드라이어|믹서|가습기|공기청정|appliance|electronic/],
    ['fashion', /의류|티셔츠|셔츠|원피스|바지|니트|자켓|코트|신발|운동화|가방|모자|패션|주얼리|apparel|fashion|clothing/],
    ['food', /식품|간식|과자|음료|커피|건강식|반찬|소스|분말|식자재|먹거리|디저트|food|snack|beverage/],
  ];
  for (const [cat, re] of RULES) { if (re.test(hay)) return cat; }
  return null;
}

// 레퍼런스 블록 플랜 — 레퍼런스를 "이미지로 입력하지 않고" 스타일 텍스트(styleHint)만 주입(비타민 차단).
// + 블록마다 구도/앵글을 다르게 명시(구도 반복 방지), 정보를 한 블록에서만 다룸(중복 방지), 크기·수치는 스펙 블록 1곳만(환각 방지).
// + 레퍼런스 structure 없으면 detectCategory→CATEGORY_TEMPLATES로 카테고리 표준 구조를 깐다.
function refBlockPlan(product, copy, facts, styleHint, userRequest) {
  const c = copy || {};
  const colors = (product.options || []).map((o) => String((o && (o.name || o.value)) || o).trim()).filter(Boolean).slice(0, 6);
  const allFacts = Array.isArray(facts) ? facts : [];
  // 스펙(크기·무게·정격 등 수치)과 기능을 분리 → 각각 한 블록에서만 표기(중복·환각 차단).
  const SPEC_RE = /(\d+\s*(cm|mm|kg|g|w|wh|mah|v|인치|ml|l)\b)|크기|치수|지름|무게|중량|용량|정격|전압|소비전력|배터리|재질|소재|사이즈/i;
  const specFacts = allFacts.filter((f) => SPEC_RE.test(String(f)));
  const featFacts = allFacts.filter((f) => !SPEC_RE.test(String(f)) && !/색상|컬러|color|옵션|option/i.test(String(f)));
  const sh = styleHint || {};
  const styleLine = (sh.stylePrompt || 'premium clean modern Korean e-commerce detail-page style')
    + (sh.palette && sh.palette.length ? '. Color palette: ' + sh.palette.join(', ') : '')
    + (sh.mood ? '. Mood: ' + sh.mood : '')
    + (sh.layout ? '. Layout treatment: ' + sh.layout : '');
  // 입력 이미지는 "제품 한 장"뿐(레퍼런스 이미지는 넣지 않음).
  // ★전환(2026-06-27): 하이브리드(화보 텍스트0 + SVG) → gpt-image-2가 한글 글씨까지 직접 생성(한글 정확 실측 통과). renderBlockText 미사용.
  const base = 'This input image is the ACTUAL product. Keep the product 100% IDENTICAL — exact shape, color, pattern, proportions, every detail. Do NOT alter, recolor, beautify, or add any other product/box/package. Preserve product geometry and label legibility exactly; no artificial smoothing, keep natural texture/grain, render a photorealistic contact shadow. '
    + '★PRODUCT FORM LOCK (critical): the product SILHOUETTE and every physical part (handle, lid, straw, spout, cap, buttons, body shape, number of parts) must stay EXACTLY as the input image across ALL sections. You may change camera angle, scene and lighting, but NEVER redesign, simplify, remove or add parts — if the input has a handle and a straw lid, every single shot must show that SAME handle and SAME straw lid with the same proportions. Do not turn it into a different product type (e.g. a mug or plain cup). '
    + 'Create a premium vertical Korean e-commerce detail-page SECTION for THIS product. '
    + 'Follow this TEXT-DESCRIBED visual style only (never invent products from it): ' + styleLine + '. '
    + '★CRITICAL TYPOGRAPHY: the Korean strings quoted in COMPOSITION below are THE EXACT TEXT TO RENDER — reproduce them character-for-character, large and crisp, 100% accurate Hangul with correct spelling, NO gibberish, NO random or extra letters/numbers anywhere. Use a clean Korean sans-serif (Pretendard or Noto Sans KR; if unavailable, a clean geometric sans-serif). Do not add any other text. '
    + '★Overall look: high-fidelity, sharp and crisp, no color banding, no AI artifacts. '
    + '★PHOTOREAL (avoid AI tells): keep the scene plausible and purposeful — no decorative AI clutter (no random scattered leaves, floating water droplets/splashes, abstract geometric shapes, lens flare, glowing particles/sparkles, purple/teal gradient backdrops, gratuitous bokeh orbs); empty space stays clean and intentional, not filled with generic stock decoration. '
    + '★Color/tone like a real photograph: natural saturation (not oversaturated or neon), realistic contrast with true blacks and clean highlights, no overdone HDR, no artificial glow/bloom/halo around edges. '
    + '★Material accuracy: render reflections and highlights physically correct for the real surface (glossy/glass/metal/liquid) — soft controlled reflections consistent with the lighting, no warped or impossible mirror images, no duplicated or ghosted product, no distorted label inside a reflection. '
    + '★Scale consistency: keep the product\'s apparent size, camera distance and perspective believable and consistent across sections (natural eye-level or slightly-above commercial angle), no wild scale jumps or wide-angle warping, unless the COMPOSITION explicitly calls for a macro detail crop. '
    + '★If a human hand or person appears: correct anatomy — exactly five fingers per hand with natural joints and nails, a believable grip matching the product\'s real size, and natural skin with visible pores and subtle tonal variation; no waxy or plastic skin, no extra/fused/missing/bent fingers. '
    + '★The product must sit NATURALLY on or against a real surface — on a table/podium/floor, laid flat, worn on a mannequin, or hung on a rack as appropriate for the product type — with a soft realistic shadow. NEVER let it float in mid-air. '
    + '★CONSISTENCY across all sections of this page: soft even lighting, neutral ~5500K white balance, clean seamless background, no chromatic aberration, no plastic sheen — so every block looks like one cohesive set. '
    + '★When the COMPOSITION places the product in a real-life scene or background (lifestyle, held in a hand, on a desk, in a room), SEAMLESSLY INTEGRATE it: keep the product\'s exact shape and color, but RELIGHT it to match the scene\'s light direction, color temperature and ambiance (drop the flat studio light); ground it with a soft realistic contact shadow and add subtle environmental reflection/bounce light, with matching depth-of-field and grain, so it looks genuinely PHOTOGRAPHED in that scene — NEVER a cut-out, pasted-on, sticker, or floating-on-top look, no hard unnatural edges. '
    + (userRequest && String(userRequest).trim() ? '★★HIGHEST PRIORITY — the customer explicitly requested: "' + String(userRequest).slice(0, 200).replace(/["\\]/g, '') + '". Follow this request above all default styling choices (but never invent product facts that are not provided). ' : '');
  // 프롬프트에 넣을 한글 텍스트를 안전하게 따옴표로 감싼다(따옴표/역슬래시 제거).
  const q = (s, n) => '"' + String(s == null ? '' : s).slice(0, n).replace(/["\\]/g, '') + '"';
  const heroHead = String(c.heroHeadline || product.title || '').slice(0, 24);
  const featLabels = (Array.isArray(c.featureLabels) && c.featureLabels.length) ? c.featureLabels.map((x) => String(x).slice(0, 10)).filter(Boolean).slice(0, 4) : featFacts.slice(0, 4);
  const secList = Array.isArray(c.sections) ? c.sections.filter(Boolean) : [];

  // 타입별 블록 빌더(재사용) — 기존 상세의 섹션 순서(structure) 배치와 기본 흐름 양쪽에서 사용.
  const mkHero = () => ({ key: 'hero', quality: 'medium', text: { kicker: String(c.heroKicker || '').slice(0, 26), headline: heroHead, sub: String(c.heroSub || '').slice(0, 32), emphasis: String(c.heroEmphasis || '').slice(0, 12) }, prompt: base + 'COMPOSITION: ONE single large hero shot from a slight FRONT THREE-QUARTER angle (rotated about 30 degrees so the product shows real dimension, not flat head-on), product in the LOWER 60 percent, clean studio background with soft controlled reflections and premium yet realistic lighting, NOT a row of repeated units. In the clean TOP 40 percent render Korean text — a small kicker ' + q(c.heroKicker, 26) + ', then a LARGE two-line headline ' + q(heroHead, 24) + ', then a smaller subline ' + q(c.heroSub, 32) + '.' });
  const mkFeatures = () => featLabels.length ? { key: 'features', quality: 'medium', text: { kicker: 'KEY FEATURES', title: '핵심 기능', items: featLabels }, prompt: base + 'COMPOSITION: at the TOP a Korean section title "핵심 기능". Below it ONE horizontal row of EXACTLY ' + featLabels.length + ' items, each = a simple minimal line icon + an accurate short Korean label. Labels in order: ' + featLabels.map((x) => q(x, 10)).join(', ') + '. Product subtly styled at the bottom.' } : null;
  const mkColors = () => colors.length >= 2 ? { key: 'colors', quality: 'medium', text: { kicker: 'COLOR', title: '색상 옵션', items: colors }, prompt: base + 'COMPOSITION: a side-by-side COLOR line-up showing the product in EXACTLY these ' + colors.length + ' colors and NO others — ' + colors.join(', ') + '. At the top render Korean title "색상 옵션". No invented colors.' } : null;
  const mkSpec = () => specFacts.length ? { key: 'spec', quality: 'medium', text: { kicker: 'SPECIFICATION', title: '제품 상세 스펙', items: specFacts.slice(0, 10) }, prompt: base + 'COMPOSITION: a product SPEC section, close-up/detail in the lower area. At the TOP a Korean title "제품 상세 스펙" and a clean spec table listing EXACTLY these Korean rows: ' + specFacts.slice(0, 10).map((x) => q(x, 30)).join(', ') + '.' } : null;
  // full/text 등 "설명 섹션" — 기존 상세의 해당 섹션 주제(note)를 살려, 다른 앵글 화보 + 한글 캡션으로 재현.
  let sceneN = 0;
  const mkScene = (note) => {
    const sec = secList[sceneN] || {};
    const cap = sec.headline ? String(sec.headline).slice(0, 22) : (featFacts[sceneN] ? String(featFacts[sceneN]).slice(0, 22) : '');
    if (!cap) return null; // ★상품 정보(섹션·기능)가 없으면 장면컷을 억지로 만들지 않음 — 정보 있는 블록만(레퍼런스 블록 수에 끌려가지 않음)
    const vis = (sec.visual && String(sec.visual).trim()) ? String(sec.visual).slice(0, 170).replace(/["\\]/g, '') : '';
    sceneN += 1;
    // ★섹션 의미 기반 시각: visual 지시가 있으면 그 장면을 그린다(보온→얼음 등). 없으면 note, 둘 다 없으면 기본 라이프스타일.
    const scene = vis
      ? ('COMPOSITION: ' + vis + ' — a real, photo-realistic scene that conveys this section (not a plain centered studio shot).')
      : ('COMPOSITION: a real-life LIFESTYLE/usage scene from a DIFFERENT angle (on a desk, held in a hand, or in a room) — NOT a centered studio shot.' + (note ? ' Convey: ' + String(note).slice(0, 60).replace(/["\\]/g, '') + '.' : ''));
    return { key: 'scene' + sceneN, quality: 'medium', text: { headline: cap }, prompt: base + scene + ' In a clean area render one Korean caption line ' + q(cap, 22) + '.' };
  };
  const mkCta = () => ({ key: 'cta', quality: 'medium', text: { headline: String(c.closing || '').slice(0, 20) }, prompt: base + 'COMPOSITION: a closing MOOD shot (product smaller, atmospheric background). In a clean area render one Korean closing line ' + q(c.closing, 20) + '.' });
  // 미사용 핵심 카피(혜택/비교/FAQ)를 블록으로 — 레퍼런스 구조에 안 담겨도 정보 누락 방지(정보 완전성).
  const mkBenefits = () => { const items = (c.benefits || []).map((x) => String(x).slice(0, 40)).filter(Boolean).slice(0, 6); return items.length ? { key: 'benefits', quality: 'medium', text: { kicker: 'BENEFITS', title: '이런 점이 좋아요', items }, prompt: base + 'COMPOSITION: at the TOP a Korean section title "이런 점이 좋아요". Below it a clean vertical list of EXACTLY ' + items.length + ' benefit rows, each a short Korean line with a small check/plus icon: ' + items.map((x) => q(x, 40)).join(', ') + '.' } : null; };
  const mkComparison = () => { const pts = ((c.comparison && c.comparison.points) || []).map((x) => String(x).slice(0, 40)).filter(Boolean).slice(0, 4); return pts.length ? { key: 'compare', quality: 'medium', text: { kicker: 'WHY', title: String((c.comparison && c.comparison.headline) || '왜 이 제품일까요').slice(0, 20), items: pts }, prompt: base + 'COMPOSITION: at the TOP a Korean title ' + q((c.comparison && c.comparison.headline) || '왜 이 제품일까요', 20) + '. Below it ' + pts.length + ' key differentiator points in a clean comparison layout: ' + pts.map((x) => q(x, 40)).join(', ') + '.' } : null; };
  const mkFaq = () => { const fs = (c.faq || []).map((f) => ({ qq: String((f && f.q) || '').slice(0, 30), aa: String((f && f.a) || '').slice(0, 55) })).filter((f) => f.qq).slice(0, 4); return fs.length ? { key: 'faq', quality: 'medium', text: { kicker: 'FAQ', title: '자주 묻는 질문', items: fs.map((f) => f.qq + ' / ' + f.aa) }, prompt: base + 'COMPOSITION: at the TOP a Korean title "자주 묻는 질문". Below it ' + fs.length + ' Q&A pairs, each a bold Korean question then its answer: ' + fs.map((f) => 'Q ' + q(f.qq, 30) + ' A ' + q(f.aa, 55)).join(' / ') + '.' } : null; };
  // 한 블록에 다 못 담는 스펙/기능은 버리지 말고 다음 블록으로 넘긴다(페이지네이션 — 정보 누락 0). 첫 블록은 mkSpec/mkFeatures가 담당.
  const mkSpecOverflow = () => { const out = []; for (let i = 10; i < specFacts.length; i += 10) { const items = specFacts.slice(i, i + 10); out.push({ key: 'spec_' + i, quality: 'medium', text: { kicker: 'SPECIFICATION', title: '제품 상세 스펙', items }, prompt: base + 'COMPOSITION: a continued product SPEC table. At the TOP a Korean title "제품 상세 스펙". A clean spec table listing EXACTLY these Korean rows: ' + items.map((x) => q(x, 30)).join(', ') + '.' }); } return out; };
  // ★도배 방지: featFacts가 많아도 '추가 기능' 블록은 최대 2개까지만(핵심기능 1 + 추가 최대 2). 그 이상은 버린다(반복 도배가 정보누락보다 큰 품질 손해).
  const mkFeatOverflow = () => { const out = []; const start = (Array.isArray(c.featureLabels) && c.featureLabels.length) ? 0 : 4; for (let i = start; i < featFacts.length && out.length < 1; i += 4) { const items = featFacts.slice(i, i + 4).map((x) => String(x).slice(0, 14)); if (!items.length) break; out.push({ key: 'feat_' + i, quality: 'medium', text: { kicker: 'FEATURES', title: '추가 기능', items }, prompt: base + 'COMPOSITION: at the TOP a Korean section title "추가 기능". One horizontal row of EXACTLY ' + items.length + ' items, each a simple minimal line icon + a short Korean label: ' + items.map((x) => q(x, 14)).join(', ') + '.' }); } return out; };
  const mkExtras = () => [
    ...mkSpecOverflow(),
    ...mkFeatOverflow(),
    (Array.isArray(c.benefits) && c.benefits.length) ? mkBenefits() : null,
    (c.comparison && Array.isArray(c.comparison.points) && c.comparison.points.length) ? mkComparison() : null,
    (Array.isArray(c.faq) && c.faq.length) ? mkFaq() : null,
  ].filter(Boolean);

  // ★기존 상세의 섹션 순서(structure)가 있으면 그 순서·구성 그대로 재현(충실도=해자). 없으면 카테고리 표준 템플릿 fallback.
  const cat = detectCategory(product);
  const structure = (Array.isArray(sh.structure) && sh.structure.length >= 3) ? sh.structure
    : (cat && CATEGORY_TEMPLATES[cat] ? CATEGORY_TEMPLATES[cat].map((t) => ({ type: t, note: '' })) : null);
  if (structure) {
    const sblocks = [];
    let featDone = false, colorDone = false, specDone = false;
    structure.forEach((sec) => {
      const note = sec && sec.note;
      let b = null;
      switch (sec && sec.type) {
        case 'hero': if (!sblocks.some((x) => x.key === 'hero')) b = mkHero(); break;
        case 'spec': if (!specDone) { b = mkSpec(); if (b) specDone = true; } break;
        case 'grid2': case 'grid3':
          if (!featDone) { b = mkFeatures(); if (b) featDone = true; }
          else if (!colorDone) { b = mkColors(); if (b) colorDone = true; }
          break;
        default: break; // full / text / 기타 설명 섹션
      }
      // 위에서 블록을 못 만들면(중복·데이터 없음) 장면 컷 시도. 단 상품 정보가 없으면 mkScene이 null → 그 섹션은 건너뜀(빈 블록 억지생성 X).
      if (!b) b = mkScene(note);
      if (b) sblocks.push(b);
    });
    if (!sblocks.some((x) => x.key === 'hero')) sblocks.unshift(mkHero());
    if (sblocks.length >= 2) return [...sblocks, ...mkExtras(), ...(String(c.closing || '').trim() ? [mkCta()] : [])];
  }

  // 기본 흐름(structure 없음): 히어로→기능→장면→색상→스펙→CTA
  const blocks = [];
  blocks.push(mkHero());
  const bf = mkFeatures(); if (bf) blocks.push(bf);
  if (secList[0]) { const sc0 = mkScene(''); if (sc0) blocks.push(sc0); }
  const bc = mkColors(); if (bc) blocks.push(bc);
  const bs = mkSpec(); if (bs) blocks.push(bs);
  mkExtras().forEach((b) => blocks.push(b));
  blocks.push(mkCta());
  return blocks;
}

// 블록 이미지(base64[])를 같은 폭으로 맞춰 세로로 이어붙여 단일 상세페이지 PNG(base64) 반환.
async function stitchBlocks(b64list) {
  const sharp = require('sharp');
  const bufs = (b64list || []).filter(Boolean).map((b) => Buffer.from(b, 'base64'));
  if (!bufs.length) return null;
  let W = 0;
  for (const b of bufs) { const m = await sharp(b).metadata(); if ((m.width || 0) > W) W = m.width; }
  W = W || 1024;
  const resized = [];
  let totalH = 0;
  for (const b of bufs) {
    const r = await sharp(b).resize({ width: W }).png().toBuffer();
    const m = await sharp(r).metadata();
    resized.push({ buf: r, h: m.height || 0 });
    totalH += m.height || 0;
  }
  const composites = [];
  let top = 0;
  for (const r of resized) { composites.push({ input: r.buf, top, left: 0 }); top += r.h; }
  // 퀄리티 유지(육안 무손실) + 용량 대폭 절감: PNG 대신 JPG q95(4:4:4). 해상도는 그대로.
  const out = await sharp({ create: { width: W, height: totalH, channels: 4, background: '#ffffff' } }).composite(composites).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
  return out.toString('base64');
}

// 블록 화보 위에 얹을 한글 텍스트(SVG buffer). 텍스트=코드 → 한글 정확 + 고객 수정 무료(재합성만).
// block.text(헤드라인·라벨·스펙) + 레퍼런스 palette로 톤 결정. 화보엔 텍스트가 없으므로 겹침 없음.
function renderBlockText(block, W, H, sh) {
  const BODY = "'Apple SD Gothic Neo','NanumSquare','NanumGothic','Noto Sans CJK KR',sans-serif";
  // 헤드라인 폰트 = 레퍼런스 무드별 자동 선택(명조/둥근/손글씨/고딕). 두꺼워 겹치는 디스플레이(Do Hyeon)는 제외. DESIGN.md 기준.
  const _ty = String((sh && sh.typography) || '') + ' ' + String((sh && sh.mood) || '') + ' ' + String((sh && sh.layout) || '');
  // 편집 override(고객이 폰트 직접 선택, family명)가 있으면 우선, 없으면 무드 자동.
  const HEAD = (sh && sh.fontOverride) ? ("'Apple SD Gothic Neo','" + String(sh.fontOverride).replace(/['"]/g, '') + "',sans-serif")
    : /serif|명조|세리프|elegant|luxur|classic|우아|고급|editorial|vintage|전통|premium/i.test(_ty) ? "'Apple SD Gothic Neo','Gowun Batang','Song Myung','NanumMyeongjo',serif"
    : /round|cute|friendly|둥근|귀여|키즈|베이비|푸드|kid|baby|food|soft|pastel|playful/i.test(_ty) ? "'Apple SD Gothic Neo','Gowun Dodum','NanumSquareRound',sans-serif"
    : /hand|script|brush|감성|수제|카페|내추럴|handwritten|cafe|natural|organic|warm|cozy/i.test(_ty) ? "'Apple SD Gothic Neo','Nanum Pen','Gamja Flower',cursive"
    : BODY;
  const t = (block && block.text) || {};
  const pal = (sh && Array.isArray(sh.palette)) ? sh.palette : [];
  const lum = (hex) => { const h = String(hex || '').replace('#', ''); if (h.length < 6) return 140; return parseInt(h.slice(0, 2), 16) * 0.299 + parseInt(h.slice(2, 4), 16) * 0.587 + parseInt(h.slice(4, 6), 16) * 0.114; };
  const light = pal.length ? pal.some((c) => lum(c) > 175) : true;
  // 편집 override(고객이 글자색·강조색 직접 지정)가 있으면 우선.
  const main = (sh && sh.inkOverride) || (light ? '#241a14' : '#ffffff');
  const subc = (sh && sh.subOverride) || (light ? '#6b5b4d' : '#e6dbd0');
  const acc = (sh && sh.accentOverride) || pal.find((c) => { const l = lum(c); return l < 150 && l > 35; }) || (light ? '#9a7b5c' : '#e0a8b8');
  const cx = W / 2;
  const fit = (txt, max, ratio) => Math.max(22, Math.min(max, Math.floor(W * (ratio || 0.86) / Math.max(String(txt || '').length, 1))));
  // 긴 헤드라인은 중간 근처 공백 기준으로 2줄 분할(레퍼런스처럼 큰 2줄 헤드라인).
  const twoLines = (txt) => { const ws = String(txt || '').trim().split(/\s+/); if (ws.length < 2 || String(txt || '').length <= 9) return [String(txt || '')]; let bi = 1, bd = 1e9, a = 0; const tot = String(txt).length; for (let i = 1; i < ws.length; i++) { a += ws[i - 1].length + 1; if (Math.abs(a - tot / 2) < bd) { bd = Math.abs(a - tot / 2); bi = i; } } return [ws.slice(0, bi).join(' '), ws.slice(bi).join(' ')]; };
  const TX = (x, y, sz, fill, w, ls, txt, anc, font) => { const sp = ls != null ? ls : Math.round(sz * 0.05 * 10) / 10; return '<text x="' + Math.round(x) + '" y="' + Math.round(y) + '" text-anchor="' + (anc || 'middle') + '" font-family="' + (font || BODY) + '" font-size="' + sz + '"' + (w ? ' font-weight="' + w + '"' : '') + ' letter-spacing="' + sp + '" fill="' + fill + '">' + esc(String(txt == null ? '' : txt)) + '</text>'; };
  // ★위에서부터 y를 누적(각 요소 baseline = y, 다음 요소는 폰트높이+여백만큼 내려감) → 겹침 원천 차단.
  let s = '';
  if (block.key === 'hero') {
    let y = H * 0.12;
    if (t.kicker) { s += TX(cx, y, 24, acc, 700, 7, t.kicker); y += 60; }
    const lines = twoLines(t.headline);
    const hs = Math.min(86, fit(lines.reduce((a, b) => a.length > b.length ? a : b, ''), 86, 0.84));
    const emph = String(t.emphasis || '').trim();
    lines.forEach((ln) => {
      y += hs;
      if (emph && ln.indexOf(emph) >= 0) {
        // 헤드라인 핵심어만 강조색(tspan). 레퍼런스처럼 포인트 컬러.
        const i = ln.indexOf(emph), sp = Math.round(hs * 0.05 * 10) / 10;
        s += '<text x="' + Math.round(cx) + '" y="' + Math.round(y) + '" text-anchor="middle" font-family="' + HEAD + '" font-size="' + hs + '" font-weight="800" letter-spacing="' + sp + '" fill="' + main + '">' + esc(ln.slice(0, i)) + '<tspan fill="' + acc + '">' + esc(emph) + '</tspan>' + esc(ln.slice(i + emph.length)) + '</text>';
      } else { s += TX(cx, y, hs, main, 800, null, ln, null, HEAD); }
      y += Math.round(hs * 0.22);
    });
    if (t.sub) { y += 42; s += TX(cx, y, fit(t.sub, 27, 0.62), subc, 400, null, t.sub); }
  } else if (block.key === 'features' && Array.isArray(t.items) && t.items.length) {
    let y = H * 0.11;
    if (t.kicker) { s += TX(cx, y, 20, acc, 700, 6, t.kicker); y += 46; }
    const ts = fit(t.title || '핵심 기능', 48, 0.5); y += ts; s += TX(cx, y, ts, main, 800, null, t.title || '핵심 기능', null, HEAD);
    const cy = y + 96, n = Math.min(t.items.length, 4), gap = W / (n + 1);
    for (let i = 0; i < n; i++) {
      const x = gap * (i + 1);
      const lbl = String(t.items[i]).slice(0, 10);
      const lsize = Math.max(15, Math.min(22, Math.floor(gap * 0.9 / Math.max(lbl.length, 1))));
      s += '<circle cx="' + Math.round(x) + '" cy="' + Math.round(cy) + '" r="46" fill="' + acc + '" fill-opacity="0.1" stroke="' + acc + '" stroke-width="2.5"/>'
        + TX(x, cy + 11, 30, acc, 800, null, String(i + 1))
        + TX(x, cy + 92, lsize, main, 500, 0.5, lbl);
    }
  } else if (block.key === 'spec' && Array.isArray(t.items) && t.items.length) {
    let y = H * 0.10;
    if (t.kicker) { s += TX(cx, y, 20, acc, 700, 6, t.kicker); y += 46; }
    const ts = fit(t.title || '제품 상세 스펙', 48, 0.5); y += ts; s += TX(cx, y, ts, main, 800, null, t.title || '제품 상세 스펙', null, HEAD);
    y += 54;
    t.items.slice(0, 6).forEach((it, i) => { const ry = y + i * 56; const kv = String(it).split(/[:：]/); const k = (kv[0] || '').trim(), v = kv.slice(1).join(':').trim(); s += TX(W * 0.2, ry, 25, acc, 600, 0.5, k.slice(0, 14), 'start'); if (v) s += TX(W * 0.8, ry, 25, main, 400, 0.5, v.slice(0, 24), 'end'); s += '<line x1="' + Math.round(W * 0.2) + '" y1="' + Math.round(ry + 16) + '" x2="' + Math.round(W * 0.8) + '" y2="' + Math.round(ry + 16) + '" stroke="' + acc + '" stroke-opacity="0.25" stroke-width="1"/>'; });
  } else if (block.key === 'colors') {
    let y = H * 0.11;
    if (t.kicker) { s += TX(cx, y, 20, acc, 700, 6, t.kicker); y += 46; }
    const ts = fit(t.title || '색상 옵션', 46, 0.5); y += ts; s += TX(cx, y, ts, main, 800, null, t.title || '색상 옵션', null, HEAD);
  } else if ((block.key === 'cta' || block.key === 'scene') && t.headline) {
    let y = H * 0.14;
    const lines = twoLines(t.headline);
    const cs = Math.min(54, fit(lines.reduce((a, b) => a.length > b.length ? a : b, ''), 54, 0.84));
    lines.forEach((ln) => { y += cs; s += TX(cx, y, cs, main, 800, null, ln, null, HEAD); y += Math.round(cs * 0.22); });
  }
  return Buffer.from('<svg width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg">' + s + '</svg>');
}

// 화보 캐시(텍스트0) + 새 텍스트/폰트/색(styleOverride)로 재합성 → gpt 재호출 0(크레딧 0). 편집·검증용.
// styleOverride: { fontOverride, inkOverride, accentOverride, subOverride } 또는 textOverride(블록별 문구 교체).
async function recomposeBlocks(cacheDir, styleOverride, textOverride) {
  const fs = require('fs'); const path = require('path'); const sharp = require('sharp');
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(cacheDir, '_meta.json'), 'utf8')); } catch (_) { return null; }
  const sh = Object.assign({}, meta.styleHint || {}, styleOverride || {});
  const blockB64 = [];
  for (const blk of (meta.plan || [])) {
    const pp = path.join(cacheDir, blk.key + '.png');
    if (!fs.existsSync(pp)) continue;
    try {
      // 문구 편집(textOverride[key])이 있으면 저장된 text에 덮어씀.
      const b = (textOverride && textOverride[blk.key]) ? { key: blk.key, text: Object.assign({}, blk.text, textOverride[blk.key]) } : blk;
      const img = sharp(pp); const m = await img.metadata();
      const txt = renderBlockText(b, m.width || 1024, m.height || 1536, sh);
      blockB64.push((await img.composite([{ input: txt, top: 0, left: 0 }]).png().toBuffer()).toString('base64'));
    } catch (_) {}
  }
  if (!blockB64.length) return null;
  return stitchBlocks(blockB64);
}

// 블록 1개만 재합성(캐시 화보 + 새 문구/스타일) → base64. gpt 0원 — 편집기 실시간 갱신·저장용.
// textOverride = 해당 블록 text 객체({headline,sub,items,...}) 또는 null(원본 그대로).
async function recomposeBlock(cacheDir, blockKey, textOverride, styleOverride) {
  const fs = require('fs'); const path = require('path'); const sharp = require('sharp');
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(cacheDir, '_meta.json'), 'utf8')); } catch (_) { return null; }
  const pp = path.join(cacheDir, blockKey + '.png');
  if (!fs.existsSync(pp)) return null;
  const sh = Object.assign({}, meta.styleHint || {}, styleOverride || {});
  const base = (meta.plan || []).find((b) => b.key === blockKey) || { key: blockKey, text: {} };
  const b = textOverride ? { key: blockKey, text: Object.assign({}, base.text, textOverride) } : base;
  try {
    const img = sharp(pp); const m = await img.metadata();
    const txt = renderBlockText(b, m.width || 1024, m.height || 1536, sh);
    return (await img.composite([{ input: txt, top: 0, left: 0 }]).png().toBuffer()).toString('base64');
  } catch (_) { return null; }
}

module.exports = { generateDetailPage, buildHtml, analyzeProductImages, distinctImages, generateAiPhoto, photoPrompt, cutPlan, assembleCutPage, accentPalette, extractProductTitle, SYS, esc, scenePlan, specRowsData, copyToBlocks, renderBlock, renderBlocks, analyzeReferenceStyle, refStylePrompt, verifyGenerated, refBlockPlan, detectCategory, stitchBlocks, renderBlockText, recomposeBlocks, recomposeBlock };
