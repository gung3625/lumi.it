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
// 주의: 외부 트리거 (Netlify scheduled background) — LUMI_SECRET 검증 불필요.

const { getAdminClient } = require('./_shared/supabase-admin');

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

  // auth.users 삭제 — email 매핑으로 식별 (sellers 에 user_id 컬럼 없음 가정)
  let authUserId = null;
  if (seller.email) {
    try {
      // listUsers 는 admin API 의 페이징이 1000 default. 단순 대조용 — 실제 운영시 emaill 직접 매핑 권장.
      const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      const found = (list && list.users || []).find(u => (u.email || '').toLowerCase() === String(seller.email).toLowerCase());
      if (found) authUserId = found.id;
    } catch (e) {
      console.warn(`[process-account-deletion] auth listUsers 실패 seller=${seller.id.slice(0, 8)}:`, e.message);
    }
  }
  if (authUserId) {
    try {
      const { error } = await admin.auth.admin.deleteUser(authUserId);
      if (error) console.warn(`[process-account-deletion] auth.users delete 경고 ${authUserId}:`, error.message);
    } catch (e) {
      console.warn(`[process-account-deletion] auth.users delete 예외 ${authUserId}:`, e.message);
    }
  }

  // 마지막으로 sellers row 삭제
  const { error: delErr } = await admin.from('sellers').delete().eq('id', seller.id);
  if (delErr) {
    throw new Error(`sellers delete 실패: ${delErr.message}`);
  }
}

exports.handler = async (event) => {
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
