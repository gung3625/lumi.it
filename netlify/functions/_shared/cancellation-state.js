// Sprint 3.6 — 30일 해지 유예 상태머신
// 메모리: project_phase1_decisions_0426 (해지·보관 정책 — 30일 유예 + 자동 파기)
//
// 상태:
//   ACTIVE              : cancellation_requested_at IS NULL
//   GRACE_PERIOD        : requested_at 있음 & grace_until > NOW() & completed_at IS NULL
//   AUTO_DESTROY_PENDING: grace_until <= NOW() & completed_at IS NULL  → cron이 처리
//   COMPLETED           : completed_at IS NOT NULL
//   RESTORED            : restored_at IS NOT NULL & requested_at IS NULL (clear 됨)

const GRACE_DAYS = 30;
const WARN_DAYS_BEFORE = 7;

/**
 * cancellation_grace_until 계산
 */
function computeGraceUntil(requestedAt) {
  const t = requestedAt instanceof Date ? requestedAt : new Date(requestedAt);
  if (Number.isNaN(t.getTime())) return null;
  const out = new Date(t.getTime());
  out.setUTCDate(out.getUTCDate() + GRACE_DAYS);
  return out;
}

/**
 * 셀러 row → 상태 라벨
 */
function getState(seller, now = new Date()) {
  if (!seller) return 'UNKNOWN';
  if (seller.cancellation_completed_at) return 'COMPLETED';
  if (!seller.cancellation_requested_at) return 'ACTIVE';

  const grace = seller.cancellation_grace_until
    ? new Date(seller.cancellation_grace_until)
    : computeGraceUntil(seller.cancellation_requested_at);

  if (!grace) return 'ACTIVE';
  if (grace.getTime() <= now.getTime()) return 'AUTO_DESTROY_PENDING';
  return 'GRACE_PERIOD';
}

/**
 * 만료 1주일 전 알림 발송 대상인지
 */
function shouldWarn(seller, now = new Date()) {
  if (!seller || !seller.cancellation_grace_until) return false;
  if (seller.cancellation_warned_at) return false;
  if (seller.cancellation_completed_at || seller.cancellation_restored_at) return false;
  const grace = new Date(seller.cancellation_grace_until);
  const warnAt = new Date(grace.getTime() - WARN_DAYS_BEFORE * 24 * 60 * 60 * 1000);
  return now.getTime() >= warnAt.getTime() && now.getTime() < grace.getTime();
}

/**
 * 자동 파기 대상인지
 */
function shouldAutoDestroy(seller, now = new Date()) {
  return getState(seller, now) === 'AUTO_DESTROY_PENDING';
}

/**
 * 유예 시뮬레이션 — 테스트용
 *   simulate(requestedAt, daysElapsed, [overrides]) → seller-like row
 */
function simulate(requestedAt, daysElapsed = 0, overrides = {}) {
  const requested = new Date(requestedAt);
  const now = new Date(requested.getTime() + daysElapsed * 24 * 60 * 60 * 1000);
  const seller = {
    cancellation_requested_at: requested.toISOString(),
    cancellation_grace_until: computeGraceUntil(requested).toISOString(),
    cancellation_completed_at: null,
    cancellation_restored_at: null,
    cancellation_warned_at: null,
    ...overrides,
  };
  return { seller, now };
}

module.exports = {
  GRACE_DAYS,
  WARN_DAYS_BEFORE,
  computeGraceUntil,
  getState,
  shouldWarn,
  shouldAutoDestroy,
  simulate,
};
