// 유예기간 만료 회원 영구 삭제 cron (유예 7일 — account-delete.js GRACE_DAYS)
// schedule: 0 18 * * *  (UTC 18:00 = KST 03:00)
// 동작:
//   1) deletion_scheduled_at <= now() AND deletion_cancelled_at IS NULL 인 row 조회
//   2) 각 row 별로 cascade DELETE:
//      a) ig_accounts / tiktok_accounts / reservations (seller_id 기준)
//      b) sellers row 의 email 매핑된 auth.users 삭제 (admin.auth.admin.deleteUser)
//      c) sellers row DELETE
//   3) 한 row 실패해도 다음 row 계속, 마지막에 성공/실패 카운트 로그
//
// 알림 이메일은 발송하지 않음 (UI 배너로 대체).
// 외부 임의 HTTP 트리거는 allowScheduledOrSecret 게이트로 차단 (2026-06-10 — 다른 cron 과 통일).

const { getAdminClient } = require('./_shared/supabase-admin');
const { allowScheduledOrSecret } = require('./_shared/auth');
const { runGuarded } = require('./_shared/cron-guard');

const PROCESS_LIMIT = 100;

async function deleteSellerCascade(admin, seller) {
  // ig_accounts, tiktok_accounts, reservations 는 seller_id 컬럼을 가진다 (다른 함수 패턴 일치)
  // 일부 테이블은 존재하지 않을 수 있으므로 각 호출 try/catch
  const tables = ['ig_accounts', 'tiktok_accounts', 'reservations'];
  for (const t of tables) {
    try {
      const { error } = await admin.from(t).delete().eq('seller_id', seller.id);
      if (error) console.warn(`[process-account-deletion] ${t} delete 경고 seller=${seller.id.slice(0, 8)}:`, error.message);
    } catch (e) {
      console.warn(`[process-account-deletion] ${t} delete 예외 seller=${seller.id.slice(0, 8)}:`, e.message);
    }
  }

  // auth.users 삭제 — sellers.id = auth.users.id 불변식(handle_auth_user_sync 트리거)으로 직접 삭제.
  // (이전: email 로 listUsers 첫 200명만 대조 → 200명 초과 시 못 찾아 auth.users 가 고아로 남음 = GDPR 위반.
  //  seller.id 가 곧 auth user id 이므로 페이징/이메일 대조 불필요.)
  try {
    const { error } = await admin.auth.admin.deleteUser(seller.id);
    if (error) console.warn(`[process-account-deletion] auth.users delete 경고 ${seller.id.slice(0, 8)}:`, error.message);
  } catch (e) {
    console.warn(`[process-account-deletion] auth.users delete 예외 ${seller.id.slice(0, 8)}:`, e.message);
  }

  // 마지막으로 sellers row 삭제
  const { error: delErr } = await admin.from('sellers').delete().eq('id', seller.id);
  if (delErr) {
    throw new Error(`sellers delete 실패: ${delErr.message}`);
  }
}

const processDeletionHandler = async (event) => {
  // Netlify scheduled background: event 객체가 거의 비어있음
  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[process-account-deletion] admin client 초기화 실패:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: '서버 설정 오류' }) };
  }

  const nowIso = new Date().toISOString();

  // 만족 후보 조회 (sellers 에 user_id 컬럼이 없어도 안전 — email 기반 auth 매핑)
  const { data: rows, error: selErr } = await admin
    .from('sellers')
    .select('id, owner_name, email, deletion_scheduled_at')
    .lte('deletion_scheduled_at', nowIso)
    .not('deletion_requested_at', 'is', null)
    .is('deletion_cancelled_at', null)
    .limit(PROCESS_LIMIT);

  if (selErr) {
    console.error('[process-account-deletion] select 실패:', selErr.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'select 실패' }) };
  }

  const list = rows || [];
  console.log(`[process-account-deletion] 처리 대상 ${list.length}건 (now=${nowIso})`);

  let success = 0;
  let failed = 0;

  for (const seller of list) {
    try {
      await deleteSellerCascade(admin, seller);
      success += 1;
      console.log(`[process-account-deletion] seller=${seller.id.slice(0, 8)} 영구 삭제 완료`);
    } catch (e) {
      failed += 1;
      console.error(`[process-account-deletion] seller=${seller.id.slice(0, 8)} 실패:`, e.message);
      // 다음 row 계속
    }
  }

  console.log(`[process-account-deletion] 완료 success=${success} failed=${failed}`);
  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, processed: list.length, ok: success, failed }),
  };
};

// cron-guard heartbeat — cron-watchdog 감시용. 게이트는 가드 밖 (외부 poke 의 heartbeat 갱신 차단).
const guarded = runGuarded({ name: 'process-account-deletion', handler: processDeletionHandler });
exports.handler = async (event, context) => {
  // 외부 임의 HTTP 트리거 차단 (네이티브 cron 또는 LUMI_SECRET 만 허용) — 멱등이지만 DB 부하 남용 방지.
  if (!allowScheduledOrSecret(event)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'unauthorized' }) };
  }
  return guarded(event, context);
};
