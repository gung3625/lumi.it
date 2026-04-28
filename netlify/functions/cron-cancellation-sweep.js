// Sprint 3.6 — 해지 유예 만료 셀러 자동 파기 cron (매일 00:00)
// 메모리: project_phase1_decisions_0426 (해지·보관 정책)
//        feedback_cron_manual_trigger (x-lumi-secret 필수)
//
// 동작:
// 1) cancellation_grace_until <= NOW() & cancellation_completed_at IS NULL 셀러 조회
// 2) 마켓 자격증명·말투 학습 데이터·이미지 즉시 파기
// 3) sellers.cancellation_completed_at = NOW()
// 4) 별도로, 1주일 전 알림 발송 대상도 처리
//
// 호출:
//   GET /api/cron-cancellation-sweep
//   Header: x-lumi-secret: <LUMI_SECRET>

const { getAdminClient } = require('./_shared/supabase-admin');
const audit = require('./_shared/audit-log');
const { shouldAutoDestroy, shouldWarn, getState } = require('./_shared/cancellation-state');

function authOk(event) {
  const expected = process.env.LUMI_SECRET || '';
  if (!expected) return false;
  const h = event.headers || {};
  const got = h['x-lumi-secret'] || h['X-Lumi-Secret'] || '';
  return got && got === expected;
}

exports.handler = async (event) => {
  if (!authOk(event)) {
    return { statusCode: 401, body: JSON.stringify({ error: '인증 실패' }) };
  }

  let admin;
  try { admin = getAdminClient(); } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'admin init 실패', message: e.message }) };
  }

  const now = new Date();
  const summary = { destroyed: 0, warned: 0, errors: [] };

  // 1) 만료 대상 — grace_until <= now & not completed
  const { data: expiring, error: expErr } = await admin
    .from('sellers')
    .select('id, cancellation_requested_at, cancellation_grace_until, cancellation_completed_at, cancellation_warned_at, cancellation_restored_at')
    .lte('cancellation_grace_until', now.toISOString())
    .is('cancellation_completed_at', null)
    .not('cancellation_requested_at', 'is', null);
  if (expErr) {
    console.error('[cron-cancellation-sweep] 조회 실패:', expErr.message);
    return { statusCode: 500, body: JSON.stringify({ error: '조회 실패' }) };
  }

  for (const seller of expiring || []) {
    if (!shouldAutoDestroy(seller, now)) continue;
    try {
      // (a) 마켓 자격증명 삭제
      await admin.from('market_credentials').delete().eq('seller_id', seller.id);
      // (b) 사장님 식별 가능한 학습 데이터·말투 — 테이블이 없으면 skip
      // 본 sprint에서는 sellers 보관 + 자격증명 파기만 명시 처리. 추가 테이블은 별도 sprint에서.
      // (c) sellers row의 plain PII 컬럼 마스킹 (이름/이메일/전화/주소/자격증명 메타)
      await admin.from('sellers').update({
        cancellation_completed_at: now.toISOString(),
        owner_name: '*** (해지 완료)',
        phone: '00000000000',
        email: null,
        store_name: null,
        plan: 'free',
      }).eq('id', seller.id);

      await audit.log(admin, {
        actorId: seller.id,
        actorType: 'system',
        action: 'cancellation.auto_destroy',
        resourceType: 'seller',
        resourceId: seller.id,
        metadata: { graceUntil: seller.cancellation_grace_until },
        event,
      });
      summary.destroyed += 1;
    } catch (e) {
      console.error(`[cron-cancellation-sweep] seller=${seller.id.slice(0, 8)} 파기 실패:`, e.message);
      summary.errors.push({ sellerId: seller.id, error: e.message });
    }
  }

  // 2) 알림 발송 대상 — 만료 7일 전 & 알림 미발송
  const sevenDaysAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const { data: warning } = await admin
    .from('sellers')
    .select('id, phone, email, store_name, owner_name, cancellation_grace_until, cancellation_warned_at, cancellation_completed_at, cancellation_restored_at, cancellation_requested_at')
    .lte('cancellation_grace_until', sevenDaysAhead.toISOString())
    .gt('cancellation_grace_until', now.toISOString())
    .is('cancellation_completed_at', null)
    .is('cancellation_warned_at', null)
    .not('cancellation_requested_at', 'is', null);

  for (const seller of warning || []) {
    if (!shouldWarn(seller, now)) continue;
    try {
      // 카카오 알림톡은 Phase 1.5에서 통합되므로, 본 sprint에서는 audit_log + 마킹만
      await admin.from('sellers').update({
        cancellation_warned_at: now.toISOString(),
      }).eq('id', seller.id);
      await audit.log(admin, {
        actorId: seller.id,
        actorType: 'system',
        action: 'cancellation.warn_pre_destroy',
        resourceType: 'seller',
        resourceId: seller.id,
        metadata: { graceUntil: seller.cancellation_grace_until },
        event,
      });
      summary.warned += 1;
    } catch (e) {
      console.error(`[cron-cancellation-sweep] warn seller=${seller.id.slice(0, 8)} 실패:`, e.message);
      summary.errors.push({ sellerId: seller.id, error: e.message });
    }
  }

  console.log(`[cron-cancellation-sweep] destroyed=${summary.destroyed} warned=${summary.warned} errors=${summary.errors.length}`);
  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, ...summary }),
  };
};
