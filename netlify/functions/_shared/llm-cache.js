// llm-cache.js — Tier별 응답 캐싱 (80% 절감 목표)
// 메모리 project_agent_architecture_0428.md
//
// 캐싱 대상별 TTL:
//   카테고리 매핑 (input → category): 30일
//   상품명·태그 (category → suggestion): 30일
//   트렌드 24h (모든 셀러 공유): 24시간
//   환율: 6시간
//   공휴일: 30일
//   FAQ: 30일
//   분류 (mini): 7일

const crypto = require('crypto');
const { getAdminClient } = require('./supabase-admin');

const TTL_HOURS = {
  classifier: 7 * 24,
  weather: 1,
  currency: 6,
  holiday: 30 * 24,
  trend: 24,
  category_mapping: 30 * 24,
  product_suggestion: 30 * 24,
  faq: 30 * 24,
  default: 1,
};

function makeCacheKey({ kind, input, contextHash, tier }) {
  const norm = String(input || '').toLowerCase().trim().replace(/\s+/g, ' ');
  const raw = `${kind || 'default'}:${tier || 0}:${norm}:${contextHash || ''}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 48);
}

/**
 * 캐시 조회 — 만료 안 됐으면 결과 반환
 */
async function getCached(key) {
  if (!key) return null;
  let admin;
  try { admin = getAdminClient(); } catch (_) { return null; }

  try {
    const { data, error } = await admin
      .from('llm_cache')
      .select('result_json, expires_at')
      .eq('cache_key', key)
      .maybeSingle();

    if (error || !data) return null;
    if (new Date(data.expires_at).getTime() < Date.now()) return null;

    // hit_count 증가 로직 제거 (2026-05-15 코드 리뷰).
    //   - 어디서도 READ 안 하는 dead column → 매 cache hit 마다 dead DB write.
    //   - 기존 fire-and-forget `.then(...).catch(...)` 패턴은 Netlify Function
    //     종료 시 race condition 위험까지 동반했음.
    //   - 향후 캐시 통계가 필요해지면 별도 collection 설계 (예: hot key sampling).
    //   - DB column 자체는 남겨둠 (migration 회피, setCached 의 INSERT 초기값=0 유지).
    return data.result_json;
  } catch (_) {
    return null;
  }
}

/**
 * 캐시 저장
 */
async function setCached(key, result, { kind = 'default', tier = 0 } = {}) {
  if (!key || !result) return;
  // 빈 객체·빈 배열·문자열만 들어온 응답은 캐싱 금지 (다음 요청 시 재시도하도록)
  if (typeof result === 'object' && Object.keys(result).length === 0) return;
  let admin;
  try { admin = getAdminClient(); } catch (_) { return; }

  const hours = TTL_HOURS[kind] ?? TTL_HOURS.default;
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  try {
    await admin
      .from('llm_cache')
      .upsert({
        cache_key: key,
        tier,
        result_json: result,
        expires_at: expiresAt,
        hit_count: 0,
      }, { onConflict: 'cache_key' });
  } catch (_) {
    // silent
  }
}

module.exports = { makeCacheKey, getCached, setCached, TTL_HOURS };
