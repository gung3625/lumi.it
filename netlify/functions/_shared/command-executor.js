// command-executor.js — 분류된 명령을 결과 카드로 변환
// 메모리 project_intelligence_strategy_doctrine_0428.md (Orchestrator)
//
// Intent별 분기:
//   shop       → call4o → action_card (베타: 정식 출시 시 실행)
//   greeting   → 정해진 응답 (₩0)
//   non_related → 정중 거부 (₩0)
//   abuse      → 차단 + 로그
//   weather    → external-apis/weather (Tier 0)
//   currency   → external-apis/currency (Tier 0)
//   calendar   → external-apis/holiday (Tier 0)
//   calc       → external-apis/calculator (Tier 0)
//
// 모든 결과 = { ok, ability_level, cost_tier, summary, payload }
//   ability_level: 1 자동 / 2 제안 / 3 보조 / 4 사장님

const { call4o } = require('./llm-router');
const { getWeather } = require('./external-apis/weather');
const { getRate } = require('./external-apis/currency');
const { getUpcoming, findByName } = require('./external-apis/holiday');
const { interpret: interpretCalc } = require('./external-apis/calculator');
const { getAdminClient } = require('./supabase-admin');

const GREETING_RESPONSES = [
  '안녕하세요, 사장님! 오늘도 잘 부탁드려요',
  '반가워요, 사장님. 오늘 무엇을 도와드릴까요?',
  '안녕하세요. 트렌드·재고·CS 다 봐드릴 수 있어요',
];

const NON_RELATED_RESPONSE = '저는 사장님 가게 일만 도와드려요. 가격·재고·트렌드·CS 같은 운영 명령을 알려 주시면 처리해 드릴게요.';
const ABUSE_RESPONSE = '그런 표현에는 응답하지 않아요. 운영 관련 명령으로 다시 말씀해 주세요.';

function pickGreeting() {
  return GREETING_RESPONSES[Math.floor(Math.random() * GREETING_RESPONSES.length)];
}

/**
 * shop 명령 처리 — call4o로 액션 JSON 생성
 * 베타 단계: 안전한 dry-run (실제 마켓 호출 X). 정식 출시 시 executor 마켓 어댑터 연결.
 */
async function executeShop(input, { sellerId } = {}) {
  const system = `너는 한국 1인 셀러 도우미 "루미"의 명령 실행기다. JSON만 출력.
입력 명령을 다음 스키마로 변환:
{
  "action_type": "list_products | adjust_price | check_stock | search_trend | view_cs | analyze_orders | unknown",
  "params": { ... },
  "ability_level": 1 | 2 | 3 | 4,
  "summary": "사장님께 보여드릴 1줄 요약",
  "next_steps": [ "다음 액션 제안 1~3개" ]
}
ability_level: 1=즉시 자동, 2=제안 후 1탭 승인, 3=정보 보조, 4=사장님이 직접
실제 마켓 호출은 정식 출시 시 동작하니까 베타에서는 next_steps만 반환.`;

  const r = await call4o({
    system,
    user: input,
    max_tokens: 400,
    sellerId,
    cacheKind: 'shop_command',
  });

  if (!r.ok) {
    return {
      ok: false,
      ability_level: 3,
      cost_tier: 2,
      summary: r.rateLimited ? r.error : '명령을 잠시 처리하지 못했어요',
      payload: { error: r.error },
    };
  }

  const parsed = r.result || {};
  return {
    ok: true,
    ability_level: parsed.ability_level || 2,
    cost_tier: 2,
    summary: parsed.summary || '명령을 이해했어요',
    payload: {
      kind: 'shop_command',
      action_type: parsed.action_type || 'unknown',
      params: parsed.params || {},
      next_steps: Array.isArray(parsed.next_steps) ? parsed.next_steps : [],
      cached: r.cached || false,
      beta_note: '베타 단계 — 정식 출시 시 즉시 실행돼요',
    },
  };
}

async function executeGreeting() {
  return {
    ok: true,
    ability_level: 1,
    cost_tier: 0,
    summary: pickGreeting(),
    payload: { kind: 'greeting' },
  };
}

async function executeNonRelated() {
  return {
    ok: true,
    ability_level: 4,
    cost_tier: 0,
    summary: NON_RELATED_RESPONSE,
    payload: { kind: 'non_related' },
  };
}

async function executeAbuse(input, { sellerId } = {}) {
  // 로그
  try {
    const admin = getAdminClient();
    await admin.from('command_abuse_log').insert({
      seller_id: sellerId || null,
      input: String(input).slice(0, 200),
      reason: 'abuse',
    });
  } catch (_) {}
  return {
    ok: true,
    ability_level: 4,
    cost_tier: 0,
    summary: ABUSE_RESPONSE,
    payload: { kind: 'abuse', blocked: true },
  };
}

async function executeWeather() {
  const r = await getWeather({ city: '서울' });
  return {
    ok: r.ok,
    ability_level: 1,
    cost_tier: 0,
    summary: r.summary,
    payload: { kind: 'weather', detail: r },
  };
}

async function executeCurrency(input) {
  // input에서 통화 추출
  let base = 'USD';
  if (/위안|cny/i.test(input)) base = 'CNY';
  else if (/엔화|jpy/i.test(input)) base = 'JPY';
  else if (/유로|eur/i.test(input)) base = 'EUR';
  const r = await getRate({ base, target: 'KRW' });
  return {
    ok: r.ok,
    ability_level: 1,
    cost_tier: 0,
    summary: r.summary,
    payload: { kind: 'currency', detail: r },
  };
}

async function executeCalendar(input) {
  // 키워드 매칭
  const m = input.match(/(어린이날|어버이날|설날|추석|크리스마스|광복절|개천절|한글날|현충일|삼일절)/);
  if (m) {
    const r = await findByName(m[1]);
    return {
      ok: r.ok,
      ability_level: 1,
      cost_tier: 0,
      summary: r.summary,
      payload: { kind: 'calendar', detail: r },
    };
  }
  const r = await getUpcoming({ count: 3 });
  return {
    ok: r.ok,
    ability_level: 1,
    cost_tier: 0,
    summary: r.summary,
    payload: { kind: 'calendar', detail: r },
  };
}

async function executeCalc(input) {
  const r = interpretCalc(input);
  return {
    ok: r.ok,
    ability_level: 1,
    cost_tier: 0,
    summary: r.summary,
    payload: { kind: 'calc', detail: r },
  };
}

/**
 * 메인 entry — intent별 분기
 */
async function execute({ input, intent, sellerId, fastReason }) {
  if (intent === 'invalid') {
    return {
      ok: false,
      ability_level: 4,
      cost_tier: 0,
      summary: fastReason || '명령을 이해하지 못했어요',
      payload: { kind: 'invalid' },
    };
  }
  if (intent === 'abuse') return executeAbuse(input, { sellerId });
  if (intent === 'greeting') return executeGreeting();
  if (intent === 'non_related') return executeNonRelated();
  if (intent === 'weather') return executeWeather();
  if (intent === 'currency') return executeCurrency(input);
  if (intent === 'calendar') return executeCalendar(input);
  if (intent === 'calc') return executeCalc(input);
  // shop (default)
  return executeShop(input, { sellerId });
}

module.exports = { execute };
