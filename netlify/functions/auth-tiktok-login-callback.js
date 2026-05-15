// TikTok Login Kit / Content Posting OAuth 콜백 핸들러
// GET /api/auth/tiktok/login/callback?code=...&state=...
// Marketing API 콜백(tiktok-oauth-callback.js)과 완전 분리.
//
// 흐름:
//   1) state nonce 검증 (oauth_nonces, 'tiktok_login:' prefix, 10분 TTL, 일회용)
//   2) code → access_token 교환 (open.tiktokapis.com/v2/oauth/token/)
//   3) user/info 조회 (open_id, union_id, avatar_url, display_name)
//   4) Supabase RPC set_tiktok_access_token 호출
//   5) tiktok_accounts 테이블 upsert
//   6) sellers 테이블 tiktok_connected / tiktok_handle / tiktok_connected_at 갱신
//   7) /settings.html?tiktok=connected 로 302 리다이렉트
//
// 환경변수:
//   - TIKTOK_LOGIN_CLIENT_KEY    (Login Kit / Content Posting)
//   - TIKTOK_LOGIN_CLIENT_SECRET (Login Kit / Content Posting)

const { getAdminClient } = require('./_shared/supabase-admin');

const CLIENT_KEY = process.env.TIKTOK_LOGIN_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_LOGIN_CLIENT_SECRET;
const REDIRECT_URI = 'https://lumi.it.kr/api/auth/tiktok/login/callback';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const USER_INFO_URL = 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name';

function redirect(location) {
  return {
    statusCode: 302,
    headers: { Location: location, 'Cache-Control': 'no-store' },
    body: '',
  };
}

function errorRedirect(code) {
  return redirect(`/settings.html?tiktok_error=${encodeURIComponent(code)}`);
}

function jsonError(statusCode, message) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ error: message }),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*' } };
  }

  const q = event.queryStringParameters || {};
  const { code, state, error: errParam, error_description } = q;

  if (errParam) {
    console.log('[auth-tiktok-login-callback] TikTok 거부:', errParam, error_description || '');
    return errorRedirect(errParam);
  }

  if (!code) {
    return jsonError(400, 'missing_code');
  }

  if (!CLIENT_KEY || !CLIENT_SECRET) {
    console.error('[auth-tiktok-login-callback] TIKTOK_LOGIN_CLIENT_KEY/SECRET 미설정');
    // 심사 대기 중 콜백 URL 유효성 증명용 응답
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: '<!doctype html><meta charset="utf-8"><title>lumi · TikTok</title><body style="font-family:system-ui;padding:48px;text-align:center;"><h1>연결 처리 중</h1><p>잠시만 기다려 주세요.</p></body>',
    };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[auth-tiktok-login-callback] admin 초기화 실패:', e.message);
    return errorRedirect('server_error');
  }

  // ──────────────────────────────────────────────
  // 1) state nonce 검증 → seller_id 복원
  // ──────────────────────────────────────────────
  let sellerId = null;

  if (state && /^[a-f0-9]{32}$/i.test(state)) {
    try {
      const nonceKey = 'tiktok_login:' + state;
      // TOCTOU 차단: SELECT + DELETE 분리하면 두 번 동시 콜백 시 둘 다 nonce row 받아
      // 토큰 중복 발급 가능. atomic DELETE-RETURNING 으로 한 쪽만 row 획득.
      const { data: nonceRows, error: nonceDelErr } = await admin
        .from('oauth_nonces')
        .delete()
        .eq('nonce', nonceKey)
        .select('user_id, lumi_token, created_at');

      if (nonceDelErr) {
        console.error('[auth-tiktok-login-callback] nonce delete 예외:', nonceDelErr.message);
        return errorRedirect('server_error');
      }

      const nonceRow = nonceRows && nonceRows[0];
      if (!nonceRow) {
        console.error('[auth-tiktok-login-callback] nonce not found:', nonceKey);
        return errorRedirect('invalid_state');
      }

      const ageMs = Date.now() - new Date(nonceRow.created_at).getTime();

      if (ageMs > 10 * 60 * 1000) {
        console.error('[auth-tiktok-login-callback] nonce 만료');
        return errorRedirect('state_expired');
      }

      try {
        const meta = nonceRow.lumi_token ? JSON.parse(nonceRow.lumi_token) : null;
        if (meta && meta.seller_id) sellerId = meta.seller_id;
      } catch (_) {}

      if (!sellerId) sellerId = nonceRow.user_id || null;
    } catch (e) {
      console.error('[auth-tiktok-login-callback] nonce 조회 예외:', e.message);
      return errorRedirect('server_error');
    }
  } else {
    console.error('[auth-tiktok-login-callback] state 형식 오류 또는 누락');
    return errorRedirect('invalid_state');
  }

  if (!sellerId) {
    console.error('[auth-tiktok-login-callback] seller_id 복원 실패');
    return errorRedirect('missing_seller');
  }

  try {
    // ──────────────────────────────────────────────
    // 2) code → access_token 교환
    // ──────────────────────────────────────────────
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: CLIENT_KEY,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => '');
      console.error('[auth-tiktok-login-callback] 토큰 교환 HTTP 오류:', tokenRes.status, body);
      return errorRedirect('token_exchange_failed');
    }

    const tokenData = await tokenRes.json();

    // TikTok v2 응답: { data: { access_token, refresh_token, open_id, scope, ... }, error: { code, message } }
    if (tokenData.error && tokenData.error.code !== 'ok') {
      console.error('[auth-tiktok-login-callback] 토큰 교환 오류:', tokenData.error.message);
      return errorRedirect('token_exchange_failed');
    }

    const td = tokenData.data || tokenData;
    const accessToken = td.access_token;
    const refreshToken = td.refresh_token || null;
    const expiresIn = td.expires_in || 0;           // seconds
    const refreshExpiresIn = td.refresh_expires_in || 0;
    const scope = td.scope || null;

    if (!accessToken) {
      console.error('[auth-tiktok-login-callback] access_token 누락');
      return errorRedirect('no_access_token');
    }

    const now = Date.now();
    const accessExpiresAt = expiresIn
      ? new Date(now + expiresIn * 1000).toISOString()
      : null;
    const refreshExpiresAt = refreshExpiresIn
      ? new Date(now + refreshExpiresIn * 1000).toISOString()
      : null;

    // ──────────────────────────────────────────────
    // 3) user/info 조회
    // ──────────────────────────────────────────────
    const userRes = await fetch(USER_INFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    let openId = null;
    let unionId = null;
    let displayName = null;
    let avatarUrl = null;

    if (userRes.ok) {
      const userData = await userRes.json();
      const ui = (userData.data && userData.data.user) || {};
      openId = ui.open_id || null;
      unionId = ui.union_id || null;
      displayName = ui.display_name || null;
      avatarUrl = ui.avatar_url || null;
    } else {
      console.warn('[auth-tiktok-login-callback] user/info 조회 실패 (무시하고 진행):', userRes.status);
    }

    // ──────────────────────────────────────────────
    // 4) Supabase RPC set_tiktok_access_token
    // ──────────────────────────────────────────────
    const { error: rpcErr } = await admin.rpc('set_tiktok_access_token', {
      p_seller_id: sellerId,
      p_open_id: openId,
      p_access_token: accessToken,
      p_refresh_token: refreshToken,
      p_access_expires_at: accessExpiresAt,
      p_refresh_expires_at: refreshExpiresAt,
      p_scope: scope,
    });

    if (rpcErr) {
      console.error('[auth-tiktok-login-callback] set_tiktok_access_token RPC 실패:', rpcErr.message);
      return errorRedirect('token_save_failed');
    }

    // ──────────────────────────────────────────────
    // 5) tiktok_accounts upsert
    // ──────────────────────────────────────────────
    const nowIso = new Date().toISOString();
    const { error: accountErr } = await admin
      .from('tiktok_accounts')
      .upsert({
        seller_id: sellerId,
        open_id: openId,
        union_id: unionId,
        display_name: displayName,
        avatar_url: avatarUrl,
        scope,
        connected_at: nowIso,
        updated_at: nowIso,
      }, { onConflict: 'seller_id' });

    if (accountErr) {
      console.error('[auth-tiktok-login-callback] tiktok_accounts upsert 실패:', accountErr.message);
      return errorRedirect('account_save_failed');
    }

    // ──────────────────────────────────────────────
    // 6) sellers 테이블 갱신
    // ──────────────────────────────────────────────
    const { error: sellerErr } = await admin
      .from('sellers')
      .update({
        tiktok_connected: true,
        tiktok_handle: displayName,
        tiktok_connected_at: nowIso,
      })
      .eq('id', sellerId);

    if (sellerErr) {
      console.warn('[auth-tiktok-login-callback] sellers 테이블 갱신 실패 (무시하고 진행):', sellerErr.message);
    }

    console.log('[auth-tiktok-login-callback] TikTok 연동 완료. seller_id:', sellerId, 'open_id:', openId);

    // ──────────────────────────────────────────────
    // 7) 성공 리다이렉트
    // ──────────────────────────────────────────────
    return redirect('/settings.html?tiktok=connected');

  } catch (e) {
    console.error('[auth-tiktok-login-callback] 예외:', e.message);
    return errorRedirect('server_error');
  }
};
