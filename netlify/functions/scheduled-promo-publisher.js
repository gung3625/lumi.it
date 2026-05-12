const { corsHeaders, getOrigin, verifyLumiSecret } = require('./_shared/auth');
// 예약된 홍보 게시 스케줄러 — promo_schedule 테이블에서 pending 행을 polling해 IG에 게시.
// 스케줄: 매 5분마다 (exports.config.schedule). 수동 트리거: POST /api/scheduled-promo-publisher (LUMI_SECRET 필요).
// 토큰·이메일·이름 절대 로그 노출 금지.
const { getAdminClient } = require('./_shared/supabase-admin');
const { toProxyUrl } = require('./_shared/ig-image-url');

exports.config = { schedule: '*/5 * * * *' };


const GRAPH = 'https://graph.facebook.com/v25.0';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Meta Graph API hang 방지 — 모든 fetch 에 AbortController + 60s timeout.
// 5분 cron 안에 끝나지 않으면 다음 인스턴스가 같은 row 를 다시 픽업 → 중복 게시.
// 60s × 8회 (waitForContainer 6회 + create + publish) = 최악 8분이지만 보통 < 30s.
const FETCH_TIMEOUT_MS = 60_000;

async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(tid);
  }
}

async function createSingleImageContainer(igUserId, igAccessToken, imageUrl, caption) {
  const res = await fetchWithTimeout(`${GRAPH}/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      image_url: imageUrl,
      media_type: 'IMAGE',
      caption,
      access_token: igAccessToken,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || '컨테이너 생성 실패');
  return data.id;
}

// status_code 체크 — FINISHED=성공, ERROR=실패. 5초 × 최대 6회.
async function waitForContainer(containerId, accessToken, maxRetries = 6) {
  for (let i = 0; i < maxRetries; i++) {
    await sleep(5000);
    try {
      const res = await fetchWithTimeout(`${GRAPH}/${containerId}?fields=status_code&access_token=${accessToken}`, {}, 15_000);
      const data = await res.json();
      if (data.status_code === 'FINISHED') return true;
      if (data.status_code === 'ERROR') return false;
    } catch (_) { /* 다음 retry */ }
  }
  return true;
}

async function publishMedia(igUserId, igAccessToken, creationId) {
  const res = await fetchWithTimeout(`${GRAPH}/${igUserId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ creation_id: creationId, access_token: igAccessToken }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || '게시 실패');
  return data.id;
}

async function fetchAdminIgTokens(supabase) {
  const { data: adminRow, error: adminErr } = await supabase
    .from('sellers')
    .select('id')
    .eq('is_admin', true)
    .limit(1)
    .maybeSingle();
  if (adminErr || !adminRow) throw new Error('관리자 계정 없음');

  const { data: igRow, error: igErr } = await supabase
    .from('ig_accounts_decrypted')
    .select('ig_user_id, access_token, page_access_token')
    .eq('user_id', adminRow.id)
    .maybeSingle();
  if (igErr || !igRow || !igRow.ig_user_id || !igRow.access_token) {
    throw new Error('IG 연동 정보 없음');
  }

  return {
    igUserId: igRow.ig_user_id,
    igAccessToken: igRow.page_access_token || igRow.access_token,
  };
}

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  // HTTP OPTIONS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  // 수동 HTTP 트리거 시 인증 검사 (스케줄 호출은 httpMethod가 없음)
  if (event.httpMethod === 'POST') {
    const auth = (event.headers.authorization || event.headers.Authorization || '');
    if (!verifyLumiSecret(auth)) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 실패' }) };
    }
  } else if (event.httpMethod && event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST 전용 엔드포인트입니다.' }) };
  }

  try {
    const supabase = getAdminClient();
    const now = new Date().toISOString();

    // 0) 좀비 'processing' 행 복구 — 이전 cron 인스턴스가 hang/crash 후 status 가
    //    'processing' 으로 멈춘 row 를 10분 지나면 pending 으로 되돌림. AbortController
    //    timeout 도 최대 60s × 8회 ≈ 8분이라 10분 이후 stuck 이면 진짜 죽은 상태.
    const tenMinAgoIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    try {
      const { data: rescued } = await supabase
        .from('promo_schedule')
        .update({ status: 'pending' })
        .eq('status', 'processing')
        .lt('updated_at', tenMinAgoIso)
        .select('id');
      if (rescued && rescued.length) {
        console.log(`[scheduled-promo-publisher] 좀비 processing 복구: ${rescued.length}개`);
      }
    } catch (e) {
      console.warn('[scheduled-promo-publisher] 좀비 복구 무시:', e && e.message);
    }

    // 1) pending 행 최대 5개 조회 (scheduled_at <= now)
    const { data: rows, error: fetchErr } = await supabase
      .from('promo_schedule')
      .select('*')
      .eq('status', 'pending')
      .lte('scheduled_at', now)
      .order('scheduled_at', { ascending: true })
      .limit(5);

    if (fetchErr) throw new Error(fetchErr.message);

    if (!rows || rows.length === 0) {
      console.log('[scheduled-promo-publisher] 처리할 행 없음');
      return { statusCode: 200, headers, body: JSON.stringify({ ran: 0 }) };
    }

    console.log(`[scheduled-promo-publisher] 처리 시작: count=${rows.length}`);

    // 2) 관리자 IG 토큰 1회 조회 (전체 배치에 재사용)
    const { igUserId, igAccessToken } = await fetchAdminIgTokens(supabase);

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    for (const row of rows) {
      const updatedAt = new Date().toISOString();

      // 3) 동시 cron 인스턴스 차단 — atomic CAS 'pending' → 'processing'.
      //    Postgres 가 row lock 안에서 WHERE 재검사 → 오직 한 인스턴스만 affected rows > 0.
      //    이전엔 select-then-update 패턴이라 동시 cron 이 같은 row 둘 다 통과 → 중복 게시 위험.
      const { data: claimed, error: claimErr } = await supabase
        .from('promo_schedule')
        .update({ status: 'processing', updated_at: updatedAt })
        .eq('id', row.id)
        .eq('status', 'pending')
        .select('id');
      if (claimErr) {
        console.warn(`[scheduled-promo-publisher] claim 실패 row=${row.id}:`, claimErr.message);
        skipped++;
        continue;
      }
      if (!claimed || claimed.length === 0) {
        console.log(`[scheduled-promo-publisher] 이미 다른 인스턴스가 처리 중 row=${row.id}`);
        skipped++;
        continue;
      }

      try {
        // 4) 단일 이미지 컨테이너 생성 (IG crawler가 Supabase 도메인 fetch 못하므로 lumi.it.kr 프록시 URL 사용)
        const creationId = await createSingleImageContainer(igUserId, igAccessToken, toProxyUrl(row.image_url), row.caption);

        // 5) 처리 완료 대기
        const ready = await waitForContainer(creationId, igAccessToken);
        if (!ready) throw new Error('이미지 처리 실패 (status_code=ERROR)');

        // 6) 게시
        const postId = await publishMedia(igUserId, igAccessToken, creationId);

        // 7) 성공 업데이트
        await supabase
          .from('promo_schedule')
          .update({ status: 'done', post_id: String(postId), updated_at: new Date().toISOString() })
          .eq('id', row.id);

        console.log(`[scheduled-promo-publisher] row=${row.id} status=done`);
        succeeded++;
      } catch (err) {
        // 8) 실패 처리: attempts >= 3 → failed, 그 외 재시도 위해 pending 복귀
        const newAttempts = (row.attempts || 0) + 1;
        const newStatus = newAttempts >= 3 ? 'failed' : 'pending';

        await supabase
          .from('promo_schedule')
          .update({
            status: newStatus,
            attempts: newAttempts,
            last_error: err.message,
            updated_at: new Date().toISOString(),
          })
          .eq('id', row.id);

        console.log(`[scheduled-promo-publisher] row=${row.id} status=${newStatus} attempts=${newAttempts}`);
        failed++;
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ran: rows.length, succeeded, failed, skipped }),
    };
  } catch (err) {
    console.error('[scheduled-promo-publisher] 예외:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || '처리 중 오류가 발생했습니다.' }) };
  }
};
