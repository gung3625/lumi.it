'use strict';
// 상세페이지 생성 (공유 모듈). 도매꾹 상품정보 → 7섹션 카피(LLM) + 쿠팡/스마트스토어용 HTML.
// admin-detail-page.js(단독 엔드포인트)와 admin-source-to-listing.js(오케스트레이션)가 함께 사용.
const { llmChat } = require('./llm-call');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const SYS = [
  '너는 한국 이커머스 최고의 상세페이지 카피라이터다. 도매 상품 정보로 소비자용 모바일 상세페이지 카피를 쓴다.',
  '7섹션 구성: 1)Hero(핵심혜택 후킹+서브) 2)구성물 3)사용맥락(장면 묘사) 4)타깃 5)신뢰·차별화 6)FAQ(소비자 질문 2~3) 7)긴급성.',
  '★중요: 도매 거래조건(최소구매수량/MOQ/수량별 도매단가/사업자조건 등)은 절대 소비자 카피·FAQ에 넣지 마라. 소비자는 1개를 산다. FAQ는 소비자 관점만(배송·사용법·소재·세척·AS·호환성 등).',
  '차별화/불만해소/판매전술 데이터가 주어지면 Hero와 신뢰·차별화 섹션에 구체적으로 녹여라(숫자 포함).',
  '규칙: 한국어, 모바일 가독성(짧은 문장·리듬감), 과장·허위·없는 스펙 금지(주어진 정보 기반만), 고시정보(제조사/원산지/KC) 모르면 "판매자 확인". 이모지 금지.',
  '출력 JSON: {"seoTitle":"검색 잘되는 60자내 제목","sections":[{"name":"Hero|구성물|사용맥락|타깃|신뢰차별화|FAQ|긴급성","headline":"굵은 한줄","body":"본문"}]}',
].join('\n');

// 7섹션 카피 + 도매꾹 실이미지 → 상세설명용 HTML 조립.
function buildHtml(product, copy) {
  const imgs = (product.images && product.images.length) ? product.images : [];
  const withImg = ['Hero', '사용', '신뢰', '구성']; // 이미지 붙일 섹션 키워드
  const secs = (copy.sections || []).map((s, i) => {
    const nm = String(s.name || '');
    const showImg = imgs.length && withImg.some((k) => nm.indexOf(k) >= 0);
    const img = showImg ? ('<img src="' + esc(imgs[i % imgs.length]) + '" alt="" style="width:100%;display:block;border-radius:10px;margin:0 0 18px;">') : '';
    return '<section style="padding:28px 22px;border-bottom:1px solid #f1f1f1;">'
      + img
      + (s.headline ? '<h3 style="font-size:21px;font-weight:700;color:#1a1a1a;margin:0 0 11px;line-height:1.4;">' + esc(s.headline) + '</h3>' : '')
      + '<p style="font-size:15px;color:#555;line-height:1.8;margin:0;white-space:pre-line;">' + esc(s.body) + '</p>'
      + '</section>';
  }).join('');
  return '<div style="max-width:780px;margin:0 auto;font-family:Pretendard,-apple-system,system-ui,sans-serif;background:#fff;color:#1a1a1a;">'
    + (imgs[0] ? '<img src="' + esc(imgs[0]) + '" alt="' + esc(copy.seoTitle || product.title) + '" style="width:100%;display:block;">' : '')
    + secs
    + '</div>';
}

// 상품(getItemView 결과) + 소싱 힌트 → { copy, html } 또는 { error }.
async function generateDetailPage(product, { diffHook, painPoints, sellingHook, model } = {}) {
  const ctx = {
    상품명: product.title,
    키워드: (product.keywords || []).slice(0, 8),
    차별화: diffHook || null,
    불만해소: painPoints || null,
    판매전술: sellingHook || null,
  };
  let copy = null, llmErr = null;
  try {
    const res = await llmChat({
      model: model || 'gpt-4o',
      messages: [{ role: 'system', content: SYS }, { role: 'user', content: '도매 상품 정보:\n' + JSON.stringify(ctx) + '\n위 상품의 소비자용 상세페이지 카피를 JSON으로 작성.' }],
      max_tokens: 2800,
      response_format: { type: 'json_object' },
    }, { sensitive: false, label: 'detail-page', timeoutMs: 90000 });
    const d = await res.json();
    const txt = d && d.choices && d.choices[0] && d.choices[0].message ? d.choices[0].message.content : '';
    copy = JSON.parse(String(txt).replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim());
  } catch (e) { llmErr = e && e.message ? e.message : 'LLM 생성 실패'; }
  if (!copy || !Array.isArray(copy.sections)) return { error: llmErr || '빈 응답' };
  return { copy, html: buildHtml(product, copy) };
}

module.exports = { generateDetailPage, buildHtml, SYS, esc };
