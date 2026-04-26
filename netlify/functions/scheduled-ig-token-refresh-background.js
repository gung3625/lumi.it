// scheduled-ig-token-refresh-background.js — IG long-lived 토큰 자동 갱신
// 만료 7일 전 자동 refresh — Meta 공식 endpoint 사용
// 스케줄: 매일 UTC 21:00 = KST 06:00 (아침 알람 전)

const https = require('https');
const { getAdminClient } = require('./_shared/supabase-admin');

// Meta IG 토큰 갱신 endpoint (검증됨)
// GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=<token>
// 조건: 24시간 이상 경과 + 만료 전
// 응답: { access_token, token_type, expires_in } (expires_in = 초)
function httpsGet(urlStr, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.get({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
  });
}

exports.handler = async (event) => {
  const isScheduled = !event || !event.httpMethod;

  // 수동 트리거: Authorization: Bearer ${LUMI_SECRET} 또는 x-lumi-secret 헤더
  if (!isScheduled) {
    const auth = (event.headers && (
      event.headers['authorization'] ||
      event.headers['Authorization'] || ''
    )).replace('Bearer ', '');
    const xSecret = event.headers && (
      event.headers['x-lumi-secret'] || event.headers['X-Lumi-Secret'] || ''
    );
    const provided = auth || xSecret;
    if (!process.env.LUMI_SECRET || provided !== process.env.LUMI_SECRET) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: '인증 실패' }),
      };
    }
  }

  const supa = getAdminClient();
  const now = new Date();
  // 갱신 대상: user_token_expires_at < now + 7일 (만료 임박)
  // Meta 조건: 토큰이 24시간 이상 + 만료 전이어야 refresh 가능
  const sevenDaysLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const twentyFourHoursLater = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  // force=true: token_expires_at IS NULL인 행도 포함 (백필용)
  let force = false;
  if (!isScheduled && event.body) {
    try {
      const parsed = JSON.parse(event.body);
      force = parsed.force === true;
    } catch (_) {}
  }

  // ig_accounts_decrypted view에서 plaintext 토큰 조회 (service_role만 접근 가능)
  // view에 access_token_secret_id 없으므로 ig_accounts에서 별도 조회
  let accountsQuery = supa
    .from('ig_accounts_decrypted')
    .select('ig_user_id, user_id, access_token, token_expires_at');

  if (force) {
    // force 모드: token_expires_at IS NULL인 행 + 만료 임박 행 모두 처리
    accountsQuery = accountsQuery.or(`token_expires_at.is.null,token_expires_at.lt.${sevenDaysLater}`);
    console.log('[ig-token-refresh] force 모드 — token_expires_at IS NULL 포함');
  } else {
    accountsQuery = accountsQuery
      .lt('token_expires_at', sevenDaysLater)
      .gt('token_expires_at', twentyFourHoursLater);
  }

  const { data: accounts, error: fetchErr } = await accountsQuery;

  if (fetchErr) {
    console.error('[ig-token-refresh] 계정 조회 실패:', fetchErr.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: '계정 조회 실패' }),
    };
  }

  if (!accounts || accounts.length === 0) {
    console.log('[ig-token-refresh] 갱신 대상 없음');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: true, refreshed: 0, failed: 0, message: '갱신 대상 없음' }),
    };
  }

  console.log(`[ig-token-refresh] 갱신 대상: ${accounts.length}명`);

  let refreshed = 0;
  let failed = 0;
  const failReasons = [];

  for (const account of accounts) {
    const igUserId = account.ig_user_id;
    const token = account.access_token;

    if (!token) {
      console.error(`[ig-token-refresh] ${igUserId}: 토큰 없음 (Vault 조회 실패)`);
      failed++;
      failReasons.push({ igUserId, reason: '토큰 없음' });
      continue;
    }

    try {
      // Meta IG 토큰 갱신 요청 (토큰 plaintext 절대 로그 금지)
      const refreshUrl = `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`;
      const res = await httpsGet(refreshUrl, 60000);

      if (res.status !== 200) {
        let errMsg = `HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(res.body);
          if (parsed.error && parsed.error.message) {
            errMsg = parsed.error.message;
          }
        } catch (_) {}
        console.error(`[ig-token-refresh] ${igUserId}: 갱신 실패 — ${errMsg}`);
        failed++;
        failReasons.push({ igUserId, reason: errMsg });
        continue;
      }

      const result = JSON.parse(res.body);
      const newToken = result.access_token;
      const expiresIn = result.expires_in; // 초 단위

      if (!newToken || !expiresIn) {
        console.error(`[ig-token-refresh] ${igUserId}: 응답 파싱 실패`);
        failed++;
        failReasons.push({ igUserId, reason: '응답 파싱 실패' });
        continue;
      }

      const newExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
      const refreshedAt = new Date().toISOString();

      // ig_accounts에서 access_token_secret_id 조회 (view에 없으므로)
      const { data: accRow } = await supa
        .from('ig_accounts')
        .select('access_token_secret_id')
        .eq('ig_user_id', igUserId)
        .maybeSingle();

      // Vault RPC로 새 토큰 암호화 저장
      const { error: vaultErr } = await supa.rpc('set_ig_access_token', {
        p_ig_user_id: igUserId,
        p_existing_secret: accRow?.access_token_secret_id ?? null,
        p_access_token: newToken,
      });

      if (vaultErr) {
        console.error(`[ig-token-refresh] ${igUserId}: Vault 저장 실패 — ${vaultErr.message}`);
        failed++;
        failReasons.push({ igUserId, reason: `Vault 저장 실패: ${vaultErr.message}` });
        continue;
      }

      // ig_accounts 만료 시점 + 갱신 시각 업데이트
      const { error: updateErr } = await supa
        .from('ig_accounts')
        .update({
          token_expires_at: newExpiresAt,
          last_refreshed_at: refreshedAt,
          updated_at: refreshedAt,
        })
        .eq('ig_user_id', igUserId);

      if (updateErr) {
        console.error(`[ig-token-refresh] ${igUserId}: ig_accounts 업데이트 실패 — ${updateErr.message}`);
        // Vault는 성공했으므로 partial success
        failed++;
        failReasons.push({ igUserId, reason: `ig_accounts 업데이트 실패: ${updateErr.message}` });
        continue;
      }

      console.log(`[ig-token-refresh] ${igUserId}: 갱신 완료 (만료: ${newExpiresAt})`);
      refreshed++;

    } catch (e) {
      console.error(`[ig-token-refresh] ${igUserId}: 예외 — ${e.message}`);
      failed++;
      failReasons.push({ igUserId, reason: e.message });
    }
  }

  console.log(`[ig-token-refresh] 완료 — 갱신: ${refreshed}, 실패: ${failed}`);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({
      success: true,
      total: accounts.length,
      refreshed,
      failed,
      failReasons: failed > 0 ? failReasons : undefined,
    }),
  };
};

module.exports.config = {
  schedule: '0 6 * * *', // 매일 KST 15:00 (= UTC 06:00)
};
