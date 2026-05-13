// Threads OAuth 핸들러
//
// 결정사항 §12-A #1 (revised) — IG 와 Threads 는 별도 OAuth flow.
// Threads 는 자체 인증 엔드포인트(threads.net/oauth/authorize)와 자체 토큰
// 엔드포인트(graph.threads.net/oauth/access_token)를 쓰므로 Facebook Login
// (facebook.com/dialog/oauth) 과 합칠 수 없음.
//
// 패턴은 ig-oauth.js 와 1:1 대응:
//   - oauth_nonces 에 'threads:' 접두사로 저장 (IG 'ig:' 와 분리)
//   - 토큰은 Supabase Vault(set_threads_token RPC)로 암호화 저장
//   - ig_accounts.threads_* 컬럼(M1.3a 추가)에 secret_id 등 저장
//
// 제약 (M1): IG 먼저 연동 필수.
//   ig_accounts 는 IG 전제 NOT NULL 컬럼(ig_user_id, access_token_secret_id)
//   이 있어 Threads 단독 row 를 만들려면 sentinel 값이 필요한데 깨지기 쉬움.
//   따라서 ig_accounts row 가 이미 있는 사장님만 Threads 연동 가능.
//   미연동 시 settings?threads_oauth_error=10 → 'IG 먼저 연동' 안내.
//
// 호출 시점:
//   1. 회원가입 페이지 'Threads 연동' 버튼 (IG 연동 후 활성)
//   2. settings 페이지 'Threads 연동' 버튼 (재연동·신규 연동)
//
// 환경변수:
//   - THREADS_APP_ID    : 미설정 시 META_APP_ID fallback
//   - THREADS_APP_SECRET: 미설정 시 META_APP_SECRET fallback
//   (단일 Meta 앱에서 IG + Threads use case 둘 다 활성화한 경우 동일 사용)

const crypto = require('crypto');
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken } = require('./_shared/supabase-auth');

const APP_ID     = process.env.THREADS_APP_ID     || process.env.META_APP_ID;
const APP_SECRET = process.env.THREADS_APP_SECRET || process.env.META_APP_SECRET;
if (!APP_ID || !APP_SECRET) {
  throw new Error('THREADS_APP_ID / THREADS_APP_SECRET (또는 META_APP_ID/SECRET fallback) 환경변수 필수');
}

const REDIRECT_URI = 'https://lumi.it.kr/.netlify/functions/threads-oauth';

// M1 범위 — 게시(2단계 컨테이너 → publish) 필요한 최소 스코프.
// insights / replies 는 후속 단계에서 추가.
const SCOPES = [
  'threads_basic',
  'threads_content_publish',
].join(',');

const SAFE_RETURN_TO = new Set(['/dashboard', '/settings', '/signup']);
function sanitizeReturnTo(raw) {
  if (!raw || typeof raw !== 'string') return '/dashboard';
  return SAFE_RETURN_TO.has(raw) ? raw : '/dashboard';
}

function computeExpiresAt(expiresInSec) {
  const secs = Number(expiresInSec);
  if (!secs || Number.isNaN(secs)) return null;
  return new Date(Date.now() + secs * 1000).toISOString();
}

exports.handler = async (event) => {
  const params = new URLSearchParams(event.rawQuery || '');
  const code   = params.get('code');
  const state  = params.get('state');
  const error  = params.get('error');

  if (error) {
    console.error('[threads-oauth] OAuth 에러:', error);
    return { statusCode: 302, headers: { Location: 'https://lumi.it.kr/settings?threads_oauth_error=1' } };
  }

  const supabase = getAdminClient();

  // ──────────────────────────────────────────────
  // 1) code 없음 → OAuth 시작 (nonce 발급 + Threads 인증 리다이렉트)
  // ──────────────────────────────────────────────
  if (!code) {
    const lumiToken = params.get('token') || '';
    if (!lumiToken) {
      console.error('[threads-oauth] OAuth 시작 실패: 토큰 없음');
      return { statusCode: 302, headers: { Location: 'https://lumi.it.kr/settings?threads_oauth_error=1' } };
    }

    // Supabase JWT 우선, 실패 시 seller-jwt(HS256) fallback (ig-oauth.js 패턴 동일)
    let userId = null;
    const { user, error: authError } = await verifyBearerToken(lumiToken);
    if (!authError && user) {
      userId = user.id;
    } else {
      try {
        const { verifySellerToken } = require('./_shared/seller-jwt');
        const decoded = verifySellerToken(lumiToken);
        if (decoded?.seller_id) userId = decoded.seller_id;
      } catch (_) { /* invalid */ }
    }
    if (!userId) {
      console.error('[threads-oauth] OAuth 시작 실패: 토큰 검증 실패');
      return { statusCode: 302, headers: { Location: 'https://lumi.it.kr/settings?threads_oauth_error=1' } };
    }

    const nonce    = crypto.randomBytes(16).toString('hex');
    const returnTo = sanitizeReturnTo(params.get('return_to'));

    try {
      await supabase.from('oauth_nonces').insert({
        nonce: 'threads:' + nonce,    // ig: 와 충돌 방지
        user_id: userId,
        lumi_token: null,
        redirect_to: returnTo,
      });
    } catch (e) {
      console.error('[threads-oauth] nonce 저장 실패:', e.message);
    }

    const authUrl =
      `https://threads.net/oauth/authorize?` +
      `client_id=${APP_ID}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&scope=${encodeURIComponent(SCOPES)}` +
      `&response_type=code` +
      `&state=${encodeURIComponent(nonce)}`;
    return { statusCode: 302, headers: { Location: authUrl } };
  }

  // ──────────────────────────────────────────────
  // 1.5) nonce 우선 파싱 — 모든 이후 에러 redirect 가 returnTo 를 쓰도록.
  //      코드 리뷰 #5 — 사장님이 signup 에서 시작했으면 signup 으로 돌아와 안내 표시.
  //      nonce 는 일회용이라 이 시점에 즉시 삭제 (성공·실패 무관).
  // ──────────────────────────────────────────────
  let userId    = null;
  let returnTo  = '/settings';
  if (state) {
    try {
      const nonceKey = 'threads:' + state;
      const { data: nonceRow } = await supabase
        .from('oauth_nonces')
        .select('user_id, redirect_to, created_at')
        .eq('nonce', nonceKey)
        .maybeSingle();
      if (nonceRow) {
        const ageMs = Date.now() - new Date(nonceRow.created_at).getTime();
        if (ageMs < 10 * 60 * 1000) {
          userId   = nonceRow.user_id || null;
          returnTo = sanitizeReturnTo(nonceRow.redirect_to);
        }
        await supabase.from('oauth_nonces').delete().eq('nonce', nonceKey);
      }
    } catch (e) {
      console.error('[threads-oauth] nonce 조회 실패:', e.message);
    }
  }
  if (!userId) {
    console.error('[threads-oauth] user_id 확인 불가 (nonce 만료 또는 세션 없음)');
    return { statusCode: 302, headers: { Location: `https://lumi.it.kr${returnTo}?threads_oauth_error=4` } };
  }

  try {
    // ────────────────────────────────────────────
    // 2) code → 단기 토큰 교환 (Threads 는 POST form-data)
    // ────────────────────────────────────────────
    const shortBody = new URLSearchParams({
      client_id: APP_ID,
      client_secret: APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
      code,
    });
    const shortRes = await fetch('https://graph.threads.net/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: shortBody,
    });
    const shortData = await shortRes.json();
    if (!shortData.access_token) {
      console.error('[threads-oauth] 단기 토큰 교환 실패:', shortData.error_message || shortData.error || 'access_token 없음');
      return { statusCode: 302, headers: { Location: `https://lumi.it.kr${returnTo}?threads_oauth_error=2` } };
    }
    const threadsUserId = shortData.user_id ? String(shortData.user_id) : null;

    // ────────────────────────────────────────────
    // 3) 장기 토큰 교환 (60일) — Threads 는 GET, grant_type=th_exchange_token
    // ────────────────────────────────────────────
    const longUrl = `https://graph.threads.net/access_token?` +
      `grant_type=th_exchange_token` +
      `&client_secret=${encodeURIComponent(APP_SECRET)}` +
      `&access_token=${encodeURIComponent(shortData.access_token)}`;
    const longRes  = await fetch(longUrl);
    const longData = await longRes.json();
    const longToken = longData.access_token || shortData.access_token;
    const expiresAt = computeExpiresAt(longData.expires_in);

    // ────────────────────────────────────────────
    // 4) user_id 보강 (단기 토큰 응답에 없으면 /me 호출)
    // ────────────────────────────────────────────
    let resolvedThreadsUserId = threadsUserId;
    if (!resolvedThreadsUserId) {
      try {
        const meRes  = await fetch(`https://graph.threads.net/v1.0/me?fields=id&access_token=${encodeURIComponent(longToken)}`);
        const meData = await meRes.json();
        if (meData && meData.id) resolvedThreadsUserId = String(meData.id);
      } catch (e) {
        console.warn('[threads-oauth] /me 조회 실패:', e && e.message);
      }
    }
    if (!resolvedThreadsUserId) {
      console.error('[threads-oauth] Threads user_id 확인 실패');
      return { statusCode: 302, headers: { Location: `https://lumi.it.kr${returnTo}?threads_oauth_error=3` } };
    }

    // ────────────────────────────────────────────
    // 5) (이전 'nonce 복원' 단계 — 1.5 단계로 이전됐음. 코드 리뷰 #5)
    // ────────────────────────────────────────────

    // ────────────────────────────────────────────
    // 6) 기존 ig_accounts row 확인 — IG 연동 필수 전제.
    //    M1 범위: ig_accounts row 없으면(=IG 미연동) Threads 연동 불가.
    //    상세 사유는 파일 상단 주석 '제약 (M1)' 참고.
    // ────────────────────────────────────────────
    const { data: existingRow } = await supabase
      .from('ig_accounts')
      .select('ig_user_id, threads_token_secret_id')
      .eq('user_id', userId)
      .maybeSingle();

    if (!existingRow) {
      console.warn('[threads-oauth] IG 미연동 사장님 — Threads 연동 차단');
      return { statusCode: 302, headers: { Location: `https://lumi.it.kr${returnTo}?threads_oauth_error=10` } };
    }

    // ────────────────────────────────────────────
    // 7) Vault RPC 로 토큰 암호화 저장
    // ────────────────────────────────────────────
    const { data: threadsSecretId, error: secretErr } = await supabase.rpc('set_threads_token', {
      p_user_id: userId,
      p_existing_secret: existingRow.threads_token_secret_id ?? null,
      p_token: longToken,
    });
    if (secretErr) {
      console.error('[threads-oauth] set_threads_token RPC 실패:', secretErr.message);
      return { statusCode: 302, headers: { Location: `https://lumi.it.kr${returnTo}?threads_oauth_error=6` } };
    }

    // ────────────────────────────────────────────
    // 8) ig_accounts UPDATE (threads_* 컬럼만)
    // ────────────────────────────────────────────
    const nowIso = new Date().toISOString();
    const { error: upsertErr } = await supabase
      .from('ig_accounts')
      .update({
        threads_user_id:           resolvedThreadsUserId,
        threads_token_secret_id:   threadsSecretId,
        threads_token_expires_at:  expiresAt,
        threads_token_invalid_at:  null,
        updated_at:                nowIso,
      })
      .eq('user_id', userId);

    if (upsertErr) {
      console.error('[threads-oauth] ig_accounts update 실패:', upsertErr.message);
      return { statusCode: 302, headers: { Location: `https://lumi.it.kr${returnTo}?threads_oauth_error=5` } };
    }

    // 토큰/secret_id 는 절대 로그에 남기지 않음. threads_user_id 만.
    console.log('[threads-oauth] Threads 연동 완료. threads_user_id:', resolvedThreadsUserId);

    return { statusCode: 302, headers: { Location: `https://lumi.it.kr${returnTo}?threads=connected` } };

  } catch (e) {
    console.error('[threads-oauth] OAuth 처리 오류:', e.message);
    return { statusCode: 302, headers: { Location: `https://lumi.it.kr${returnTo}?threads_oauth_error=99` } };
  }
};
