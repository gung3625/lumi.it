// 카카오 OAuth 콜백 핸들러
// GET /api/auth/kakao/callback?code=XXX
// 1. code → 카카오 access_token 교환
// 2. access_token → 사용자 정보 조회
// 3. Supabase 유저 upsert + magic link 세션 생성
// 4. / 로 302 리다이렉트 (URL fragment에 Supabase 세션 포함)
const { getAdminClient } = require('./_shared/supabase-admin');

const KAKAO_TOKEN_URL = 'https://kauth.kakao.com/oauth/token';
const KAKAO_USER_URL = 'https://kapi.kakao.com/v2/user/me';
const REDIRECT_URI = 'https://lumi.it.kr/api/auth/kakao/callback';

function errorRedirect(message) {
  const encoded = encodeURIComponent(message);
  return {
    statusCode: 302,
    headers: { Location: `/?error=${encoded}` },
    body: '',
  };
}

exports.handler = async (event) => {
  const _t0 = Date.now();
  const { code, state } = event.queryStringParameters || {};

  if (!code) {
    return errorRedirect('카카오 인증 코드가 없습니다.');
  }

  // H1 — CSRF: state nonce 검증 (oauth_nonces 테이블, 'kakao:' prefix, 10분 TTL, 일회용)
  // 32 hex 형식의 nonce만 검증 대상. 'signup' 같은 정적 state는 레거시 호환을 위해 통과
  // (auth-kakao-start.js 경유로 state=nonce를 발급받는 흐름이 신규 표준)
  let resolvedIntent = null;
  if (state && /^[a-f0-9]{32}$/i.test(state)) {
    try {
      const adminInit = getAdminClient();
      const nonceKey = 'kakao:' + state;
      const { data: nonceRow } = await adminInit
        .from('oauth_nonces')
        .select('user_id, lumi_token, created_at')
        .eq('nonce', nonceKey)
        .maybeSingle();

      if (!nonceRow) {
        console.error('[auth-kakao-callback] nonce not found in DB — CSRF check failed');
        return errorRedirect('인증 세션이 만료됐어요. 다시 시도해 주세요.');
      }

      // DB에 nonce 있음 — 만료 체크(10분) + 일회용 삭제 후 intent 복원
      const ageMs = Date.now() - new Date(nonceRow.created_at).getTime();
      await adminInit.from('oauth_nonces').delete().eq('nonce', nonceKey);
      if (ageMs > 10 * 60 * 1000) {
        console.error('[auth-kakao-callback] nonce 만료');
        return errorRedirect('인증 시간이 만료됐어요. 다시 시도해 주세요.');
      }
      try {
        const meta = nonceRow.lumi_token ? JSON.parse(nonceRow.lumi_token) : null;
        if (meta && meta.intent) resolvedIntent = String(meta.intent);
      } catch (_) { /* ignore parse error */ }
    } catch (e) {
      console.error('[auth-kakao-callback] nonce 조회 예외:', e.message);
      return errorRedirect('인증 세션 확인 중 오류가 발생했어요. 다시 시도해 주세요.');
    }
  }

  try {
    // 1. code → access_token 교환
    const tokenRes = await fetch(KAKAO_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.KAKAO_CLIENT_ID,
        client_secret: process.env.KAKAO_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        code,
      }),
    });

    if (!tokenRes.ok) {
      // H2 — 외부 응답 본문은 서버 로그에만, 사용자 redirect URL에는 노출 X (XSS·정보누출 방지)
      const errBody = await tokenRes.text().catch(() => '');
      console.error('[auth-kakao-callback] 토큰 교환 실패:', tokenRes.status, errBody);
      return errorRedirect('카카오 토큰 교환 실패. 다시 시도해 주세요.');
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      console.error('[auth-kakao-callback] access_token 누락');
      return errorRedirect('카카오 로그인 처리 중 오류가 발생했습니다.');
    }

    console.log('[timing] step1 token:', Date.now() - _t0, 'ms');

    // 2. 사용자 정보 조회
    const userRes = await fetch(KAKAO_USER_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!userRes.ok) {
      console.error('[auth-kakao-callback] 사용자 정보 조회 실패:', userRes.status);
      return errorRedirect('카카오 사용자 정보를 가져올 수 없습니다.');
    }

    const kakaoUser = await userRes.json();
    const kakaoId = String(kakaoUser.id);
    const kakaoAccount = kakaoUser.kakao_account || {};
    const profile = kakaoAccount.profile || {};

    const email = kakaoAccount.email || `kakao_${kakaoId}@lumi.it.kr`;
    // 카카오 승인 scope = name (profile_nickname은 '사용 안 함' 상태)
    const name = kakaoAccount.name || profile.nickname || '';
    const ageRange = kakaoAccount.age_range || '';
    const gender = kakaoAccount.gender || '';
    const phoneNumber = kakaoAccount.phone_number || '';

    console.log('[timing] step2 userinfo:', Date.now() - _t0, 'ms');

    // 3. Supabase 유저 upsert
    const admin = getAdminClient();

    // 기존 유저 확인 — public.users 직접 조회 (페이지네이션 없이 O(1))
    // 1) public.users에서 email로 빠르게 조회 (kakao_id 컬럼 미존재 가정 — email 단일 조회)
    // 2) 미발견 시 getUserByEmail 시도 (Critical #5 방어)
    // 3) 마지막 fallback — listUsers 1페이지 (회귀 방지)
    let existingUser = null;
    try {
      const { data: row } = await admin
        .from('users')
        .select('id, email')
        .eq('email', email)
        .maybeSingle();
      if (row) {
        const { data: authData } = await admin.auth.admin.getUserById(row.id);
        if (authData?.user) existingUser = authData.user;
      }
    } catch (e) {
      console.error('[auth-kakao-callback] public.users 조회 실패:', e.message);
    }

    if (!existingUser) {
      try {
        if (typeof admin.auth.admin.getUserByEmail === 'function') {
          const { data } = await admin.auth.admin.getUserByEmail(email);
          if (data?.user) existingUser = data.user;
        }
      } catch (_) {}
    }

    if (!existingUser) {
      try {
        const { data: pageData } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
        const users = pageData?.users || [];
        existingUser = users.find(
          (u) => u.email === email || (u.user_metadata && u.user_metadata.kakao_id === kakaoId)
        ) || null;
      } catch (e) {
        console.error('[auth-kakao-callback] listUsers fallback 실패:', e.message);
      }
    }
    console.log('[timing] step3 usercheck:', Date.now() - _t0, 'ms');

    let userId;
    let isNewUser = false;

    if (existingUser) {
      userId = existingUser.id;
      // 매 로그인마다 동일한 값으로 user_metadata를 덮어쓰던 호출 제거 (성능 최적화)
      // 카카오 정보 변경이 필요하면 별도 settings 흐름에서 처리
    } else {
      // 신규 유저 생성 — 동시 콜백 race condition 대비 중복 충돌 방어
      let newUser = null;
      let createErr = null;
      try {
        const { data, error } = await admin.auth.admin.createUser({
          email,
          email_confirm: true,
          user_metadata: {
            kakao_id: kakaoId,
            name,
            phone: phoneNumber,
            age_range: ageRange,
            gender,
            provider: 'kakao',
          },
        });
        newUser = data;
        createErr = error;
      } catch (e) {
        createErr = e;
      }

      // 중복 충돌 (already exists / duplicate) 시 한 번 더 조회로 복구
      if (createErr && /already|duplicate|exists/i.test(createErr.message || '')) {
        try {
          const { data: pageData } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
          const users = pageData?.users || [];
          const found = users.find((u) => u.email === email);
          if (found) {
            existingUser = found;
            userId = found.id;
            createErr = null;
            newUser = null;
          }
        } catch (_) {}
      }

      if (!existingUser) {
        if (createErr || !newUser?.user) {
          console.error('[auth-kakao-callback] 유저 생성 실패:', createErr?.message);
          return errorRedirect('계정 생성 중 오류가 발생했습니다.');
        }
        userId = newUser.user.id;
        isNewUser = true;
      }
    }

    // public.users 동기화 (reservations FK 보장 — 신규/기존 유저 모두)
    try {
      await admin.from('users').upsert({
        id: userId,
        email,
      }, { onConflict: 'id' });
    } catch (e) {
      console.error('[auth-kakao-callback] public.users upsert 실패:', e.message);
    }

    // 4. Magic link 생성 → 세션 발급 (신규=가입 흐름, 기존+onboarded=대시보드 직행)
    // state='signup' (레거시) 또는 nonce row의 intent='signup'이면 기존 유저도 signup 흐름
    // 홈 깜빡임 방지: onboarded 기존 유저는 / 거치지 않고 /dashboard.html로 직접 redirect
    const fromSignup = state === 'signup' || resolvedIntent === 'signup';
    const existingMeta = (existingUser && existingUser.user_metadata) || {};
    const isOnboarded = existingMeta.onboarded === true ||
      (existingMeta.business_no && existingMeta.consent_terms);
    let afterAuth;
    if (isNewUser || fromSignup || !isOnboarded) {
      afterAuth = 'https://lumi.it.kr/signup';
    } else {
      afterAuth = 'https://lumi.it.kr/dashboard.html';
    }
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: afterAuth },
    });

    if (linkErr || !linkData?.properties) {
      console.error('[auth-kakao-callback] magic link 생성 실패:', linkErr?.message);
      return errorRedirect('로그인 세션 생성 중 오류가 발생했습니다.');
    }

    // Supabase magic link의 action_link에서 토큰 추출 후 프론트로 전달
    const actionLink = linkData.properties.action_link || '';
    // action_link 자체로 리다이렉트 (Supabase가 세션 처리 후 / 로 돌아옴)
    if (actionLink) {
      console.log('[timing] step4 magiclink total:', Date.now() - _t0, 'ms');
      console.log('[auth-kakao-callback] 로그인 완료, 리다이렉트');
      return {
        statusCode: 302,
        headers: { Location: actionLink },
        body: '',
      };
    }

    return errorRedirect('로그인 링크 생성에 실패했습니다.');
  } catch (err) {
    // H2 — 예외 메시지를 사용자 redirect URL에 노출 X (XSS·정보누출 방지)
    console.error('[auth-kakao-callback] 예외:', err.message, err.stack);
    return errorRedirect('카카오 로그인 처리 중 오류가 발생했어요. 다시 시도해 주세요.');
  }
};
