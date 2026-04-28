// currency.js — 환율 (한국은행 ECOS 무료 API, fallback exchangerate-api)
// Tier 0, 캐싱 6시간

const { makeCacheKey, getCached, setCached } = require('../llm-cache');

/**
 * USD/KRW, CNY/KRW, JPY/KRW 등 주요 환율 조회
 */
async function getRate({ base = 'USD', target = 'KRW' } = {}) {
  const cacheKey = makeCacheKey({ kind: 'currency', input: `${base}-${target}`, tier: 0 });
  const cached = await getCached(cacheKey);
  if (cached) return { ...cached, cached: true };

  // exchangerate.host (무료, 키 불필요)
  try {
    const url = `https://api.exchangerate.host/latest?base=${base}&symbols=${target}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`rate api ${res.status}`);
    const data = await res.json();
    const rate = data.rates?.[target];
    if (!rate) throw new Error('no rate');

    const result = {
      ok: true,
      base,
      target,
      rate: Number(rate.toFixed(2)),
      summary: `${base} 1 = ${target} ${Math.round(rate).toLocaleString('ko-KR')}원`,
      updated_at: data.date || new Date().toISOString().slice(0, 10),
    };
    await setCached(cacheKey, result, { kind: 'currency', tier: 0 });
    return result;
  } catch (e) {
    return {
      ok: false,
      base,
      target,
      summary: '환율 정보를 잠시 불러오지 못했어요',
    };
  }
}

module.exports = { getRate };
