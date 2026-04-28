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
  const { code, state } = event.queryStringParameters || {};

  if (!code) {
    return errorRedirect('카카오 인증 코드가 없습니다.');
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
      const errBody = await tokenRes.text().catch(() => '');
      console.error('[auth-kakao-callback] 토큰 교환 실패:', tokenRes.status, errBody);
      return errorRedirect(`카카오 토큰 교환 실패 (${tokenRes.status}): ${errBody.slice(0, 200)}`);
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      console.error('[auth-kakao-callback] access_token 누락');
      return errorRedirect('카카오 로그인 처리 중 오류가 발생했습니다.');
    }

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

    // 3. Supabase 유저 upsert
    const admin = getAdminClient();

    // 기존 유저 확인 (페이지네이션 루프 — 51번째 이후 가입자 누락 방지)
    let allUsers = [];
    let page = 1;
    while (true) {
      const { data: pageData, error: listErr } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (listErr || !pageData?.users?.length) break;
      allUsers = allUsers.concat(pageData.users);
      if (pageData.users.length < 200) break;
      page++;
      if (page > 50) break; // 안전 limit (10,000명)
    }
    const existingUser = allUsers.find(
      (u) => u.email === email || (u.user_metadata && u.user_metadata.kakao_id === kakaoId)
    );

    let userId;
    let isNewUser = false;

    if (existingUser) {
      userId = existingUser.id;
      // 메타데이터 업데이트
      await admin.auth.admin.updateUserById(userId, {
        user_metadata: {
          ...existingUser.user_metadata,
          kakao_id: kakaoId,
          name,
          phone: phoneNumber,
          age_range: ageRange,
          gender,
          provider: 'kakao',
        },
      });
    } else {
      // 신규 유저 생성
      const { data: newUser, error: createErr } = await admin.auth.admin.createUser({
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

      if (createErr || !newUser?.user) {
        console.error('[auth-kakao-callback] 유저 생성 실패:', createErr?.message);
        return errorRedirect('계정 생성 중 오류가 발생했습니다.');
      }

      userId = newUser.user.id;
      isNewUser = true;
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

    // 4. Magic link 생성 → 세션 발급 (신규=가입 흐름, 기존=대시보드)
    // state='signup'이면 기존 유저도 signup으로 → 온보딩 상태 재확인
    const fromSignup = state === 'signup';
    const afterAuth = (isNewUser || fromSignup) ? 'https://lumi.it.kr/signup' : 'https://lumi.it.kr/';
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
      console.log('[auth-kakao-callback] 로그인 완료, 리다이렉트');
      return {
        statusCode: 302,
        headers: { Location: actionLink },
        body: '',
      };
    }

    return errorRedirect('로그인 링크 생성에 실패했습니다.');
  } catch (err) {
    console.error('[auth-kakao-callback] 예외:', err.message, err.stack);
    return errorRedirect(`카카오 처리 예외: ${(err.message || 'unknown').slice(0, 200)}`);
  }
};
