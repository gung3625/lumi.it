// netlify/functions/ig-backfill-history-background.js
// IG 연동 직후 1회 호출되는 백필 함수 (Background — 길어도 OK).
//
// 목적:
//   사장님이 가입 전 직접 IG 에 올린 게시물의 시각 데이터를
//   seller_post_history 에 채워 베스트 시간 개인화의 즉시 효과 확보.
//
// 호출:
//   POST /.netlify/functions/ig-backfill-history-background
//   Authorization: Bearer ${LUMI_SECRET}
//   Body: { user_id: '<uuid>' }
//
//   ig-oauth.js 콜백이 연동 성공 직후 fire-and-forget 으로 트리거.
//   재호출 안전 (ON CONFLICT DO NOTHING — 기존 row 보존).
//
// 안전장치:
//   - 페이지네이션 최대 10페이지 (≈ 1000건)
//   - 페이지당 timeoutMs 10초
//   - 부분 실패 시 지금까지 받은 분만 insert, 나머지 다음 호출에서 재시도 가능
//   - source='pre-lumi' 로 모두 insert. Lumi 게시(source='lumi') 와 ig_media_id 충돌 시 PK 충돌 → ON CONFLICT DO NOTHING 으로 lumi row 보존.

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyLumiSecret } = require('./_shared/auth');
const { getIgTokenForSeller, igGraphRequest, IgGraphError } = require('./_shared/ig-graph');

const MAX_PAGES = 10;
const PAGE_LIMIT = 100;

exports.handler = async (event) => {
  // 내부 호출 인증
  const authHeader = (event.headers['authorization'] || event.headers['Authorization'] || '');
  if (!verifyLumiSecret(authHeader)) {
    console.error('[ig-backfill] 인증 실패 — LUMI_SECRET 불일치');
    return { statusCode: 401, body: JSON.stringify({ error: 'unauthorized' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'bad json' }) };
  }
  const userId = body.user_id;
  if (!userId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'user_id required' }) };
  }

  const supabase = getAdminClient();

  // 1) IG 토큰 조회 (ig_accounts_decrypted)
  const ig = await getIgTokenForSeller(userId, supabase);
  if (!ig) {
    console.log('[ig-backfill] IG 미연동 또는 토큰 없음 — skip', { userId });
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'no-ig' }) };
  }

  // 2) /{ig_user_id}/media 페이지네이션 — id/timestamp/media_type 만
  const rows = [];
  let after = null;
  let pages = 0;
  try {
    while (pages < MAX_PAGES) {
      const params = { fields: 'id,timestamp,media_type', limit: PAGE_LIMIT };
      if (after) params.after = after;
      const res = await igGraphRequest(
        ig.accessToken,
        `/${ig.igUserId}/media`,
        params,
        { timeoutMs: 10000 }
      );
      const data = Array.isArray(res.data) ? res.data : [];
      for (const m of data) {
        if (!m.id || !m.timestamp) continue;
        rows.push({
          user_id: userId,
          ig_media_id: String(m.id),
          posted_at: m.timestamp,                 // IG ISO 8601 (UTC)
          media_type: m.media_type || null,
          source: 'pre-lumi',
        });
      }
      after = res.paging && res.paging.cursors && res.paging.cursors.after;
      const hasNext = !!(res.paging && res.paging.next);
      pages++;
      if (!hasNext || !after || data.length === 0) break;
    }
  } catch (e) {
    if (e instanceof IgGraphError) {
      console.error('[ig-backfill] Graph 오류:', { status: e.status, code: e.code, message: e.message });
    } else {
      console.error('[ig-backfill] 페이지네이션 예외:', e && e.message);
    }
    // 부분 실패라도 모은 만큼은 insert 시도
  }

  if (rows.length === 0) {
    console.log('[ig-backfill] 게시 이력 0건', { userId, pages });
    return { statusCode: 200, body: JSON.stringify({ ok: true, inserted: 0, pages }) };
  }

  // 3) seller_post_history upsert
  //    onConflict (user_id, ig_media_id): 이미 들어간 row 는 건드리지 않음
  //    (Lumi 게시로 source='lumi' 들어간 row 보존 + 재호출 멱등)
  const { error } = await supabase
    .from('seller_post_history')
    .upsert(rows, { onConflict: 'user_id,ig_media_id', ignoreDuplicates: true });

  if (error) {
    console.error('[ig-backfill] upsert 실패:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  console.log('[ig-backfill] 백필 완료', { userId, fetched: rows.length, pages });
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, fetched: rows.length, pages }),
  };
};
