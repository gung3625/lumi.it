// rate-limit.js — Tier별 일일 호출 한도 (최악 시나리오 방어)
// 메모리 project_agent_architecture_0428.md
//
// 한도 = 베타 ₩29,000 손익 보호
//   tier3_vision (사진 등록 GPT-4o Vision): daily 30, monthly 100
//   tier2_4o (4o JSON 명령 생성): daily 30
//   tier1_mini (분류·간단 응답): daily 200
//   total (전체 합산): daily 300

const { getAdminClient } = require('./supabase-admin');

const LIMITS = {
  tier3_vision: { daily: 30, monthly: 100 },
  tier2_4o: { daily: 30 },
  tier1_mini: { daily: 200 },
  total: { daily: 300 },
};

function todayDateString() {
  const d = new Date();
  // KST 기준 일자 (Asia/Seoul = UTC+9)
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

/**
 * Tier 한도 조회
 * @param {string} sellerId
 * @param {string} tierKey - 'tier1_mini' / 'tier2_4o' / 'tier3_vision' / 'total'
 * @returns {Promise<{ allowed: boolean, used: number, limit: number, reason?: string }>}
 */
async function checkLimit(sellerId, tierKey) {
  const limit = LIMITS[tierKey];
  if (!limit) return { allowed: true, used: 0, limit: 999999 };
  if (!sellerId) return { allowed: false, used: 0, limit: limit.daily, reason: '인증 필요' };

  let admin;
  try { admin = getAdminClient(); } catch (_) {
    // H3 — DB 미가용 시 fail-closed (LLM 비용 폭주 방지)
    console.error('[rate-limit] DB unavailable — fail-closed for cost protection');
    return { allowed: false, used: 0, limit: limit.daily, reason: '시스템 점검 중이에요. 잠시 후 다시 시도해 주세요.' };
  }

  try {
    const { data } = await admin
      .from('rate_limit_counters')
      .select('call_count')
      .eq('seller_id', sellerId)
      .eq('tier_key', tierKey)
      .eq('bucket_date', todayDateString())
      .maybeSingle();

    const used = data?.call_count || 0;
    if (used >= limit.daily) {
      return {
        allowed: false,
        used,
        limit: limit.daily,
        reason: `오늘 ${tierKey} 한도(${limit.daily}회)를 모두 사용했어요. 내일 다시 시도해 주세요.`,
      };
    }
    return { allowed: true, used, limit: limit.daily };
  } catch (_) {
    return { allowed: true, used: 0, limit: limit.daily };
  }
}

/**
 * Tier 한도 차감 (호출 후 카운터 +1)
 * Race-safe: bump_rate_limit_atomic RPC 사용 (INSERT ... ON CONFLICT DO UPDATE)
 * RPC 미배포 시 SELECT-then-UPDATE fallback (legacy)
 */
async function bumpLimit(sellerId, tierKey) {
  if (!sellerId || !tierKey) return;
  let admin;
  try { admin = getAdminClient(); } catch (_) { return; }

  const today = todayDateString();
  try {
    const { error: rpcErr } = await admin.rpc('bump_rate_limit_atomic', {
      p_seller_id: sellerId,
      p_tier_key: tierKey,
      p_bucket_date: today,
    });
    if (!rpcErr) return;
    // RPC 미배포(404)·권한 오류 → fallback (best-effort, race 가능)
    const { data: existing } = await admin
      .from('rate_limit_counters')
      .select('id, call_count')
      .eq('seller_id', sellerId)
      .eq('tier_key', tierKey)
      .eq('bucket_date', today)
      .maybeSingle();
    if (existing) {
      await admin
        .from('rate_limit_counters')
        .update({ call_count: existing.call_count + 1, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
    } else {
      await admin
        .from('rate_limit_counters')
        .insert({
          seller_id: sellerId,
          tier_key: tierKey,
          bucket_date: today,
          call_count: 1,
        });
    }
  } catch (_) {
    // silent
  }
}

/**
 * 통합: Tier 체크 + 차감 (allowed = true일 때만 bump)
 * total + tier 두 카운터 동시 체크
 */
async function reserve(sellerId, tierKey) {
  // total 먼저 체크
  const totalCheck = await checkLimit(sellerId, 'total');
  if (!totalCheck.allowed) {
    return { allowed: false, reason: totalCheck.reason };
  }

  const tierCheck = await checkLimit(sellerId, tierKey);
  if (!tierCheck.allowed) {
    return { allowed: false, reason: tierCheck.reason };
  }

  await Promise.all([
    bumpLimit(sellerId, 'total'),
    bumpLimit(sellerId, tierKey),
  ]);

  return { allowed: true };
}

module.exports = { checkLimit, bumpLimit, reserve, LIMITS };
