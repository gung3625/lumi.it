// admin-sourcing-report.js — 소싱 2차 분석 두뇌.
// 로컬 스캐너(coupang-scan.js)가 모은 1차 후보(쿠팡 인기+도매가)를 POST 하면:
//   1) 키워드별 네이버 검색량 보강 (구매의도 보조 — 단 '검색만 많은' 정보성은 Gemini가 거름)
//   2) Gemini 가 진짜 마진 검증(같은 상품/스펙끼리) + 경쟁력 랭킹 + "왜 추천" 이유 생성
//   3) 구조화 리포트 반환 (이메일 발송은 다음 단계)
//
// 인증: Bearer LUMI_SECRET (cron/로컬 스캐너 머신 호출). 값 비교만, 노출 금지.
// 보안: 공개 상품데이터만 다루므로 llmChat sensitive:false (무료 Gemini 허용).

'use strict';

const { fetchRelatedKeywords } = require('./_shared/naver-ad-keyword-tool');
const { llmChat } = require('./_shared/llm-call');
const { Resend } = require('resend');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function ok(body) { return { statusCode: 200, headers: CORS, body: JSON.stringify(body) }; }
function err(code, msg) { return { statusCode: code, headers: CORS, body: JSON.stringify({ error: msg }) }; }

// 매입 마진 계산 — docs/sourcing-playbook.md 기준 (쿠팡 실효비용).
// feeRate(수수료+결제+VAT 효과) 15% + 광고 5% + 반품 3% = 판매가 비례 23%, 택배 3000 + 포장 500 = 건당 고정.
const PRICING = { feeRate: 0.15, adRate: 0.05, returnRate: 0.03, ship: 3000, pack: 500, targetMargin: 0.25 };
function won(n) { return Math.round(n / 10) * 10; }
// 매입가(도매)·시장가(쿠팡 현재가) → 권장판매가/예상순마진. 시장가에 팔 때 실제 남는 돈을 본다.
function computePricing(wholesale, market) {
  if (!wholesale || !market || wholesale <= 0 || market <= 0) return null;
  const p = PRICING;
  const varRate = p.feeRate + p.adRate + p.returnRate; // 판매가 비례 비용
  const netAtMarket = market - wholesale - market * varRate - p.ship - p.pack; // 시장가에 팔 때 건당 순이익
  const marginAtMarket = market > 0 ? netAtMarket / market : 0;
  const floor = (wholesale + p.ship + p.pack) / (1 - varRate - p.targetMargin); // 25% 마진 달성 최소판매가
  return {
    매입가: Math.round(wholesale),
    시장가: Math.round(market),
    권장판매가: won(market), // 시장 경쟁가에 맞춤
    예상순마진율: Math.round(marginAtMarket * 100),
    예상순이익: won(netAtMarket),
    마진25_최소판매가: won(floor),
    번들필요: marginAtMarket < p.targetMargin, // 단품으론 25% 미달 → 묶음/유료배송 권장
  };
}

const SYSTEM = [
  '너는 한국 온라인셀러의 소싱(매입) 바이어다. 도매로 떼서 쿠팡/스마트스토어에 되팔 때',
  '"무엇을 매입하면 경쟁력 있고, 도매가 대비 얼마에 올려 팔면 되는지"를 판단한다.',
  '입력 후보마다: 쿠팡 인기상품(판매가·리뷰수), 도매토피아 샘플(상품명·도매가), 네이버 월검색량,',
  '그리고 이미 계산된 가격분석(매입가/시장가/권장판매가/예상순마진율/예상순이익/마진25_최소판매가/번들필요)이 들어온다.',
  '',
  '== 마진은 계산이 끝나 들어온다. 너는 그 숫자를 해석·판단만 한다(다시 곱하기 금지). ==',
  '예상순마진율 = 도매가로 떼서 시장가에 팔 때 모든 비용(수수료+결제+VAT+택배+포장+광고+반품) 빼고 남는 진짜 마진율이다.',
  '',
  '== 게이트(하나라도 실패하면 grade="보류" + skipped 사유) ==',
  'G1 마진: 예상순마진율 < 25% AND 예상순이익 < 3000원 이면 단품 매입가치 낮음. 번들필요=true면 "묶음/유료배송 시 가능"으로 살리되 grade는 최대 "고난도".',
  'G2 규제: 화장품·식품·전기전자·유아아동·의료기기 등 인증(KC/제조판매업/영업신고)이 필요한 품목이면 caution에 "인증 필요" 명시(미보유 시 판매불가).',
  'G3 정품: 브랜드 짝퉁/무단 병행수입 위험이 보이면 보류.',
  '',
  '== 판단 원칙 ==',
  '1) 진짜 마진은 "같은 종류·스펙끼리" 비교다. 도매 샘플이 쿠팡 상품과 다른 품목(예: 강아지 검색인데 고양이 장난감)이면 들어온 마진은 과장이니 caution에 "스펙 재확인" 경고.',
  '2) 검색량 높아도 "구매의도"가 아닌 "정보성 도구" 검색(예: 계산기=대출/연봉계산기)이면 skipped.',
  '3) 경쟁력 = 수요(쿠팡 판매+실구매 검색) × 순마진 × 리뷰벽(상위 리뷰 적을수록 신규 진입 쉬움). 브랜드 강세(리뷰벽 높음)라도 품질/가격 우위 가능하면 grade="고난도"로 살림.',
  '4) 작고 가벼운(배송비 유리) 상품 가산점. 부피 큰 저가품은 감점(택배가 마진 잠식).',
  '5) 계절상품=true는 지금이 제철이라 수요가 급증하는 시기다. 마진·경쟁이 비슷하면 계절상품을 우선 추천하고 grade를 한 단계 가산. why에 "제철 수요" 근거를 넣어라.',
  '',
  '== 출력(JSON만) ==',
  '{"picks":[{"keyword","grade":"강력추천|추천|고난도|보류","priceLine":"도매 N원 → 권장 M원에 판매 (순마진 X%, 건당 ₩Y)","why":"왜 추천:수요근거+마진+경쟁상황 1~2문장","caution":"주의/차별화/번들·인증 포인트"}],"skipped":[{"keyword","reason"}]}',
  'priceLine은 들어온 매입가/권장판매가/예상순마진율/예상순이익을 그대로 써라(반올림 OK). 번들필요=true면 caution에 "묶음 판매로 객단가↑" 명시. picks는 순마진·수요 종합 경쟁력 순.',
].join('\n');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return err(405, 'POST만 허용됩니다.');

  const auth = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!process.env.LUMI_SECRET || auth !== process.env.LUMI_SECRET) {
    return err(401, '인증 실패');
  }

  let candidates, wantEmail = false, season = '';
  try {
    const parsed = JSON.parse(event.body || '{}');
    candidates = Array.isArray(parsed.candidates) ? parsed.candidates.slice(0, 20) : null;
    wantEmail = parsed.email === true;
    season = typeof parsed.season === 'string' ? parsed.season : '';
  } catch (_) { return err(400, '잘못된 요청 형식'); }
  if (!candidates || !candidates.length) return err(400, 'candidates 배열이 필요합니다.');

  // 1) 네이버 검색량 보강 (실패해도 진행)
  for (const c of candidates) {
    try {
      const rel = await fetchRelatedKeywords(c.kw).catch(() => []);
      const exact = rel.find((r) => r.keyword && r.keyword.replace(/\s/g, '') === String(c.kw).replace(/\s/g, ''));
      c.naverVolume = exact ? exact.monthlyTotal : (rel[0] ? rel[0].monthlyTotal : null);
    } catch (_) { c.naverVolume = null; }
  }

  // 2) 가격분석 계산 (룰북 공식 — 결정적). 키워드별로 매핑해 뒤에서 Gemini 결과에 병합.
  const pricingByKw = {}, seasonalByKw = {};
  for (const c of candidates) {
    pricingByKw[c.kw] = computePricing(c.domeLow, c.medPrice);
    seasonalByKw[c.kw] = !!c.seasonal;
  }

  // 3) Gemini 분석 (마진 숫자는 위 계산값을 그대로 전달 — 재계산 X)
  const userPayload = candidates.map((c) => ({
    키워드: c.kw,
    쿠팡_상위: (c.top || []).slice(0, 4).map((p) => ({ 이름: p.n, 판매가: p.p, 리뷰: p.r })),
    쿠팡_중앙가: c.medPrice, 쿠팡_1위리뷰: c.topReviews,
    도매_샘플: (c.domeSample || []).map((d) => ({ 이름: d.name, 도매가: d.w })),
    네이버_월검색: c.naverVolume,
    가격분석: pricingByKw[c.kw],
    계절상품: !!c.seasonal,
  }));

  let report = null, llmErr = null;
  try {
    const res = await llmChat({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: '아래 후보들을 분석해 경쟁력 순으로 추천해줘. JSON만 출력.\n\n' + JSON.stringify(userPayload, null, 1) },
      ],
      max_tokens: 1800,
      response_format: { type: 'json_object' },
    }, { timeoutMs: 60000, label: 'sourcing-report', sensitive: false });
    const data = await res.json();
    const txt = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    const clean = String(txt).replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    report = JSON.parse(clean);
    // 코드 계산값을 picks에 병합 (Gemini 숫자 드리프트 방지 — 가격/마진은 코드가 정본)
    if (report && Array.isArray(report.picks)) {
      for (const pk of report.picks) {
        const pr = pricingByKw[pk.keyword];
        if (pr) { pk.pricing = pr; }
        pk.seasonal = !!seasonalByKw[pk.keyword];
      }
    }
  } catch (e) {
    llmErr = e && e.message ? e.message : 'LLM 분석 실패';
  }

  // 이메일 발송 (cron/전체 실행 시 email:true)
  let emailed = false;
  if (wantEmail && report && Array.isArray(report.picks) && report.picks.length && process.env.RESEND_API_KEY) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const gradeColor = (g) => (g && g.indexOf('강력') >= 0) ? '#C8507A' : (g && g.indexOf('추천') >= 0) ? '#D87595' : '#8a8a8a';
      const num = (n) => Number(n).toLocaleString('ko-KR');
      const priceBox = (pr) => {
        if (!pr) return '';
        const mColor = pr.예상순마진율 >= 30 ? '#1f9d57' : pr.예상순마진율 >= 20 ? '#C8507A' : '#c0392b';
        return '<div style="font-size:13px;color:#333;background:#faf3f6;border-radius:8px;padding:8px 12px;margin-top:8px">' +
          '도매 <b>' + num(pr.매입가) + '원</b> → 권장판매 <b>' + num(pr.권장판매가) + '원</b>' +
          ' <span style="color:' + mColor + ';font-weight:800">순마진 ' + pr.예상순마진율 + '% (건당 ' + num(pr.예상순이익) + '원)</span>' +
          (pr.번들필요 ? '<div style="font-size:12px;color:#a1455f;margin-top:3px">※ 단품 마진 약함 — 25% 내려면 ' + num(pr.마진25_최소판매가) + '원, 묶음/유료배송 권장</div>' : '') +
          '</div>';
      };
      const items = report.picks.map((p, i) => (
        '<div style="margin:0 0 14px;padding:14px 16px;border:1px solid #eee;border-radius:12px">' +
        '<div style="font-size:15px;font-weight:800;color:#222">' + (i + 1) + '. ' + esc(p.keyword) +
        ' <span style="font-size:12px;font-weight:700;color:#fff;background:' + gradeColor(p.grade) + ';border-radius:980px;padding:2px 10px;margin-left:6px">' + esc(p.grade || '') + '</span>' +
        (p.seasonal ? ' <span style="font-size:12px;font-weight:700;color:#fff;background:#e8820c;border-radius:980px;padding:2px 10px;margin-left:4px">🌞 제철</span>' : '') + '</div>' +
        priceBox(p.pricing) +
        (p.why ? '<div style="font-size:13px;color:#444;line-height:1.6;margin-top:6px">→ ' + esc(p.why) + '</div>' : '') +
        (p.caution ? '<div style="font-size:12px;color:#a1455f;line-height:1.6;margin-top:4px">⚠ ' + esc(p.caution) + '</div>' : '') +
        '</div>'
      )).join('');
      const html = '<div style="max-width:600px;margin:0 auto;font-family:system-ui,-apple-system,sans-serif">' +
        '<h2 style="color:#C8507A;font-size:18px;margin-bottom:4px">🛒 오늘의 매입 분석 — ' + today + '</h2>' +
        '<p style="font-size:13px;color:#666;margin-top:0">네이버 검색량 + 쿠팡 경쟁 + 도매토피아 매입가 종합. 경쟁력 순.</p>' +
        (season ? '<p style="font-size:13px;color:#e8820c;font-weight:700;margin:0 0 10px">🌞 이번 계절: ' + esc(season) + ' — 제철 상품 포함</p>' : '') +
        items +
        '<p style="font-size:11px;color:#999;margin-top:16px">※ "검증 필요" 마진은 같은 스펙 제품 도매가 재확인 권장. 루미 소싱봇 자동 생성.</p></div>';
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: 'lumi <noreply@lumi.it.kr>',
        to: process.env.ADMIN_EMAIL || 'gung3625@gmail.com',
        subject: '🛒 오늘의 쿠팡 매입 분석 — ' + report.picks.length + '개 추천 (' + today + ')',
        html,
      });
      emailed = true;
    } catch (e) { console.error('[sourcing-report] 이메일 발송 실패:', e && e.message); }
  }

  return ok({
    generatedAt: new Date().toISOString(),
    candidateCount: candidates.length,
    report,
    emailed,
    llmError: llmErr,
  });
};
