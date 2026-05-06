// tiktok-token-refresh-background.js — TikTok access_token 만료 임박 계정 일괄 갱신
//
// 공식 문서: https://developers.tiktok.com/doc/oauth-user-access-token-management/
// 갱신 엔드포인트: POST https://open.tiktokapis.com/v2/oauth/token/
//   grant_type=refresh_token, refresh_token, client_key, client_secret
//
// 스케줄: 매 6시간 (netlify.toml cron: 0 */6 * * *)
// 타임아웃: 15분 (Background Function)
//
// 대상: tiktok_accounts 에서 access_token_expires_at < now + 24h 인 계정
// Vault 저장: set_tiktok_access_token RPC (IG 패턴 동일)
//   — tiktok_access_token_secret_id, tiktok_refresh_token_secret_id 컬럼 갱신
//
// 환경변수:
//   TIKTOK_LOGIN_CLIENT_KEY    — Login Kit / Content Posting API 클라이언트 키
//   TIKTOK_LOGIN_CLIENT_SECRET — 동일 시크릿
//   LUMI_SECRET                — 수동 트리거 인증용

const { getAdminClient } = require('./_shared/supabase-admin');

const TIKTOK_TOKEN_ENDPOINT = 'https://open.tiktokapis.com/v2/oauth/token/';

exports.handler = async (event) => {
  // 수동 트리거 인증 (cron 호출은 httpMethod 없음)
  const isScheduled = !event?.httpMethod;
  if (!isScheduled) {
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 204,
        headers: { 'Allow': 'POST, OPTIONS' },
        body: '',
      };
    }
    const auth = String(event.headers?.['authorization'] || '').replace(/^Bearer\s+/i, '');
    const xSecret = event.headers?.['x-lumi-secret'] || '';
    const provided = auth || xSecret;
    if (!process.env.LUMI_SECRET || provided !== process.env.LUMI_SECRET) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' },
        body: JSON.stringify({ error: '인증 실패' }),
      };
    }
  }

  const clientKey = process.env.TIKTOK_LOGIN_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_LOGIN_CLIENT_SECRET;

  if (!clientKey || !clientSecret) {
    console.error('[tiktok-token-refresh] TIKTOK_LOGIN_CLIENT_KEY / SECRET 미설정');
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' },
      body: JSON.stringify({ error: 'TikTok 환경변수 미설정' }),
    };
  }

  const supabase = getAdminClient();
  const now = new Date();

  // 갱신 대상: access_token_expires_at < 현재 + 24시간 (만료 임박 또는 이미 만료)
  const twentyFourHoursLater = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  // force 옵션: NULL인 행도 포함 (수동 백필용)
  let force = false;
  if (!isScheduled && event.body) {
    try { force = JSON.parse(event.body).force === true; } catch (_) {}
  }

  let accountsQuery = supabase
    .from('tiktok_accounts_decrypted')
    .select('seller_id, open_id, access_token, refresh_token, access_token_expires_at');

  if (force) {
    accountsQuery = accountsQuery.or(
      `access_token_expires_at.is.null,access_token_expires_at.lt.${twentyFourHoursLater}`
    );
    console.log('[tiktok-token-refresh] force 모드 — NULL 포함');
  } else {
    accountsQuery = accountsQuery.lt('access_token_expires_at', twentyFourHoursLater);
  }

  const { data: accounts, error: fetchErr } = await accountsQuery;

  if (fetchErr) {
    console.error('[tiktok-token-refresh] 계정 조회 실패:', fetchErr.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' },
      body: JSON.stringify({ error: '계정 조회 실패: ' + fetchErr.message }),
    };
  }

  if (!accounts || accounts.length === 0) {
    console.log('[tiktok-token-refresh] 갱신 대상 없음');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' },
      body: JSON.stringify({ success: true, refreshed: 0, failed: 0, message: '갱신 대상 없음' }),
    };
  }

  console.log(`[tiktok-token-refresh] 갱신 대상: ${accounts.length}명`);

  let refreshed = 0;
  let failed = 0;
  const failReasons = [];

  for (const account of accounts) {
    const { seller_id, open_id, refresh_token } = account;

    if (!refresh_token) {
      console.error(`[tiktok-token-refresh] ${open_id}: refresh_token 없음 — 재연동 필요`);
      failed++;
      failReasons.push({ open_id, reason: 'refresh_token 없음 (재연동 필요)' });
      // 재연동 필요 상태 기록
      await supabase
        .from('tiktok_accounts')
        .update({ token_status: 'expired', updated_at: new Date().toISOString() })
        .eq('open_id', open_id)
        .catch((e) => console.error(`[tiktok-token-refresh] ${open_id}: 상태 기록 실패 — ${e.message}`));
      continue;
    }

    try {
      // TikTok 토큰 갱신 요청
      // 참조: https://developers.tiktok.com/doc/oauth-user-access-token-management/
      const params = new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token,
      });

      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 30_000);
      let res;
      try {
        res = await fetch(TIKTOK_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(tid);
      }

      const result = await res.json();

      // TikTok OAuth 오류 처리
      if (!res.ok || result.error) {
        const errMsg = result.error_description || result.error || `HTTP ${res.status}`;
        console.error(`[tiktok-token-refresh] ${open_id}: 갱신 실패 — ${errMsg}`);
        failed++;
        failReasons.push({ open_id, reason: errMsg });

        // refresh_token 자체 만료 — 재연동 필요 상태
        if (result.error === 'invalid_request' || result.error === 'invalid_grant') {
          await supabase
            .from('tiktok_accounts')
            .update({ token_status: 'expired', updated_at: new Date().toISOString() })
            .eq('open_id', open_id)
            .catch((e) => console.error(`[tiktok-token-refresh] ${open_id}: 상태 기록 실패 — ${e.message}`));
        }
        continue;
      }

      const newAccessToken = result.access_token;
      const newRefreshToken = result.refresh_token;
      const expiresIn = result.expires_in;           // access_token 유효기간 (초)
      const refreshExpiresIn = result.refresh_expires_in; // refresh_token 유효기간 (초)

      if (!newAccessToken) {
        console.error(`[tiktok-token-refresh] ${open_id}: 응답에 access_token 없음`);
        failed++;
        failReasons.push({ open_id, reason: '응답 파싱 실패 (access_token 없음)' });
        continue;
      }

      const newAccessExpiresAt = expiresIn
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : null;
      const newRefreshExpiresAt = refreshExpiresIn
        ? new Date(Date.now() + refreshExpiresIn * 1000).toISOString()
        : null;
      const refreshedAt = new Date().toISOString();

      // Vault RPC로 새 토큰 암호화 저장 (set_tiktok_access_token RPC)
      const { error: vaultErr } = await supabase.rpc('set_tiktok_access_token', {
        p_seller_id: seller_id,
        p_open_id: open_id,
        p_access_token: newAccessToken,
        p_refresh_token: newRefreshToken || null,
        p_access_expires_at: newAccessExpiresAt,
        p_refresh_expires_at: newRefreshExpiresAt,
        p_scope: null,
      });

      if (vaultErr) {
        console.error(`[tiktok-token-refresh] ${open_id}: Vault 저장 실패 — ${vaultErr.message}`);
        failed++;
        failReasons.push({ open_id, reason: `Vault 저장 실패: ${vaultErr.message}` });
        continue;
      }

      // tiktok_accounts 만료 시점 + 갱신 시각 업데이트
      const { error: updateErr } = await supabase
        .from('tiktok_accounts')
        .update({
          access_token_expires_at: newAccessExpiresAt,
          refresh_token_expires_at: newRefreshExpiresAt,
          token_status: 'active',
          last_refreshed_at: refreshedAt,
          updated_at: refreshedAt,
        })
        .eq('open_id', open_id);

      if (updateErr) {
        console.error(`[tiktok-token-refresh] ${open_id}: tiktok_accounts 업데이트 실패 — ${updateErr.message}`);
        // Vault는 성공했으므로 partial success로 처리
        failed++;
        failReasons.push({ open_id, reason: `tiktok_accounts 업데이트 실패: ${updateErr.message}` });
        continue;
      }

      console.log(`[tiktok-token-refresh] ${open_id}: 갱신 완료 (만료: ${newAccessExpiresAt})`);
      refreshed++;

    } catch (e) {
      console.error(`[tiktok-token-refresh] ${open_id}: 예외 — ${e.message}`);
      failed++;
      failReasons.push({ open_id, reason: e.message });
    }
  }

  console.log(`[tiktok-token-refresh] 완료 — 갱신: ${refreshed}, 실패: ${failed}`);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' },
    body: JSON.stringify({
      success: true,
      total: accounts.length,
      refreshed,
      failed,
      failReasons: failed > 0 ? failReasons : undefined,
    }),
  };
};
