// openai-quota.js — 셀러별 OpenAI 호출 일일/월간 비용 한도 검증 + 카운트 증가
//
// 베타 보수적 한도 (30명 한정):
//   셀러당 일 ₩1,000 / 월 ₩10,000
//   서비스 전체 일 ₩100,000 (SERVICE_DAILY_LIMIT_KRW 환경변수로 오버라이드 가능)
//
// 모델별 호출당 추정 비용 (토큰 기반 정확 계산 어려우므로 추정값):
//   gpt-5.4              → ₩100
//   gpt-4o               → ₩50  (이미지 분석 포함)
//   gpt-4o-mini          → ₩5
//   text-embedding-3-small → ₩1
//
// DB: openai_quota 테이블 + bump_openai_quota_atomic RPC
// service_role 전용 (RLS anon GRANT 없음)

'use strict';

const { getAdminClient } = require('./supabase-admin');
const { safeAwait } = require('./supa-safe');

// ── 모델별 추정 비용 ──────────────────────────────────────
const MODEL_COST_KRW = {
  'gpt-5.4':                100,
  'gpt-4o':                  50,
  'gpt-4o-mini':              5,
  'text-embedding-3-small':   1,
};

// 한도 상수
const SELLER_DAILY_LIMIT_KRW  =  1_000;   // 셀러당 일 ₩1,000
const SELLER_MONTHLY_LIMIT_KRW = 10_000;  // 셀러당 월 ₩10,000

function getServiceDailyLimit() {
  const v = parseInt(process.env.LUMI_DAILY_OPENAI_BUDGET, 10);
  return isNaN(v) ? 100_000 : v;             // 기본 서비스 전체 일 ₩100,000
}

// ── 날짜 유틸 (KST 기준) ────────────────────────────────
function kstDateString() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);       // YYYY-MM-DD (KST)
}

function kstMonthString() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 7) + '-01'; // YYYY-MM-01 (DATE 컬럼용)
}

// ── 커스텀 에러 ─────────────────────────────────────────
class QuotaExceededError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'QuotaExceededError';
    this.code = 'QUOTA_EXCEEDED';
    this.detail = detail || null;
  }
}

// ── 서비스 전체 일일 한도 체크 ──────────────────────────
// GLOBAL_QUOTA_SELLER_ID = '__service__' 로 단일 행 관리
const SERVICE_SELLER_ID = '__service__';

async function checkServiceDailyQuota(admin, estCostKrw) {
  const serviceLimit = getServiceDailyLimit();
  const today = kstDateString();

  try {
    const { data } = await admin
      .from('openai_quota')
      .select('daily_cost_krw')
      .eq('seller_id', SERVICE_SELLER_ID)
      .eq('daily_date', today)
      .maybeSingle();

    const used = data?.daily_cost_krw || 0;
    if (used + estCostKrw > serviceLimit) {
      return {
        allowed: false,
        reason: `서비스 전체 일일 OpenAI 예산 초과 (사용 ₩${used} / 한도 ₩${serviceLimit})`,
      };
    }
    return { allowed: true };
  } catch (e) {
    // 서비스 한도 조회 실패 → fail-open (셀러 한도는 별도 체크)
    console.warn('[openai-quota] 서비스 전체 한도 조회 실패 (fail-open):', e.message);
    return { allowed: true };
  }
}

// ── 핵심: checkAndIncrementQuota ────────────────────────
/**
 * sellerId 별 일일/월간 OpenAI 비용 한도 검증 + 증가.
 *
 * @param {string}  sellerId   - 셀러 UUID. null/undefined → 서비스 전체 한도만 적용
 * @param {string}  [model='gpt-4o']
 * @param {number}  [estCostKrw]  - 모델 기본값으로 자동 결정됨. 명시 시 오버라이드.
 * @throws {QuotaExceededError}   - 한도 초과
 */
async function checkAndIncrementQuota(sellerId, model = 'gpt-4o', estCostKrw) {
  // 비용 결정
  const cost = (typeof estCostKrw === 'number' && estCostKrw >= 0)
    ? estCostKrw
    : (MODEL_COST_KRW[model] ?? MODEL_COST_KRW['gpt-4o']);

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    // DB 미가용 → fail-closed (비용 폭주 방지)
    console.error('[openai-quota] DB 클라이언트 생성 실패 — fail-closed:', e.message);
    throw new QuotaExceededError(
      '시스템 점검 중이에요. 잠시 후 다시 시도해 주세요.',
      'db_unavailable'
    );
  }

  const today = kstDateString();
  const thisMonth = kstMonthString();

  // 1) 서비스 전체 일일 한도 체크
  const svcCheck = await checkServiceDailyQuota(admin, cost);
  if (!svcCheck.allowed) {
    console.warn(`[openai-quota] 서비스 전체 한도 초과: ${svcCheck.reason}`);
    throw new QuotaExceededError(
      '서비스 전체 일일 AI 예산을 초과했습니다. 내일 다시 시도해 주세요.',
      'service_daily_exceeded'
    );
  }

  // 2) 셀러 한도 체크 (sellerId가 있을 때만)
  if (sellerId) {
    try {
      const { data } = await admin
        .from('openai_quota')
        .select('daily_cost_krw, monthly_cost_krw')
        .eq('seller_id', sellerId)
        .eq('daily_date', today)
        .maybeSingle();

      const dailyUsed   = data?.daily_cost_krw   || 0;
      const monthlyUsed = data?.monthly_cost_krw  || 0;

      if (dailyUsed + cost > SELLER_DAILY_LIMIT_KRW) {
        console.log(
          `[quota] sellerId=${sellerId} model=${model} cost=${cost} daily=${dailyUsed}/${SELLER_DAILY_LIMIT_KRW} → EXCEEDED`
        );
        throw new QuotaExceededError(
          '오늘 AI 사용량을 초과했어요. 내일 다시 시도해 주세요.',
          'seller_daily_exceeded'
        );
      }

      if (monthlyUsed + cost > SELLER_MONTHLY_LIMIT_KRW) {
        console.log(
          `[quota] sellerId=${sellerId} model=${model} cost=${cost} monthly=${monthlyUsed}/${SELLER_MONTHLY_LIMIT_KRW} → EXCEEDED`
        );
        throw new QuotaExceededError(
          '이번 달 AI 사용량을 초과했어요. 다음 달에 다시 시도해 주세요.',
          'seller_monthly_exceeded'
        );
      }

      console.log(
        `[quota] sellerId=${sellerId} model=${model} cost=${cost} daily=${dailyUsed + cost}/${SELLER_DAILY_LIMIT_KRW} monthly=${monthlyUsed + cost}/${SELLER_MONTHLY_LIMIT_KRW}`
      );
    } catch (e) {
      if (e instanceof QuotaExceededError) throw e;
      // DB 조회 실패 → fail-closed
      console.error('[openai-quota] 셀러 한도 조회 실패 — fail-closed:', e.message);
      throw new QuotaExceededError(
        '시스템 오류로 AI 기능을 일시적으로 사용할 수 없어요. 잠시 후 다시 시도해 주세요.',
        'db_error'
      );
    }
  }

  // 3) 카운트 증가 (atomic RPC 시도 → 실패 시 fallback upsert)
  await bumpQuota(admin, sellerId, today, thisMonth, cost);

  // 4) 서비스 전체 카운터도 증가
  await bumpQuota(admin, SERVICE_SELLER_ID, today, thisMonth, cost);
}

// ── Atomic 증가 ─────────────────────────────────────────
async function bumpQuota(admin, sellerId, today, thisMonth, cost) {
  if (!sellerId) return;

  // RPC atomic 시도 (PostgrestBuilder 는 .catch 가 없어 직접 체이닝 금지 → safeAwait)
  const { error: rpcErr } = await safeAwait(admin.rpc('bump_openai_quota_atomic', {
    p_seller_id: sellerId,
    p_daily_date: today,
    p_month_date: thisMonth,
    p_cost_krw: cost,
  }));

  if (!rpcErr) return;

  // RPC 미배포 fallback — SELECT-then-UPSERT (race 가능하지만 beta 수준에서 허용)
  try {
    const { data: row } = await admin
      .from('openai_quota')
      .select('daily_count, daily_cost_krw, monthly_count, monthly_cost_krw')
      .eq('seller_id', sellerId)
      .eq('daily_date', today)
      .maybeSingle();

    await admin.from('openai_quota').upsert({
      seller_id:          sellerId,
      daily_date:         today,
      month_date:         thisMonth,
      daily_count:        (row?.daily_count    || 0) + 1,
      daily_cost_krw:     (row?.daily_cost_krw || 0) + cost,
      monthly_count:      (row?.monthly_count  || 0) + 1,
      monthly_cost_krw:   (row?.monthly_cost_krw || 0) + cost,
      updated_at:         new Date().toISOString(),
    }, { onConflict: 'seller_id,daily_date' });
  } catch (e) {
    // best-effort — 증가 실패해도 호출은 허용 (카운터 실패로 서비스 중단 방지)
    console.warn('[openai-quota] 카운터 증가 실패 (best-effort):', e.message);
  }
}

// ── 서비스 전체 일일 예산 잔액 조회 (모니터링용) ────────
async function getServiceDailyUsage() {
  try {
    const admin = getAdminClient();
    const today = kstDateString();
    const { data } = await admin
      .from('openai_quota')
      .select('daily_cost_krw, daily_count')
      .eq('seller_id', SERVICE_SELLER_ID)
      .eq('daily_date', today)
      .maybeSingle();
    return {
      used: data?.daily_cost_krw || 0,
      count: data?.daily_count || 0,
      limit: getServiceDailyLimit(),
    };
  } catch (e) {
    return { used: 0, count: 0, limit: getServiceDailyLimit(), error: e.message };
  }
}

module.exports = {
  checkAndIncrementQuota,
  QuotaExceededError,
  MODEL_COST_KRW,
  SELLER_DAILY_LIMIT_KRW,
  SELLER_MONTHLY_LIMIT_KRW,
  getServiceDailyUsage,
};
