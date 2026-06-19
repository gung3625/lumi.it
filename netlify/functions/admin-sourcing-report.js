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
// 광고 5% + 반품 3% = 판매가 비례 8%(고정), 수수료+결제+VAT는 카테고리별(CATEGORY_FEE), 택배 3000 + 포장 500 = 건당 고정.
const PRICING = { adRate: 0.05, returnRate: 0.03, ship: 3000, pack: 500, targetMargin: 0.25 };

// 카테고리별 실효 차감율(쿠팡 판매수수료 + 결제 + VAT 합산). 고수 법칙: 카테고리마다 수수료가 다르다.
const CATEGORY_FEE = {
  뷰티: 0.155, 패션: 0.165, 식품: 0.165, 반려: 0.145,
  디지털: 0.125, 가전: 0.13, 차량: 0.135, 유아: 0.135, 생활: 0.135, 기타: 0.145,
};
function inferCategory(kw) {
  const s = String(kw || '');
  if (/화장품|뷰티|네일|브러시|필링|헤어|메이크업|욕실|칫솔/.test(s)) return '뷰티';
  if (/강아지|고양이|펫|반려/.test(s)) return '반려';
  if (/유아|아기|완구|블록|퍼즐|보드게임/.test(s)) return '유아';
  if (/폰|맥세이프|보조배터리|에어팟|태블릿|그립톡|충전|디지털/.test(s)) return '디지털';
  if (/선풍기|제습기|에어컨|히터|가전|조명|무드등|수유등|LED|건조기/.test(s)) return '가전';
  if (/차량|주차|트렁크/.test(s)) return '차량';
  if (/에코백|파우치|지갑|모자|양말|장갑|가방|의류/.test(s)) return '패션';
  if (/식품|간식|커피|도시락/.test(s)) return '식품';
  return '생활';
}

function won(n) { return Math.round(n / 10) * 10; }
// 매입가(도매)·시장가(쿠팡 현재가) → 권장판매가/순마진/마진배수. 시장가에 팔 때 실제 남는 돈을 본다.
function computePricing(wholesale, market, category) {
  if (!wholesale || !market || wholesale <= 0 || market <= 0) return null;
  const p = PRICING;
  const cat = category || '기타';
  const feeRate = CATEGORY_FEE[cat] != null ? CATEGORY_FEE[cat] : CATEGORY_FEE['기타'];
  const w = Math.round(wholesale), m = Math.round(market);
  const fees = Math.round(m * feeRate);              // 판매수수료+결제+VAT(카테고리별)
  const adRet = Math.round(m * (p.adRate + p.returnRate)); // 광고+반품 예비
  const logi = p.ship + p.pack;                      // 택배+포장
  const cost = w + fees + adRet + logi;              // 총원가
  const net = m - cost;                              // 건당 순이익
  const marginPct = Math.round((net / m) * 100);
  const varRate = feeRate + p.adRate + p.returnRate;
  const floor = (w + p.ship + p.pack) / (1 - varRate - p.targetMargin); // 25% 손익선
  const mult = +(m / w).toFixed(1);                  // 마진배수(도매가 대비) — 고수가 가격 잡는 단위
  const multTier = mult >= 3 ? '브랜드급(3배+)' : mult >= 2 ? '적정(2~3배)' : mult >= 1.6 ? '박리(1.6~2배)' : '저배수(주의)';
  return {
    매입가: w, 시장가: m, 권장판매가: won(m),
    카테고리: cat, 적용수수료율: Math.round(feeRate * 100),
    마진배수: mult, 배수등급: multTier,
    예상순마진율: marginPct, 예상순이익: net,
    마진25_최소판매가: won(floor),
    번들필요: marginPct < p.targetMargin * 100,       // 단품 25% 미달 → 묶음/유료배송
    원가구성: { 매입: w, 수수료VAT: fees, 광고반품: adRet, 택배포장: logi, 총원가: cost },
  };
}

// GMROI 관점 — 고수 법칙: 마진율만 보지 말고 "회전(팔리는 속도)"과 곱해라.
function turnoverVerdict(naverVolume, medReviews, marginPct) {
  const demand = (naverVolume || 0) + (medReviews || 0) * 30; // 리뷰 1개 ≈ 검색 30 가중
  const 회전 = demand >= 30000 ? 'high' : demand >= 8000 ? 'mid' : 'low';
  const 마진ok = marginPct >= 20;
  let 판정, 전략;
  if (회전 !== 'low' && 마진ok) { 판정 = '최우선'; 전략 = '잘 팔리고 마진도 남음 — 바로 사입'; }
  else if (회전 !== 'low' && !마진ok) { 판정 = '박리다매'; 전략 = '마진 얇지만 회전 빨라 물량으로 번다 — 번들로 객단가↑'; }
  else if (회전 === 'low' && 마진ok) { 판정 = '재고주의'; 전략 = '마진 좋아도 안 팔리면 흑자도산 — 소량 테스트부터'; }
  else { 판정 = '비추천'; 전략 = '안 팔리고 마진도 얇음 — 패스'; }
  return { 회전, 판정, 전략 };
}

// ★ 같은 스펙 매칭 — 도매 최저가 맹신 금지. 쿠팡 대표상품과 같은 수량 기준으로 도매원가 환산.
const PB_BRANDS = ['코멧', '탐사', '홈플래닛', '곰곰', '줄라이', '꼬리별', '베이스알파', '캐럿'];
function parseQty(name) {
  const s = String(name || '');
  const m = s.match(/(\d+)\s*(개입|개|입|매|장|팩|세트|구|병|포|롤|p|ea)/i);
  if (m) { const n = parseInt(m[1], 10); if (n > 0 && n <= 1000) return n; }
  return 1;
}
function tokenize(s) {
  return String(s || '').toLowerCase().replace(/[^가-힣a-z0-9]/g, ' ').split(/\s+/).filter((t) => t.length >= 2);
}
// 키워드 토큰을 뺀 "추가 공통 토큰" 수 — 키워드는 검색어라 양쪽에 다 있으니 신뢰 신호 못 됨.
function extraOverlap(a, b, kwSet) {
  const A = new Set(tokenize(a)); let c = 0;
  for (const t of tokenize(b)) if (A.has(t) && !kwSet.has(t)) c++;
  return c;
}
// 쿠팡 대표상품(top[0])과 가장 비슷한 도매 샘플을 골라 같은 수량 기준 도매원가 환산.
function matchWholesale(rep, domeSample, kw) {
  if (!rep || !Array.isArray(domeSample) || !domeSample.length) return null;
  const kwSet = new Set(tokenize(kw));
  let best = null, bestScore = -1;
  for (const d of domeSample) {
    const s = extraOverlap(rep.n, d.name, kwSet);
    if (s > bestScore || (s === bestScore && best && d.w < best.w)) { bestScore = s; best = d; }
  }
  if (!best) return null;
  const repQty = parseQty(rep.n), domeQty = parseQty(best.name);
  const domeUnit = best.w / domeQty;              // 도매 개당 단가
  const wholesaleForRepPack = Math.round(domeUnit * repQty); // 쿠팡과 같은 수량일 때 도매원가
  // 신뢰 "높음" 조건: 키워드 외 공통 토큰 있음 AND 환산원가가 시장가의 8%+ (너무 싸면 다른 상품)
  const priceOk = wholesaleForRepPack >= Math.round((rep.p || 0) * 0.08);
  const conf = (bestScore >= 1 && priceOk) ? '높음' : '낮음';
  return { 도매상품: best.name, 도매가: best.w, 도매수량: domeQty, 쿠팡수량: repQty, 환산도매원가: wholesaleForRepPack, 매칭신뢰: conf };
}
// 경쟁 심층 — 상위 가격분포 + PB 점유.
function competitionInfo(top) {
  const arr = Array.isArray(top) ? top : [];
  const prices = arr.map((p) => p.p).filter((n) => n > 0).sort((a, b) => a - b);
  const pb = arr.filter((p) => PB_BRANDS.some((b) => (p.n || '').indexOf(b) >= 0)).length;
  const rocket = arr.filter((p) => p.rk).length;
  return {
    상위수: arr.length,
    가격최저: prices.length ? prices[0] : null,
    가격최고: prices.length ? prices[prices.length - 1] : null,
    PB개수: pb,
    로켓개수: rocket,
  };
}

const SYSTEM = [
  '너는 한국 온라인셀러의 소싱(매입) 바이어이자 머천다이저다. "무엇을 매입하면 경쟁력 있고, 얼마에 올려, 어떻게 팔아야 잘 팔리는지"까지 판단한다.',
  '입력 후보마다: 쿠팡 인기상품(판매가·리뷰수), 도매 샘플(상품명·도매가), 네이버 월검색량,',
  '이미 계산된 가격분석(매입가/시장가/권장판매가/마진배수/배수등급/카테고리/적용수수료율/예상순마진율/예상순이익/마진25_최소판매가/번들필요), 회전판정(회전/판정/전략)이 들어온다.',
  '',
  '== 마진·가격은 계산이 끝나 들어온다. 숫자 재계산 금지, 해석·판단만. ==',
  '예상순마진율 = 도매가로 떼서 시장가에 팔 때 카테고리수수료+결제+VAT+택배+포장+광고+반품 다 빼고 남는 진짜 마진율.',
  '마진배수 = 시장가÷도매가. 1.6~2배=박리다매, 2~3배=적정, 3배+=브랜드급. 배수 높을수록 가격 내려 경쟁할 여력 큼.',
  '',
  '== 게이트(하나라도 실패하면 grade="보류" + skipped 사유) ==',
  'G1 마진: 예상순마진율 < 25% AND 예상순이익 < 3000원 이면 단품 매입가치 낮음. 번들필요=true면 "묶음 시 가능"으로 살리되 grade 최대 "고난도".',
  'G2 규제: 화장품·식품·전기전자·유아아동·의료기기 등 인증(KC/제조판매업/영업신고) 필요 품목이면 caution에 "인증 필요" 명시.',
  'G3 정품: 브랜드 짝퉁/무단 병행수입 위험이 보이면 보류.',
  '',
  '== 판단 원칙 ==',
  '1) 마진은 "같은 스펙·같은 수량" 기준으로 환산돼 들어온다. 가격분석.매칭신뢰="낮음"이면 도매-쿠팡이 다른 상품일 수 있으니 grade를 낮추고 caution에 "도매 상품 직접 확인(매칭 불확실)". 도매수량≠쿠팡수량이면 환산 사실을 why에 설명.',
  '2) 검색량 높아도 "구매의도"가 아닌 "정보성 도구" 검색(예: 계산기)이면 skipped.',
  '3) 경쟁력 = 수요 × 순마진 × 리뷰벽(상위 리뷰 적을수록 진입 쉬움). 경쟁.PB개수가 많으면 상위 PB 장악이니 감점(품질/가격 우위 가능하면 "고난도"). 경쟁.가격최저~최고 폭이 좁고 낮으면 최저가 전쟁이라 caution.',
  '4) GMROI 법칙 = 마진율 × 회전(팔리는 속도). 회전판정을 반영하라: 판정="박리다매"면 마진 얇아도 회전으로 추천(번들 권장), "재고주의"(고마진·저수요)면 caution에 "소량 테스트(흑자도산 위험)", "비추천"이면 skipped.',
  '5) 작고 가벼운 상품 가산, 부피 큰 저가품 감점(택배가 마진 잠식).',
  '6) 계절상품=true는 제철 수요 급증 — grade 한 단계 가산, why에 "제철 수요" 근거.',
  '',
  '== 판매 전술: sellingHook = "어떻게 하면 사람이 혹해서 사는가" 2~3개 구체 전술(숫자 포함) ==',
  '아래 레버 중 이 상품에 가장 잘 먹힐 것만 골라라:',
  '- 가격후킹: 단수가격(9,900·12,900), 즉시할인 표시가(원가에 줄 긋고 세일가), 첫구매쿠폰',
  '- 구성후킹: 묶음(2개·3개 세트)·1+1·사은품으로 가성비 인식+객단가↑ (번들필요=true면 필수)',
  '- 신뢰후킹: 초기 포토리뷰 이벤트(적립금)로 리뷰 빠르게 — 리뷰수가 전환의 핵심',
  '- 노출후킹: 제목에 핵심+롱테일 키워드 조합, 정확한 카테고리, 썸네일 첫 컷에 USP+숫자(용량·개수)',
  '- 차별화후킹: 색상/구성 옵션, 한국형 개선점, 사용 장면 강조',
  '- 긴급후킹: 한정수량·타임딜 (재고 적을 때만)',
  '',
  '== 출력(JSON만) ==',
  '{"picks":[{"keyword","grade":"강력추천|추천|고난도|보류","priceReason":"가격 근거 1~2문장","sellingHook":"이렇게 팔면 혹한다 — 구체 전술 2~3개","why":"왜 추천 1~2문장","caution":"주의/스펙/인증"}],"skipped":[{"keyword","reason"}]}',
  'priceReason = 권장가를 왜 그 가격으로: (a)천장=시세 (b)바닥=마진25_최소판매가 (c)순마진 %+언더컷 여력. 마진배수도 언급("도매 4.6배라 가격 방어력 큼").',
  'sellingHook = 위 레버에서 골라 이 상품 맞춤으로. 예: "12,900원 단수가 + 2개 17,900 묶음으로 택배비 희석, 포토리뷰 적립 1,000원으로 초기 리뷰 확보, 썸네일에 풍량 3단계 강조".',
  'picks는 (회전 × 마진 × 경쟁) 종합 "잘 팔릴 순"으로 정렬. picks는 최대 10개만(가장 잘 팔릴 것), 나머지는 skipped에 키워드+짧은 사유.',
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
  const pricingByKw = {}, seasonalByKw = {}, gmroiByKw = {}, linkByKw = {}, compByKw = {}, thumbByKw = {};
  for (const c of candidates) {
    const rep = (c.top && c.top[0]) ? c.top[0] : null;            // 대표상품 = 리뷰 1위
    thumbByKw[c.kw] = (rep && rep.th) ? rep.th : null;
    const repPrice = (rep && rep.p) ? rep.p : c.medPrice;         // 시장 anchor
    const match = matchWholesale(rep, c.domeSample, c.kw);        // 같은 스펙 도매원가 환산
    const wholesale = match ? match.환산도매원가 : c.domeLow;      // 매칭 실패 시 기존 최저가
    const pr = computePricing(wholesale, repPrice, inferCategory(c.kw));
    if (pr) {
      pr.쿠팡대표 = rep ? rep.n : null;
      if (match) { pr.도매상품 = match.도매상품; pr.도매가원본 = match.도매가; pr.도매수량 = match.도매수량; pr.쿠팡수량 = match.쿠팡수량; pr.매칭신뢰 = match.매칭신뢰; }
      else { pr.매칭신뢰 = '낮음'; }
    }
    pricingByKw[c.kw] = pr;
    seasonalByKw[c.kw] = !!c.seasonal;
    gmroiByKw[c.kw] = turnoverVerdict(c.naverVolume, c.medReviews, pr ? pr.예상순마진율 : 0);
    compByKw[c.kw] = competitionInfo(c.top);
    const encKw = encodeURIComponent(c.kw);
    linkByKw[c.kw] = {
      coupang: (rep && rep.l) ? rep.l : ('https://www.coupang.com/np/search?q=' + encKw),
      dome: 'https://dometopia.com/goods/search?search_text=' + encKw,
    };
  }

  // 3) Gemini 분석 (마진 숫자는 위 계산값을 그대로 전달 — 재계산 X)
  const userPayload = candidates.map((c) => ({
    키워드: c.kw,
    쿠팡_상위: (c.top || []).slice(0, 4).map((p) => ({ 이름: p.n, 판매가: p.p, 리뷰: p.r })),
    쿠팡_중앙가: c.medPrice, 쿠팡_1위리뷰: c.topReviews, 쿠팡_중앙리뷰: c.medReviews,
    도매_샘플: (c.domeSample || []).map((d) => ({ 이름: d.name, 도매가: d.w })),
    네이버_월검색: c.naverVolume,
    가격분석: pricingByKw[c.kw],
    회전판정: gmroiByKw[c.kw],
    경쟁: compByKw[c.kw],
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
      max_tokens: 6000,
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
        pk.gmroi = gmroiByKw[pk.keyword] || null;
        pk.links = linkByKw[pk.keyword] || null;
        pk.comp = compByKw[pk.keyword] || null;
        pk.thumb = thumbByKw[pk.keyword] || null;
      }
    }
  } catch (e) {
    llmErr = e && e.message ? e.message : 'LLM 분석 실패';
  }

  // 이메일 발송 (cron/전체 실행 시 email:true)
  let emailed = false, emailError = null, emailTo = null;
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
          (pr.마진배수 ? ' <span style="color:#7a5; font-weight:700">(' + pr.마진배수 + '배)</span>' : '') +
          ' <span style="color:' + mColor + ';font-weight:800">순마진 ' + pr.예상순마진율 + '% (건당 ' + num(pr.예상순이익) + '원)</span>' +
          ((pr.쿠팡대표 || pr.도매상품) ? '<div style="font-size:11px;color:#777;margin-top:6px">🔎 쿠팡 "' + esc(String(pr.쿠팡대표 || '').slice(0, 26)) + '" ↔ 도매 "' + esc(String(pr.도매상품 || '?').slice(0, 26)) + '" ' + (pr.매칭신뢰 === '높음' ? '<span style="color:#1f9d57;font-weight:700">매칭✓</span>' : '<span style="color:#c0392b;font-weight:700">매칭 불확실 — 직접 확인</span>') + ((pr.도매수량 && pr.쿠팡수량 && pr.도매수량 !== pr.쿠팡수량) ? (' <span style="color:#999">(도매 ' + pr.도매수량 + '개→쿠팡 ' + pr.쿠팡수량 + '개 환산)</span>') : '') + '</div>' : '') +
          (pr.원가구성 ? '<div style="font-size:11px;color:#888;margin-top:5px">원가: 매입 ' + num(pr.원가구성.매입) + ' + 수수료·VAT ' + num(pr.원가구성.수수료VAT) + ' + 택배·포장 ' + num(pr.원가구성.택배포장) + ' + 광고·반품 ' + num(pr.원가구성.광고반품) + ' = ' + num(pr.원가구성.총원가) + '원 → 권장가의 나머지가 순이익</div>' : '') +
          (pr.번들필요 ? '<div style="font-size:12px;color:#a1455f;margin-top:3px">※ 단품 마진 약함 — 25% 내려면 ' + num(pr.마진25_최소판매가) + '원, 묶음/유료배송 권장</div>' : '') +
          '</div>';
      };
      const gmroiColor = (v) => v === '최우선' ? '#1f9d57' : v === '박리다매' ? '#0a84c2' : v === '재고주의' ? '#e8820c' : '#999';
      const linkBtn = (href, label, bg) => '<a href="' + href + '" style="display:inline-block;font-size:12px;font-weight:700;color:#fff;background:' + bg + ';text-decoration:none;border-radius:980px;padding:6px 13px;margin-right:6px">' + label + '</a>';
      const linksRow = (lk) => lk ? '<div style="margin-top:9px">' + linkBtn(lk.dome, '📦 도매토피아 매입', '#C8507A') + linkBtn(lk.coupang, '🛒 쿠팡에서 보기', '#555') + '</div>' : '';
      const items = report.picks.map((p, i) => (
        '<div style="margin:0 0 14px;padding:14px 16px;border:1px solid #eee;border-radius:12px">' +
        (p.thumb ? '<img src="' + esc(p.thumb) + '" width="64" height="64" style="float:right;width:64px;height:64px;object-fit:cover;border-radius:8px;margin:0 0 6px 10px" alt="">' : '') +
        '<div style="font-size:15px;font-weight:800;color:#222">' + (i + 1) + '. ' + esc(p.keyword) +
        ' <span style="font-size:12px;font-weight:700;color:#fff;background:' + gradeColor(p.grade) + ';border-radius:980px;padding:2px 10px;margin-left:6px">' + esc(p.grade || '') + '</span>' +
        (p.seasonal ? ' <span style="font-size:12px;font-weight:700;color:#fff;background:#e8820c;border-radius:980px;padding:2px 10px;margin-left:4px">🌞 제철</span>' : '') + '</div>' +
        priceBox(p.pricing) +
        (p.gmroi ? '<div style="font-size:12px;margin-top:6px"><span style="font-weight:700;color:#fff;background:' + gmroiColor(p.gmroi.판정) + ';border-radius:980px;padding:2px 9px">' + esc(p.gmroi.판정) + '</span> <span style="color:#666">' + esc(p.gmroi.전략) + '</span></div>' : '') +
        (p.comp && p.comp.가격최저 ? '<div style="font-size:11px;color:#888;margin-top:6px">🏷 경쟁: 상위 ' + p.comp.상위수 + '개 · 가격대 ' + num(p.comp.가격최저) + '~' + num(p.comp.가격최고) + '원' + (p.comp.PB개수 ? ' · <span style="color:#c0392b">PB ' + p.comp.PB개수 + '개</span>' : '') + (p.comp.로켓개수 ? ' · 🚀로켓 ' + p.comp.로켓개수 + '개' : '') + '</div>' : '') +
        (p.priceReason ? '<div style="font-size:12px;color:#555;line-height:1.6;margin-top:6px">💡 <b>가격 근거:</b> ' + esc(p.priceReason) + '</div>' : '') +
        (p.sellingHook ? '<div style="font-size:13px;color:#1f6f43;background:#eef9f1;border-radius:8px;padding:8px 12px;line-height:1.6;margin-top:6px">🎯 <b>이렇게 팔아라:</b> ' + esc(p.sellingHook) + '</div>' : '') +
        (p.why ? '<div style="font-size:13px;color:#444;line-height:1.6;margin-top:6px">→ ' + esc(p.why) + '</div>' : '') +
        (p.caution ? '<div style="font-size:12px;color:#a1455f;line-height:1.6;margin-top:4px">⚠ ' + esc(p.caution) + '</div>' : '') +
        linksRow(p.links) +
        '</div>'
      )).join('');
      const html = '<div style="max-width:600px;margin:0 auto;font-family:system-ui,-apple-system,sans-serif">' +
        '<h2 style="color:#C8507A;font-size:18px;margin-bottom:4px">🛒 오늘의 매입 분석 — ' + today + '</h2>' +
        '<p style="font-size:13px;color:#666;margin-top:0">수요(검색량·리뷰) × 순마진 × 회전(GMROI) 종합 — "잘 팔릴 순". 상품마다 가격 근거 + 판매 전술 포함.</p>' +
        (season ? '<p style="font-size:13px;color:#e8820c;font-weight:700;margin:0 0 10px">🌞 이번 계절: ' + esc(season) + ' — 제철 상품 포함</p>' : '') +
        items +
        '<p style="font-size:11px;color:#999;margin-top:16px">※ "검증 필요" 마진은 같은 스펙 제품 도매가 재확인 권장. 루미 소싱봇 자동 생성.</p></div>';
      const resend = new Resend(process.env.RESEND_API_KEY);
      emailTo = process.env.ADMIN_EMAIL || 'gung3625@gmail.com';
      const sendRes = await resend.emails.send({
        from: process.env.SOURCING_FROM || 'lumi <noreply@lumi.it.kr>',
        to: emailTo,
        subject: '🛒 오늘의 쿠팡 매입 분석 — ' + report.picks.length + '개 추천 (' + today + ')',
        html,
      });
      if (sendRes && sendRes.error) {
        emailError = sendRes.error.message || (sendRes.error.name ? sendRes.error.name : JSON.stringify(sendRes.error));
        console.error('[sourcing-report] Resend 거부:', emailError);
      } else {
        emailed = true;
      }
    } catch (e) { emailError = e && e.message ? e.message : String(e); console.error('[sourcing-report] 이메일 발송 실패:', emailError); }
  }

  return ok({
    generatedAt: new Date().toISOString(),
    candidateCount: candidates.length,
    report,
    emailed,
    emailTo,
    emailError,
    llmError: llmErr,
  });
};
