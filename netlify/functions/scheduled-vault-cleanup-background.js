// netlify/functions/scheduled-vault-cleanup-background.js
// Vault orphan secret 청소 — 주 1회 cron.
//
// 의도:
//   disconnect-ig / disconnect-threads 가 즉시 delete_vault_secret 으로
//   정리하지만 best-effort 라 실패 가능. 또 사장님 탈퇴(CASCADE) 시
//   vault.secrets 는 cascade 안 됨. 누적 orphan 차단용 안전망.
//
//   호출은 cleanup_orphan_vault_secrets() RPC 1회. 함수 내부에서 lumi
//   명명규약 secret 중 ig_accounts/tiktok_accounts 어디에도 참조 안 된
//   row 만 삭제 후 삭제 건수 반환.
//
// 스케줄: 매주 일요일 UTC 19:00 = 월요일 KST 04:00 (netlify.toml).
// 멱등: 호출마다 현재 시점 orphan 만 삭제 → 동시 실행도 안전.

const { getAdminClient } = require('./_shared/supabase-admin');

exports.handler = async () => {
  const supabase = getAdminClient();
  try {
    const { data, error } = await supabase.rpc('cleanup_orphan_vault_secrets');
    if (error) {
      console.error('[vault-cleanup] RPC 실패:', error.message);
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: error.message }) };
    }
    const deleted = typeof data === 'number' ? data : 0;
    console.log(`[vault-cleanup] deleted=${deleted}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, deleted }) };
  } catch (e) {
    console.error('[vault-cleanup] 예외:', e && e.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e && e.message }) };
  }
};
