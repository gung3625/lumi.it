// currency.js — 환율 조회 (M8 hotfix)
// 1차: 한국은행 ECOS API (PUBLIC_DATA_API_KEY 재사용, 무료)
// 2차: exchangerate.host fallback
// 캐싱: 6시간 (llm-cache)
// Tier 0

const { makeCacheKey, getCached, setCached } = require('../llm-cache');

// 한국은행 ECOS 환율 통계 코드 매핑
// https://ecos.bok.or.kr/api/ — 외환/기준환율 (통계표: 731Y001)
const ECOS_ITEM_CODE = {
  'USD-KRW': '0000001',  // 미달러
  'EUR-KRW': '0000002',  // 유로
  'JPY-KRW': '0000003',  // 일본 엔(100엔)
  'CNY-KRW': '0000053',  // 중국 위안
  'GBP-KRW': '0000006',  // 영국 파운드
};

async function getRateFromECOS(base, target) {
  const serviceKey = process.env.PUBLIC_DATA_API_KEY;
  if (!serviceKey) throw new Error('no_ecos_key');

  const itemCode = ECOS_ITEM_CODE[`${base}-${target}`];
  if (!itemCode) throw new Error(`unsupported_pair:${base}-${target}`);

  // ECOS 기준환율 일별 최근 1건
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  const url = `https://ecos.bok.or.kr/api/StatisticSearch/${serviceKey}/json/kr/1/5/731Y001/D/${weekAgo}/${today}/${itemCode}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`ecos_http:${res.status}`);
  const data = await res.json();

  const rows = data?.StatisticSearch?.row;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('ecos_no_data');

  // 가장 최근 날짜 기준
  const latest = rows[rows.length - 1];
  const rawRate = parseFloat(latest.DATA_VALUE);
  if (!rawRate || isNaN(rawRate)) throw new Error('ecos_invalid_rate');

  // JPY는 100엔 기준이므로 /100
  const rate = base === 'JPY' ? rawRate / 100 : rawRate;
  return {
    ok: true,
    base,
    target,
    rate: Number(rate.toFixed(2)),
    summary: `${base} 1 = ₩${Math.round(rate).toLocaleString('ko-KR')} (한국은행 기준)`,
    updated_at: latest.TIME ? `${latest.TIME.slice(0, 4)}-${latest.TIME.slice(4, 6)}-${latest.TIME.slice(6, 8)}` : new Date().toISOString().slice(0, 10),
    source: 'ecos',
  };
}

async function getRateFromExchangerate(base, target) {
  const url = `https://api.exchangerate.host/latest?base=${base}&symbols=${target}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`exchangerate_http:${res.status}`);
  const data = await res.json();
  const rate = data.rates?.[target];
  if (!rate) throw new Error('exchangerate_no_rate');
  return {
    ok: true,
    base,
    target,
    rate: Number(Number(rate).toFixed(2)),
    summary: `${base} 1 = ₩${Math.round(rate).toLocaleString('ko-KR')}`,
    updated_at: data.date || new Date().toISOString().slice(0, 10),
    source: 'exchangerate.host',
  };
}

/**
 * USD/KRW, CNY/KRW, JPY/KRW 등 주요 환율 조회
 * M8: 한국은행 ECOS 1차 → exchangerate.host 2차 fallback, 캐싱 6시간
 */
async function getRate({ base = 'USD', target = 'KRW' } = {}) {
  const cacheKey = makeCacheKey({ kind: 'currency', input: `${base}-${target}`, tier: 0 });
  const cached = await getCached(cacheKey);
  if (cached) return { ...cached, cached: true };

  // 1차: 한국은행 ECOS
  try {
    const result = await getRateFromECOS(base, target);
    await setCached(cacheKey, result, { kind: 'currency', tier: 0 });
    return result;
  } catch (_ecosErr) {
    // 2차: exchangerate.host fallback
    try {
      const result = await getRateFromExchangerate(base, target);
      await setCached(cacheKey, result, { kind: 'currency', tier: 0 });
      return result;
    } catch (_fbErr) {
      return {
        ok: false,
        base,
        target,
        summary: '환율 정보를 잠시 불러오지 못했어요. 잠시 후 다시 시도해 주세요',
      };
    }
  }
}

module.exports = { getRate };
