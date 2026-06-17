// admin-sourcing-analysis.js — 운영자 전용 매입(소싱) 분석 엔진.
// GET /api/admin-sourcing-analysis  (requireAdmin — 나만 접근)
//
// 출력: 현재 시점/계절(룰) + 네이버 검색광고 키워드도구 실검색량 + LLM 매입 추천.
// LLM 은 공개 시장 데이터라 sensitive:false → OpenAI 죽어도 무료 Gemini 로 동작.
// (도매토피아 자동매칭·쿠팡은 후속 — 목록 JS 스크래핑/안티봇 이슈로 보류.)
'use strict';

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { getAdminClient } = require('./_shared/supabase-admin');
const { requireAdmin } = require('./_shared/admin-guard');
const { fetchRelatedKeywords } = require('./_shared/naver-ad-keyword-tool');
const { llmChat } = require('./_shared/llm-call');

// 월별 시즌 베이스라인 — 한국 리테일 계절성. seeds = 네이버 검색량 조회용 시드.
const SEASON_BY_MONTH = {
  1:  { label: '한겨울·신년', seeds: ['가습기', '핫팩', '전기요', '방한용품', '다이어리', '제습제'] },
  2:  { label: '늦겨울·졸업입학', seeds: ['가습기', '발렌타인', '졸업선물', '입학준비물', '황사마스크', '전기요'] },
  3:  { label: '초봄·신학기', seeds: ['미세먼지마스크', '신학기용품', '캠핑용품', '등산용품', '원예용품', '우산'] },
  4:  { label: '봄·나들이', seeds: ['캠핑용품', '등산용품', '자전거용품', '원예용품', '피크닉매트', '양산'] },
  5:  { label: '늦봄·가정의달', seeds: ['어린이날선물', '캠핑용품', '선풍기', '나들이용품', '양산', '피크닉매트'] },
  6:  { label: '초여름·장마·폭염', seeds: ['모기장', '쿨매트', '휴대용선풍기', '제습제', '우산', '아이스팩', '해충퇴치', '냉감이불', '수영복', '캠핑용품'] },
  7:  { label: '한여름·휴가', seeds: ['선풍기', '물놀이용품', '수영복', '제습제', '모기장', '아이스박스', '쿨토시', '양산', '휴대용선풍기'] },
  8:  { label: '한여름·말복', seeds: ['물놀이용품', '제습제', '선풍기', '벌레퇴치', '쿨매트', '캠핑용품', '휴가용품'] },
  9:  { label: '환절기·추석', seeds: ['추석선물세트', '환절기용품', '가을캠핑', '등산용품', '제습제', '홈웨어'] },
  10: { label: '가을·아웃도어', seeds: ['등산용품', '캠핑용품', '가습기', '할로윈용품', '난방용품', '홈웨어'] },
  11: { label: '초겨울·김장', seeds: ['김장용품', '가습기', '방한용품', '패딩', '핫팩', '전기요'] },
  12: { label: '한겨울·연말', seeds: ['크리스마스용품', '가습기', '방한용품', '핫팩', '난방텐트', '연말선물세트'] },
};

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'GET only' }) };

  let admin;
  try { admin = getAdminClient(); }
  catch (e) { console.error('[admin-sourcing] admin client:', e.message); return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 설정 오류' }) }; }

  // 관리자 인증 — 나만 접근
  const gate = await requireAdmin(event, admin);
  if (!gate.ok) return { statusCode: gate.status, headers, body: JSON.stringify({ error: gate.error }) };

  // ① 시점/계절 (KST)
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const year = kst.getUTCFullYear();
  const month = kst.getUTCMonth() + 1;
  const season = SEASON_BY_MONTH[month] || { label: '', seeds: [] };

  // ② 네이버 검색광고 키워드도구 — 시즌 시드별 실 검색량 (병렬, 실패는 무시)
  let keywords = [];
  try {
    const results = await Promise.all(season.seeds.map((s) => fetchRelatedKeywords(s).catch(() => [])));
    const map = new Map();
    for (const k of results.flat()) {
      if (!k || !k.keyword) continue;
      const prev = map.get(k.keyword);
      if (!prev || (k.monthlyTotal || 0) > (prev.monthlyTotal || 0)) map.set(k.keyword, k);
    }
    keywords = Array.from(map.values())
      .filter((k) => (k.monthlyTotal || 0) > 0)
      .sort((a, b) => (b.monthlyTotal || 0) - (a.monthlyTotal || 0))
      .slice(0, 40);
  } catch (e) {
    console.warn('[admin-sourcing] 키워드 조회 실패:', e && e.message);
  }
  const naverConfigured = keywords.length > 0;

  // ③ LLM 종합 — 매입 추천 (공개 데이터 → sensitive:false → 무료 Gemini 허용)
  let recommendation = '';
  try {
    const top = keywords.slice(0, 25)
      .map((k) => `${k.keyword}(월검색 ${(k.monthlyTotal || 0).toLocaleString()}, 경쟁 ${k.competitionIdx || '-'})`)
      .join(', ');
    const prompt = [
      '당신은 한국 도매 소싱 분석가다. 소상공인이 도매몰(도매토피아 등)에서 떼와 쿠팡/스마트스토어에 되팔 상품을 고르도록 돕는다.',
      `현재: ${year}년 ${month}월 (시즌: ${season.label}).`,
      naverConfigured
        ? `네이버 실시간 검색량 상위 키워드: ${top}`
        : '(네이버 검색량 데이터 없음 — 시즌 일반 지식만으로 분석. "추정"으로 표기할 것.)',
      '아래를 한국어로 실용적으로 작성:',
      '1) 지금 매입하기 좋은 상품 카테고리 5~8개 — 각각 이유(계절 수요 + 검색량 근거).',
      '2) 각 카테고리에서 도매몰 잡화로 떼기 적합한 구체 품목 예시.',
      '3) 피해야 할 것 — 마진 얇거나 도매잡화에 부적합한 것(가전·브랜드 의류 등).',
      '4) 차별화 한 줄 — 레드오션 회피 아이디어.',
      '과장·허위 수치 금지. 데이터 없는 주장은 "추정"이라 명시.',
    ].join('\n');

    const res = await llmChat(
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 1400, temperature: 0.6 },
      { sensitive: false, label: 'sourcing-analysis', timeoutMs: 60000 }
    );
    const data = await res.json();
    recommendation = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
  } catch (e) {
    console.warn('[admin-sourcing] LLM 종합 실패:', e && e.message);
  }

  return {
    statusCode: 200,
    headers: { ...headers, 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      generatedAt: kst.toISOString().slice(0, 16).replace('T', ' ') + ' KST',
      year,
      month,
      season: season.label,
      naverConfigured,
      keywords: keywords.map((k) => ({ keyword: k.keyword, monthlyTotal: k.monthlyTotal || 0, competition: k.competitionIdx || '' })),
      recommendation,
    }),
  };
};
