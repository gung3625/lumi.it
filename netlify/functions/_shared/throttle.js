// Throttling 큐 — Sprint 2 (메모리 project_data_pipeline_architecture.md B항)
// 마켓별 Rate Limit 모니터링 + 우선순위 큐 + Token Bucket
//
// In-memory 구현 (Netlify Functions 인스턴스 단위). 멀티 인스턴스에서는 Supabase 큐로 확장 필요.
//
// 정책:
// - 쿠팡: Vendor ID당 ≤5 req/s 보수적 (검증된 사실, 사전고지 없이 변경됨)
// - 네이버: 응답 헤더 GNCP-GW-RateLimit-Remaining 실시간 모니터링
// - 우선순위: 🔴 즉시(주문/재고) / 🟡 5분(CS/송장/등록) / 🟢 새벽(가격/통계)

const TOKEN_BUCKETS = new Map(); // key: market:vendorId → { tokens, refillRate, capacity, lastRefill }

const DEFAULTS = {
  coupang: { capacity: 5, refillRate: 5, refillIntervalMs: 1000 },     // 5 req/s
  naver:   { capacity: 10, refillRate: 10, refillIntervalMs: 1000 },   // 동적 조정
  default: { capacity: 5, refillRate: 5, refillIntervalMs: 1000 },
};

/**
 * Token bucket key 생성
 */
function bucketKey(market, vendorId) {
  return `${market}:${vendorId || 'global'}`;
}

/**
 * Bucket 가져오기 (없으면 초기화)
 */
function getBucket(market, vendorId) {
  const key = bucketKey(market, vendorId);
  if (!TOKEN_BUCKETS.has(key)) {
    const cfg = DEFAULTS[market] || DEFAULTS.default;
    TOKEN_BUCKETS.set(key, {
      tokens: cfg.capacity,
      capacity: cfg.capacity,
      refillRate: cfg.refillRate,
      refillIntervalMs: cfg.refillIntervalMs,
      lastRefill: Date.now(),
    });
  }
  return TOKEN_BUCKETS.get(key);
}

/**
 * 시간 경과 → 토큰 채우기
 */
function refill(bucket) {
  const now = Date.now();
  const elapsed = now - bucket.lastRefill;
  if (elapsed >= bucket.refillIntervalMs) {
    const ticks = Math.floor(elapsed / bucket.refillIntervalMs);
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + ticks * bucket.refillRate);
    bucket.lastRefill = now;
  }
}

/**
 * 호출 가능 여부 — 토큰 1개 차감
 * @param {string} market
 * @param {string} [vendorId]
 * @returns {{ allowed: boolean, retryAfterMs?: number, remaining: number }}
 */
function tryAcquire(market, vendorId) {
  const bucket = getBucket(market, vendorId);
  refill(bucket);
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, remaining: bucket.tokens };
  }
  // 다음 리필까지 대기 시간
  const elapsed = Date.now() - bucket.lastRefill;
  const retryAfterMs = Math.max(0, bucket.refillIntervalMs - elapsed);
  return { allowed: false, retryAfterMs, remaining: 0 };
}

/**
 * 응답 헤더 기반 throttle 적응 조정 (네이버용)
 * @param {string} market
 * @param {string} vendorId
 * @param {{ remaining?: string|number, replenishRate?: string|number, burstCapacity?: string|number }} headers
 */
function adaptFromHeaders(market, vendorId, headers) {
  if (!headers) return;
  const bucket = getBucket(market, vendorId);
  const remaining = Number(headers.remaining);
  const replenish = Number(headers.replenishRate);
  const burst = Number(headers.burstCapacity);

  if (Number.isFinite(burst) && burst > 0) bucket.capacity = burst;
  if (Number.isFinite(replenish) && replenish > 0) bucket.refillRate = replenish;
  // Remaining 임계치 (5 미만) → tokens 강제 낮춤
  if (Number.isFinite(remaining) && remaining < 5) {
    bucket.tokens = Math.min(bucket.tokens, remaining);
  }
}

/**
 * 429 수신 시 backoff (즉시 토큰 0으로 + 다음 refill 지연)
 */
function applyBackoff(market, vendorId, backoffMs = 60_000) {
  const bucket = getBucket(market, vendorId);
  bucket.tokens = 0;
  bucket.lastRefill = Date.now() + backoffMs - bucket.refillIntervalMs;
}

/**
 * 우선순위 — 🔴/🟡/🟢
 * 큐 정렬 시 사용 (큰 숫자 = 빠른 처리)
 */
const PRIORITY = {
  immediate: 100,      // 🔴 주문·재고·정산
  fast: 50,            // 🟡 CS·송장·등록
  batch: 10,           // 🟢 가격·통계·일괄
};

function getPriority(taskType) {
  if (['order_received', 'stock_sync', 'settlement'].includes(taskType)) return PRIORITY.immediate;
  if (['register_product', 'send_invoice', 'cs_response'].includes(taskType)) return PRIORITY.fast;
  if (['price_update', 'stat_export'].includes(taskType)) return PRIORITY.batch;
  return PRIORITY.fast;
}

/**
 * 테스트용 — 모든 bucket 리셋
 */
function _reset() {
  TOKEN_BUCKETS.clear();
}

module.exports = {
  tryAcquire,
  adaptFromHeaders,
  applyBackoff,
  getPriority,
  PRIORITY,
  bucketKey,
  _reset,
};
