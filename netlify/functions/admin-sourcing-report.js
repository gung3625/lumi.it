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

const SYSTEM = [
  '너는 한국 온라인셀러의 소싱(매입) 분석가다. 도매로 떼서 쿠팡/스마트스토어에 되팔 때',
  '"무엇을 매입하면 경쟁력 있는지"를 판단한다. 입력은 키워드별 쿠팡 인기상품(판매가·리뷰수),',
  '도매토피아 샘플(상품명·도매가), 거친 마진, 네이버 월검색량이다.',
  '',
  '판단 원칙:',
  '1) 진짜 마진은 "같은 종류·스펙끼리" 비교해야 한다. 도매 샘플 중 쿠팡 상품과 다른 품목(예: 강아지 검색인데 고양이 장난감)이 최저가면 그 마진은 과장이니 신뢰하지 말고 marginNote에 경고.',
  '2) 검색량이 높아도 "구매의도"가 아니라 "정보성 도구" 검색(예: 계산기=대출/연봉계산기 도구)이면 제외하거나 강한 감점.',
  '3) 경쟁력 = 수요(쿠팡 판매+실구매 검색) × 마진 × 리뷰벽(상위판매자 리뷰가 적을수록 신규 진입 쉬움). 단 리뷰벽이 높아도(브랜드 강세) 품질/가격 우위가 가능하면 제외하지 말고 difficulty="고난도"로 표시.',
  '4) 작고 가벼운(배송비 유리) 상품 가산점.',
  '',
  '출력은 반드시 JSON: {"picks":[{"keyword","grade":"강력추천|추천|고난도|보류","why":"왜 추천하는지 1~2문장(수요근거+마진+경쟁상황)","margin":"예 3~4배(검증필요시 명시)","caution":"주의점/차별화 포인트"}],"skipped":[{"keyword","reason"}]}. picks는 경쟁력 순.',
].join('\n');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return err(405, 'POST만 허용됩니다.');

  const auth = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!process.env.LUMI_SECRET || auth !== process.env.LUMI_SECRET) {
    return err(401, '인증 실패');
  }

  let candidates, wantEmail = false;
  try {
    const parsed = JSON.parse(event.body || '{}');
    candidates = Array.isArray(parsed.candidates) ? parsed.candidates.slice(0, 20) : null;
    wantEmail = parsed.email === true;
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

  // 2) Gemini 분석
  const userPayload = candidates.map((c) => ({
    키워드: c.kw,
    쿠팡_상위: (c.top || []).slice(0, 4).map((p) => ({ 이름: p.n, 판매가: p.p, 리뷰: p.r })),
    쿠팡_중앙가: c.medPrice, 쿠팡_1위리뷰: c.topReviews,
    도매_샘플: (c.domeSample || []).map((d) => ({ 이름: d.name, 도매가: d.w })),
    도매_최저: c.domeLow, 거친마진: c.margin, 네이버_월검색: c.naverVolume,
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
      const items = report.picks.map((p, i) => (
        '<div style="margin:0 0 14px;padding:14px 16px;border:1px solid #eee;border-radius:12px">' +
        '<div style="font-size:15px;font-weight:800;color:#222">' + (i + 1) + '. ' + esc(p.keyword) +
        ' <span style="font-size:12px;font-weight:700;color:#fff;background:' + gradeColor(p.grade) + ';border-radius:980px;padding:2px 10px;margin-left:6px">' + esc(p.grade || '') + '</span>' +
        (p.margin ? ' <span style="font-size:13px;color:#C8507A;font-weight:700">' + esc(p.margin) + '</span>' : '') + '</div>' +
        (p.why ? '<div style="font-size:13px;color:#444;line-height:1.6;margin-top:6px">→ ' + esc(p.why) + '</div>' : '') +
        (p.caution ? '<div style="font-size:12px;color:#a1455f;line-height:1.6;margin-top:4px">⚠ ' + esc(p.caution) + '</div>' : '') +
        '</div>'
      )).join('');
      const html = '<div style="max-width:600px;margin:0 auto;font-family:system-ui,-apple-system,sans-serif">' +
        '<h2 style="color:#C8507A;font-size:18px;margin-bottom:4px">🛒 오늘의 매입 분석 — ' + today + '</h2>' +
        '<p style="font-size:13px;color:#666;margin-top:0">네이버 검색량 + 쿠팡 경쟁 + 도매토피아 매입가 종합. 경쟁력 순.</p>' +
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
