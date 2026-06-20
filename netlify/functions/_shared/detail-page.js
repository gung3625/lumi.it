'use strict';
// 상세페이지 생성 (공유 모듈). 도매꾹 실제 스펙 + 소싱 데이터 → 고급 소비자 상세페이지(카피+HTML).
// 구조: webseller식 구매심리 순서(고객고민→혜택→소개→경쟁비교→신뢰→FAQ→배송환불→CTA).
// 핵심: GPT는 주어진 실제 스펙(크기·무게·원산지·제조사·모델·KC·옵션)만 쓴다(창작 금지).
const { llmChat } = require('./llm-call');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const SYS = [
  '너는 한국 이커머스 1위 상세페이지 카피라이터 겸 머천다이저다. 주어진 실제 상품 데이터로 "스크롤하며 사고 싶어지는" 소비자용 모바일 상세페이지 카피를 쓴다.',
  '',
  '== 구매 심리 흐름(이 순서로 설계) ==',
  '관심(Hero) → 공감(고객 고민) → 해결(혜택) → 이해(상품 소개) → 확신(경쟁 비교·신뢰) → 안심(FAQ·배송) → 행동(CTA).',
  '',
  '== 절대 규칙 ==',
  '1) 창작 금지: 크기·무게·원산지·제조사·모델·인증·구성품·기능·용량은 [스펙]/[상품명]에 주어진 것만 쓴다. 주어지지 않은 수치·구성품·기능을 지어내지 마라(예: "USB케이블 포함", "밝기조절 가능", "최대 50000mAh" 금지). 용량·수치(mAh·W·L·ml·시간)는 상품명에 그 숫자가 있을 때만 인용. 스펙 비면 수치 없이 혜택만. 모르면 "옵션/상세 참조".',
  '2) 슬롭 금지: "안정성과 편리함을 동시에", "다양한 기능", "원하는 대로" 같은 공허한 표현 금지. 구체적 장면·대비로 써라.',
  '3) 혜택 중심: 기능 나열이 아니라 "그래서 사용자에게 뭐가 좋아지는가"로 번역.',
  '4) 도매 거래조건(MOQ·도매단가·사업자·재판매조건)은 소비자 카피에 절대 넣지 마라. 소비자는 1개를 산다.',
  '5) 한국어, 모바일 가독성(짧고 리듬감), 과장·허위 금지, 이모지 금지.',
  '6) [소싱데이터]가 주어지면 적극 활용: 불만해소(경쟁상품 리뷰 불만)→concerns와 comparison, 차별화→comparison, 판매전술→benefits. 안 주어지면 상품 성격에서 합리적으로 도출(억지·창작 X).',
  '',
  '== 출력 JSON 키 ==',
  'seoTitle: 검색 잘되는 60자내 제목(핵심키워드+용도).',
  'heroHeadline: 첫 화면 큰 후킹(혜택·결과 중심, 12~22자).',
  'heroSub: 보조 한 줄(누구의 어떤 문제 해결).',
  'concerns: 고객이 공감할 불편/고민 2~3개. 각 1줄("이런 적 없으세요?" 톤). 불만해소 데이터 있으면 소비자 언어로 반영.',
  'benefits: 핵심 혜택 3~4개. 각 1줄, "혜택 + 근거".',
  'sections: 상품 소개/사용장면 1~2개 [{name:"사용장면|이런분께", headline, body(2~3문장)}].',
  'comparison: {headline:"왜 이 제품인가", points:[차별점 2~3개]}. 차별화/불만해소 데이터 반영, 없으면 스펙 기반 실질 장점.',
  'faq: 소비자 질문 2~3개 [{q,a}] — 배송/사용/호환/세척/AS/크기 등 소비자 관점만.',
  'closing: 구매를 미루지 않게 하는 마무리 한 줄(과장 긴급성 금지, 가치 재확인).',
  '',
  '출력은 위 키를 가진 JSON 하나만.',
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

// 배송/교환/환불 — 고정(쿠팡 정책 따름, 과장 없이).
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

// 카피 + 도매꾹 실이미지 + 실제 스펙 → 고급 상세설명 HTML(구매심리 순서).
function buildHtml(product, copy) {
  const imgs = (product.images && product.images.length) ? product.images : [];
  const c = copy || {};
  const W = (s) => '<div style="max-width:780px;margin:0 auto;font-family:Pretendard,-apple-system,system-ui,sans-serif;background:#fff;color:#1a1a1a;line-height:1.6;">' + s + '</div>';
  let h = '';

  // 1) HERO
  if (imgs[0]) h += '<img src="' + esc(imgs[0]) + '" alt="' + esc(c.seoTitle || product.title) + '" style="width:100%;display:block;">';
  h += '<div style="padding:38px 24px 24px;text-align:center;">'
    + '<h1 style="font-size:26px;font-weight:800;color:#161616;margin:0 0 12px;line-height:1.35;letter-spacing:-0.3px;">' + esc(c.heroHeadline || c.seoTitle || product.title) + '</h1>'
    + (c.heroSub ? '<p style="font-size:15px;color:#777;margin:0;line-height:1.6;">' + esc(c.heroSub) + '</p>' : '')
    + '</div>';

  // 2) 고객 고민(공감)
  if (Array.isArray(c.concerns) && c.concerns.length) {
    h += DIV + '<div style="padding:32px 24px;background:#f8f6f3;">'
      + '<p style="font-size:13px;color:#b08968;font-weight:700;letter-spacing:0.5px;margin:0 0 14px;text-align:center;">혹시, 이런 적 없으세요?</p>'
      + c.concerns.map((x) => '<div style="background:#fff;border:1px solid #efe9e2;border-radius:10px;padding:14px 16px;margin:0 0 10px;font-size:15px;color:#5b5249;line-height:1.55;">' + esc(x) + '</div>').join('')
      + '</div>';
  }

  // 3) 핵심 혜택(해결)
  if (Array.isArray(c.benefits) && c.benefits.length) {
    h += DIV + '<div style="padding:34px 24px 30px;max-width:520px;margin:0 auto;">'
      + '<h3 style="font-size:20px;font-weight:700;color:#1a1a1a;margin:0 0 18px;text-align:center;">이 제품이 해결합니다</h3>'
      + c.benefits.map((b) => '<div style="display:flex;gap:11px;align-items:flex-start;padding:9px 0;">' + CHECK
        + '<span style="font-size:15.5px;color:#2b2b2b;line-height:1.55;">' + esc(b) + '</span></div>').join('')
      + '</div>';
  }

  // 4) 상품 소개/사용장면
  (Array.isArray(c.sections) ? c.sections : []).forEach((s, i) => {
    const img = imgs.length ? imgs[(i + 1) % imgs.length] : null;
    h += DIV + '<section style="padding:34px 24px;">'
      + (img ? '<img src="' + esc(img) + '" alt="" style="width:100%;display:block;border-radius:12px;margin:0 0 20px;">' : '')
      + (s.headline ? '<h3 style="font-size:21px;font-weight:700;color:#1a1a1a;margin:0 0 12px;line-height:1.4;letter-spacing:-0.2px;">' + esc(s.headline) + '</h3>' : '')
      + '<p style="font-size:15.5px;color:#555;line-height:1.85;margin:0;white-space:pre-line;">' + esc(s.body || '') + '</p>'
      + '</section>';
  });

  // 5) 경쟁 비교/차별점(확신)
  if (c.comparison && Array.isArray(c.comparison.points) && c.comparison.points.length) {
    h += DIV + '<div style="padding:34px 24px;background:#f4f6f5;">'
      + '<h3 style="font-size:20px;font-weight:700;color:#1a1a1a;margin:0 0 18px;text-align:center;">' + esc(c.comparison.headline || '왜 이 제품일까요?') + '</h3>'
      + '<div style="max-width:520px;margin:0 auto;">'
      + c.comparison.points.map((p) => '<div style="display:flex;gap:11px;align-items:flex-start;background:#fff;border:1px solid #e6ece9;border-radius:10px;padding:14px 16px;margin:0 0 10px;">' + CHECK
        + '<span style="font-size:15px;color:#2b2b2b;line-height:1.55;">' + esc(p) + '</span></div>').join('')
      + '</div></div>';
  }

  // 6) 제품 정보(스펙)
  h += DIV + specRows(product.spec);

  // 7) 신뢰 배지
  h += badges(product.spec);

  // 8) FAQ
  if (Array.isArray(c.faq) && c.faq.length) {
    h += DIV + '<div style="padding:30px 22px;">'
      + '<h3 style="font-size:18px;font-weight:700;color:#1a1a1a;margin:0 0 16px;">자주 묻는 질문</h3>'
      + c.faq.map((f) => '<div style="border-bottom:1px solid #f0efec;padding:14px 0;">'
        + '<p style="font-size:15px;font-weight:600;color:#1a1a1a;margin:0 0 6px;">Q. ' + esc(f.q) + '</p>'
        + '<p style="font-size:14.5px;color:#666;margin:0;line-height:1.7;">' + esc(f.a) + '</p></div>').join('')
      + '</div>';
  }

  // 9) 배송/교환/환불
  h += DIV + shippingBlock();

  // 10) CTA
  if (c.closing) h += '<div style="background:#161616;color:#fff;padding:36px 24px;text-align:center;">'
    + '<p style="font-size:18px;font-weight:700;margin:0;line-height:1.5;">' + esc(c.closing) + '</p></div>';

  return W(h);
}

// 상품(getItemView 결과) + 소싱 힌트 → { copy, html } 또는 { error }.
async function generateDetailPage(product, { diffHook, painPoints, sellingHook, model } = {}) {
  const sp = product.spec || {};
  const ctx = {
    상품명: product.title,
    카테고리: (product.categoryTree || []).join(' > ') || null,
    키워드: (product.keywords || []).slice(0, 8),
    스펙: { 크기: sp.size || null, 무게: sp.weight || null, 원산지: sp.country || null, 제조사: sp.manufacturer || null, 모델: sp.model || null, 인증: (sp.kc || []) },
    옵션: (product.options || []).slice(0, 10),
    소싱데이터: { 차별화: diffHook || null, 불만해소: painPoints || null, 판매전술: sellingHook || null },
  };
  let copy = null, llmErr = null;
  try {
    const res = await llmChat({
      model: model || 'gpt-4o',
      messages: [{ role: 'system', content: SYS }, { role: 'user', content: '실제 상품 데이터:\n' + JSON.stringify(ctx, null, 1) + '\n\n위 데이터(주어진 스펙만)로 구매심리 흐름의 고급 상세페이지 카피를 JSON으로 작성.' }],
      max_tokens: 3800,
      response_format: { type: 'json_object' },
    }, { sensitive: false, label: 'detail-page', timeoutMs: 90000 });
    const d = await res.json();
    const txt = d && d.choices && d.choices[0] && d.choices[0].message ? d.choices[0].message.content : '';
    copy = JSON.parse(String(txt).replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim());
  } catch (e) { llmErr = e && e.message ? e.message : 'LLM 생성 실패'; }
  if (!copy || (!copy.heroHeadline && !Array.isArray(copy.sections) && !Array.isArray(copy.benefits))) return { error: llmErr || '빈 응답' };
  if (!Array.isArray(copy.sections)) copy.sections = [];
  return { copy, html: buildHtml(product, copy) };
}

module.exports = { generateDetailPage, buildHtml, SYS, esc };
