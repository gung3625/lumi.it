// Facebook Login + Instagram 연동 OAuth 핸들러
// 토큰은 반드시 Supabase Vault(set_ig_access_token / set_ig_page_access_token RPC)로 저장.
// ig_accounts 테이블에는 secret_id(uuid)만 보관 — 평문 토큰 저장 금지.
const crypto = require('crypto');
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken } = require('./_shared/supabase-auth');

const APP_ID = process.env.META_APP_ID || '1233639725586126';
const APP_SECRET = process.env.META_APP_SECRET;
const REDIRECT_URI = 'https://lumi.it.kr/.netlify/functions/ig-oauth';
const SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
  'instagram_business_manage_comments',
  'instagram_business_manage_insights',
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_metadata',
].join(',');

// 장기 토큰 만료 추정 (60일)
function computeExpiresAt(expiresInSec) {
  const secs = Number(expiresInSec);
  if (!secs || Number.isNaN(secs)) return null;
  return new Date(Date.now() + secs * 1000).toISOString();
}

exports.handler = async (event) => {
  const params = new URLSearchParams(event.rawQuery || '');
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');

  if (error) {
    console.error('[ig-oauth] OAuth 에러:', error);
    return { statusCode: 302, headers: { Location: 'https://lumi.it.kr/?oauth_error=1' } };
  }

  const supabase = getAdminClient();

  // ──────────────────────────────────────────────
  // 1) code 없음 → OAuth 시작 (nonce 발급 + Facebook 인증 리다이렉트)
  // ──────────────────────────────────────────────
  if (!code) {
    const lumiToken = params.get('token') || '';
    if (!lumiToken) {
      console.error('[ig-oauth] OAuth 시작 실패: 토큰 없음');
      return { statusCode: 302, headers: { Location: 'https://lumi.it.kr/?oauth_error=1' } };
    }

    const { user, error: authError } = await verifyBearerToken(lumiToken);
    if (authError || !user) {
      console.error('[ig-oauth] OAuth 시작 실패: 토큰 검증 실패');
      return { statusCode: 302, headers: { Location: 'https://lumi.it.kr/?oauth_error=1' } };
    }

    const userId = user.id;
    const nonce = crypto.randomBytes(16).toString('hex');

    try {
      await supabase.from('oauth_nonces').insert({
        nonce: 'ig:' + nonce,
        user_id: userId,
        lumi_token: null,
      });
    } catch (e) {
      console.error('[ig-oauth] nonce 저장 실패:', e.message);
    }

    const authUrl =
      `https://www.facebook.com/dialog/oauth?` +
      `client_id=${APP_ID}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&scope=${encodeURIComponent(SCOPES)}` +
      `&response_type=code` +
      `&state=${encodeURIComponent(nonce)}`;
    return { statusCode: 302, headers: { Location: authUrl } };
  }

  try {
    // ────────────────────────────────────────────
    // 2) code → 단기 토큰 교환
    // ────────────────────────────────────────────
    const tokenRes = await fetch(
      `https://graph.facebook.com/v25.0/oauth/access_token?` +
      `client_id=${APP_ID}&client_secret=${APP_SECRET}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code=${code}`
    );
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('[ig-oauth] 단기 토큰 교환 실패 (access_token 없음)');
      return { statusCode: 302, headers: { Location: 'https://lumi.it.kr/?oauth_error=2' } };
    }

    // ────────────────────────────────────────────
    // 3) 장기 토큰 교환 (60일)
    // ────────────────────────────────────────────
    const longTokenRes = await fetch(
      `https://graph.facebook.com/v25.0/oauth/access_token?` +
      `grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}` +
      `&fb_exchange_token=${tokenData.access_token}`
    );
    const longTokenData = await longTokenRes.json();
    const longToken = longTokenData.access_token || tokenData.access_token;
    const expiresAt = computeExpiresAt(longTokenData.expires_in);

    // ────────────────────────────────────────────
    // 4) Facebook Pages → Instagram Business Account 탐색
    // ────────────────────────────────────────────
    const igRes = await fetch(`https://graph.facebook.com/v25.0/me/accounts?access_token=${longToken}`);
    const igData = await igRes.json();

    let igUserId = null;
    let igUsername = null;
    let pageId = null;
    let pageAccessToken = null;

    for (const page of (igData.data || [])) {
      const igAccountRes = await fetch(
        `https://graph.facebook.com/v25.0/${page.id}?fields=instagram_business_account{id,username}&access_token=${page.access_token}`
      );
      const igAccountData = await igAccountRes.json();
      const biz = igAccountData.instagram_business_account;
      if (biz && biz.id) {
        igUserId = biz.id;
        igUsername = biz.username || null;
        pageId = page.id;
        pageAccessToken = page.access_token;
        break;
      }
    }

    if (!igUserId) {
      console.error('[ig-oauth] Instagram 비즈니스 계정 없음');
      return { statusCode: 302, headers: { Location: 'https://lumi.it.kr/?oauth_error=3' } };
    }

    // ────────────────────────────────────────────
    // 5) nonce → user_id 복원 (oauth_nonces)
    //    10분 만료 & 일회용
    // ────────────────────────────────────────────
    let userId = null;
    if (state) {
      try {
        const nonceKey = 'ig:' + state;
        const { data: nonceRow } = await supabase
          .from('oauth_nonces')
          .select('user_id, lumi_token, created_at')
          .eq('nonce', nonceKey)
          .maybeSingle();
        if (nonceRow) {
          const ageMs = Date.now() - new Date(nonceRow.created_at).getTime();
          if (ageMs < 10 * 60 * 1000) {
            userId = nonceRow.user_id || null;
          }
          // 일회용: 즉시 삭제
          await supabase.from('oauth_nonces').delete().eq('nonce', nonceKey);
        }
      } catch (e) {
        console.error('[ig-oauth] nonce 조회 실패:', e.message);
      }
    }

    if (!userId) {
      console.error('[ig-oauth] user_id 확인 불가 (nonce 만료 또는 세션 없음)');
      return { statusCode: 302, headers: { Location: 'https://lumi.it.kr/?oauth_error=4' } };
    }

    // ────────────────────────────────────────────
    // 6) 기존 secret_id 조회 (재연동 시 같은 Vault 레코드에 덮어쓰기)
    // ────────────────────────────────────────────
    const { data: existingRow } = await supabase
      .from('ig_accounts')
      .select('access_token_secret_id, page_access_token_secret_id')
      .eq('ig_user_id', igUserId)
      .maybeSingle();

    // ────────────────────────────────────────────
    // 7) Vault RPC로 토큰 암호화 저장 (upsert 전에 secret_id 확보)
    // ────────────────────────────────────────────
    const { data: accessSecretId, error: accessErr } = await supabase.rpc('set_ig_access_token', {
      p_ig_user_id: igUserId,
      p_existing_secret: existingRow?.access_token_secret_id ?? null,
      p_access_token: longToken,
    });
    if (accessErr) {
      console.error('[ig-oauth] set_ig_access_token 실패:', accessErr.message);
      return { statusCode: 302, headers: { Location: 'https://lumi.it.kr/?oauth_error=6' } };
    }

    let pageSecretId = null;
    if (pageAccessToken) {
      const { data: pSecretId, error: pageErr } = await supabase.rpc('set_ig_page_access_token', {
        p_ig_user_id: igUserId,
        p_existing_secret: existingRow?.page_access_token_secret_id ?? null,
        p_page_token: pageAccessToken,
      });
      if (pageErr) {
        console.warn('[ig-oauth] set_ig_page_access_token 실패 (무시하고 진행):', pageErr.message);
      } else {
        pageSecretId = pSecretId;
      }
    }

    // ────────────────────────────────────────────
    // 8) ig_accounts upsert (secret_id 포함 — NOT NULL 제약 충족)
    // ────────────────────────────────────────────
    const nowIso = new Date().toISOString();
    const { error: upsertErr } = await supabase
      .from('ig_accounts')
      .upsert({
        ig_user_id: igUserId,
        user_id: userId,
        ig_username: igUsername,
        page_id: pageId,
        token_expires_at: expiresAt,
        connected_at: nowIso,
        updated_at: nowIso,
        access_token_secret_id: accessSecretId,
        page_access_token_secret_id: pageSecretId,
      }, { onConflict: 'ig_user_id' });

    if (upsertErr) {
      console.error('[ig-oauth] ig_accounts upsert 실패:', upsertErr.message);
      return { statusCode: 302, headers: { Location: 'https://lumi.it.kr/?oauth_error=5' } };
    }

    // 토큰/secret_id는 절대 로그에 남기지 않음. ig_user_id만.
    console.log('[ig-oauth] Instagram 연동 완료. ig_user_id:', igUserId);
    return { statusCode: 302, headers: { Location: 'https://lumi.it.kr/?ig=connected' } };

  } catch (e) {
    console.error('[ig-oauth] OAuth 처리 오류:', e.message);
    return { statusCode: 302, headers: { Location: 'https://lumi.it.kr/?oauth_error=99' } };
  }
};
