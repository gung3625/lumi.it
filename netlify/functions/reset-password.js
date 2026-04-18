const { getAdminClient } = require('./_shared/supabase-admin');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const { email, password, otpToken } = body;
  if (!email || !password) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: '필수 정보가 없습니다.' }) };
  if (!otpToken) return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'OTP 인증이 필요합니다.' }) };

  const pwRegex = /^(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{10,}$/;
  if (!pwRegex.test(password)) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: '비밀번호는 특수문자를 포함한 10자 이상이어야 합니다.' }) };

  const supabase = getAdminClient();

  try {
    // 1) OTP 토큰 검증 (oauth_nonces에 저장된 otp-verified:* 엔트리)
    const verifiedKey = 'otp-verified:' + email;
    const { data: row } = await supabase
      .from('oauth_nonces')
      .select('nonce, lumi_token')
      .eq('nonce', verifiedKey)
      .maybeSingle();

    if (!row || !row.lumi_token) {
      return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'OTP 인증을 먼저 완료해주세요.' }) };
    }
    let saved;
    try { saved = JSON.parse(row.lumi_token); } catch { saved = null; }
    if (!saved || saved.token !== otpToken) {
      return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'OTP 인증 정보가 유효하지 않습니다.' }) };
    }
    if (saved.expiresAt && Date.now() > saved.expiresAt) {
      await supabase.from('oauth_nonces').delete().eq('nonce', verifiedKey);
      return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'OTP 인증이 만료됐습니다. 다시 인증해주세요.' }) };
    }

    // 2) email → userId 조회 (public.users 먼저, 없으면 auth.admin.listUsers 폴백)
    let userId = null;
    try {
      const { data: profile } = await supabase
        .from('users')
        .select('id')
        .eq('email', email)
        .maybeSingle();
      if (profile) userId = profile.id;
    } catch (e) { /* noop */ }

    if (!userId) {
      try {
        // listUsers는 email 필터가 공식 지원되지 않으므로 페이지 검색
        const { data: list } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
        const match = (list && list.users || []).find(u => (u.email || '').toLowerCase() === email.toLowerCase());
        if (match) userId = match.id;
      } catch (e) { /* noop */ }
    }

    if (!userId) {
      return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: '가입되지 않은 이메일입니다.' }) };
    }

    // 3) Supabase Auth 비밀번호 업데이트
    const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, { password });
    if (updateErr) {
      console.error('[reset-password] updateUserById error:', updateErr.message);
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: '비밀번호 변경 중 오류가 발생했습니다.' }) };
    }

    // 4) OTP 인증 토큰 일회용 삭제
    try { await supabase.from('oauth_nonces').delete().eq('nonce', verifiedKey); } catch (e) {}

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ success: true, message: '비밀번호가 변경됐어요.' }) };
  } catch (err) {
    console.error('reset-password error:', err && err.message);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: '비밀번호 변경 중 오류가 발생했습니다.' }) };
  }
};
