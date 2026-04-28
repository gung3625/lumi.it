// llm-router.js — Tier 0~3 단일 진입점
// 메모리 project_agent_architecture_0428.md
//
// Tier 0: Shell (₩0)         — 정규식·하드코드·계산기·외부 API
// Tier 1: gpt-4o-mini (₩2)   — 분류·간단 응답·요약
// Tier 2: gpt-4o (₩50)       — 명령 실행 JSON 생성
// Tier 3: gpt-4o vision (₩100) — 사진 등록 풀 워크플로우
//
// 모든 Tier 호출은 reserve(rate-limit) + getCached/setCached(llm-cache) 통과
// sellerId 누락 = 익명 호출 = 즉시 차단 (Tier 1/2 비용 보호)

const { reserve } = require('./rate-limit');
const { makeCacheKey, getCached, setCached } = require('./llm-cache');

const TIER_NAMES = {
  0: 'shell',
  1: 'tier1_mini',
  2: 'tier2_4o',
  3: 'tier3_vision',
};

/**
 * Tier 1 - mini 호출 (JSON mode 권장)
 */
async function callMini({ system, user, max_tokens = 200, sellerId, cacheKind = 'classifier' }) {
  // Rate limit 필수 — sellerId 없으면 익명 호출이므로 즉시 차단
  if (!sellerId) {
    return { ok: false, error: '인증이 필요해요', rateLimited: true };
  }
  const ok = await reserve(sellerId, 'tier1_mini');
  if (!ok.allowed) {
    return { ok: false, error: ok.reason, rateLimited: true };
  }

  // Cache
  const cacheKey = makeCacheKey({
    kind: cacheKind,
    input: `${system}|${user}`,
    tier: 1,
  });
  const cached = await getCached(cacheKey);
  if (cached) return { ok: true, result: cached, cached: true };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: 'OPENAI_API_KEY 미설정' };

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        max_tokens,
        temperature: 0.1,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) return { ok: false, error: `mini ${res.status}` };
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = { text: raw }; }
    await setCached(cacheKey, parsed, { kind: cacheKind, tier: 1 });
    return { ok: true, result: parsed };
  } catch (e) {
    return { ok: false, error: 'network_error' };
  }
}

/**
 * Tier 2 - 4o 호출 (명령 → JSON 액션)
 */
async function call4o({ system, user, max_tokens = 600, sellerId, cacheKind = 'shop_command' }) {
  // Rate limit 필수 — sellerId 없으면 익명 호출이므로 즉시 차단
  if (!sellerId) {
    return { ok: false, error: '인증이 필요해요', rateLimited: true };
  }
  const ok = await reserve(sellerId, 'tier2_4o');
  if (!ok.allowed) {
    return { ok: false, error: ok.reason, rateLimited: true };
  }

  // 명령 처리는 셀러 컨텍스트가 매번 다르므로 보수적 캐싱 (사용자별 input 정규화로만)
  const cacheKey = makeCacheKey({
    kind: cacheKind,
    input: `${system}|${user}`,
    contextHash: sellerId,
    tier: 2,
  });
  const cached = await getCached(cacheKey);
  if (cached) return { ok: true, result: cached, cached: true };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: 'OPENAI_API_KEY 미설정' };

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        response_format: { type: 'json_object' },
        max_tokens,
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) return { ok: false, error: `4o ${res.status}` };
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = { text: raw }; }
    await setCached(cacheKey, parsed, { kind: cacheKind, tier: 2 });
    return { ok: true, result: parsed };
  } catch (e) {
    return { ok: false, error: 'network_error' };
  }
}

module.exports = { callMini, call4o, TIER_NAMES };
