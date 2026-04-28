const { getAdminClient } = require('./_shared/supabase-admin');
const { corsHeaders, getOrigin } = require('./_shared/auth');

function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

// H5 — CORS는 handler 안에서 동적 origin 화이트리스트 적용

// IP 기반 rate-limit: public.rate_limits 테이블 업서트 후 count 검사
async function checkRateLimit(supabase, kind, ip, { windowSeconds = 600, max = 5 } = {}) {
  const nowIso = new Date().toISOString();
  try {
    const { data: existing } = await supabase
      .from('rate_limits')
      .select('count, first_at')
      .eq('kind', kind)
      .eq('ip', ip)
      .maybeSingle();

    if (existing) {
      const age = (Date.now() - new Date(existing.first_at).getTime()) / 1000;
      if (age > windowSeconds) {
        await supabase.from('rate_limits')
          .update({ count: 1, first_at: nowIso, last_at: nowIso })
          .eq('kind', kind).eq('ip', ip);
        return { ok: true, count: 1 };
      }
      const nextCount = existing.count + 1;
      await supabase.from('rate_limits')
        .update({ count: nextCount, last_at: nowIso })
        .eq('kind', kind).eq('ip', ip);
      return { ok: nextCount <= max, count: nextCount };
    }
    await supabase.from('rate_limits').insert({ kind, ip, count: 1, first_at: nowIso, last_at: nowIso });
    return { ok: true, count: 1 };
  } catch (e) {
    // rate-limit 저장 실패해도 요청은 통과시킴 (fail-open)
    return { ok: true, count: 0 };
  }
}

exports.handler = async (event) => {
  const CORS = { ...corsHeaders(getOrigin(event)), 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabase = getAdminClient();
  const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || 'unknown');
  const rl = await checkRateLimit(supabase, 'register', ip, { windowSeconds: 600, max: 5 });
  if (!rl.ok) {
    return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: '가입 시도가 너무 많습니다. 10분 후 다시 시도해주세요.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const { name, storeName, instagram, email, phone, password, birthdate, gender, storeDesc, region, sidoCode, sigunguCode, storeSido, bizCategory, captionTone, tagStyle, agreeMarketing, otpToken } = body;

  if (!name || !storeName || !email || !password) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '필수 정보가 누락됐습니다.' }) };
  }

  if (birthdate) {
    const bdRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!bdRegex.test(birthdate)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '생년월일 형식이 올바르지 않습니다. (YYYY-MM-DD)' }) };
    }
  }

  const pwRegex = /^(?=.*[!@#$%^&*()_+\-=\[\]{};':"\|,.<>\/?]).{10,}$/;
  if (!pwRegex.test(password)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '비밀번호는 특수문자를 포함한 10자리 이상이어야 합니다.' }) };
  }

  if (!otpToken) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '이메일 인증이 필요합니다.' }) };
  }

  const verifiedKey = 'otp-verified:' + email;
  const { data: nonceRow } = await supabase.from('oauth_nonces').select('lumi_token').eq('nonce', verifiedKey).maybeSingle();
  if (!nonceRow) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '이메일 인증이 만료되었습니다. 다시 인증해주세요.' }) };
  }
  let nonceData;
  try { nonceData = JSON.parse(nonceRow.lumi_token); } catch {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '이메일 인증이 만료되었습니다. 다시 인증해주세요.' }) };
  }
  if (nonceData.token !== otpToken || nonceData.expiresAt < Date.now()) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '이메일 인증이 만료되었습니다. 다시 인증해주세요.' }) };
  }
  await supabase.from('oauth_nonces').delete().eq('nonce', verifiedKey);

  try {
    // 1) Supabase Auth 계정 생성
    const { data: createData, error: createErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,  // OTP 플로우를 이미 거친 상태라고 가정 — 프론트에서 OTP 검증 후 호출
      user_metadata: { name, storeName },
    });

    if (createErr) {
      const msg = String(createErr.message || '');
      if (/already|registered|exists/i.test(msg)) {
        return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: '이미 가입된 이메일입니다.' }) };
      }
      console.error('[register] auth.admin.createUser error:', msg);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '가입 처리 중 오류가 발생했습니다.' }) };
    }

    const authUser = createData.user;
    const userId = authUser.id;

    // 2) public.users 프로필 insert
    const instaHandle = (instagram || '').replace('@', '').toLowerCase() || null;
    const profileRow = {
      id: userId,
      email,
      name,
      store_name: storeName,
      phone: phone || null,
      birthdate: birthdate || null,
      gender: gender || null,
      instagram_handle: instaHandle,
      store_desc: storeDesc || null,
      region: region || null,
      sido_code: sidoCode || null,
      sigungu_code: sigunguCode || null,
      store_sido: storeSido || null,
      biz_category: bizCategory || 'cafe',
      caption_tone: captionTone || 'warm',
      tag_style: tagStyle || 'mid',
      agree_marketing: agreeMarketing === true,
      agree_marketing_at: agreeMarketing === true ? new Date().toISOString() : null,
      // 베타 테스터 기간: 가입 시 전원 'pro' 부여 (정식 오픈 시 'trial'로 되돌릴 것)
      plan: 'pro',
      trial_start: new Date().toISOString(),
      auto_renew: true,
    };

    const { error: insertErr } = await supabase.from('users').insert(profileRow);
    if (insertErr) {
      // instagram_handle UNIQUE 충돌 등 — auth 유저 롤백
      console.error('[register] users insert error:', insertErr.message);
      try { await supabase.auth.admin.deleteUser(userId); } catch (e) {}
      if (/duplicate|unique/i.test(insertErr.message || '')) {
        return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: '이미 사용 중인 인스타그램 아이디입니다.' }) };
      }
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '가입 처리 중 오류가 발생했습니다.' }) };
    }

    // 3) 세션 발급 (access_token 반환을 위해 비밀번호로 로그인)
    const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
    if (signInErr || !signInData || !signInData.session) {
      console.error('[register] signInWithPassword error:', signInErr && signInErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '세션 생성 중 오류가 발생했습니다.' }) };
    }

    const token = signInData.session.access_token;
    const refreshToken = signInData.session.refresh_token;
    const safeUser = {
      name: profileRow.name,
      storeName: profileRow.store_name,
      instagram: profileRow.instagram_handle || '',
      email: profileRow.email,
      phone: profileRow.phone || '',
      birthdate: profileRow.birthdate || '',
      gender: profileRow.gender || '',
      storeDesc: profileRow.store_desc || '',
      region: profileRow.region || '',
      sidoCode: profileRow.sido_code || '',
      sigunguCode: profileRow.sigungu_code || '',
      storeSido: profileRow.store_sido || '',
      bizCategory: profileRow.biz_category,
      captionTone: profileRow.caption_tone,
      tagStyle: profileRow.tag_style,
      agreeMarketing: profileRow.agree_marketing,
      agreeMarketingAt: profileRow.agree_marketing_at,
      plan: profileRow.plan,
      trialStart: profileRow.trial_start,
      autoRenew: profileRow.auto_renew,
      igConnected: false,
    };

    // 4) Resend 웰컴 메일 (기존 그대로)
    try {
      const RESEND_API_KEY = process.env.RESEND_API_KEY;
      if (RESEND_API_KEY) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + RESEND_API_KEY
          },
          body: JSON.stringify({
            from: 'lumi <no-reply@lumi.it.kr>',
            to: [email],
            subject: `${name}님, lumi에 오신 걸 환영해요 🎉`,
            html: `
<!DOCTYPE html>
<html lang="ko">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f9f9f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
    <div style="background:#C8507A;padding:32px 40px;text-align:center;">
      <img src="https://lumi.it.kr/assets/logo.png" alt="lumi" style="height:48px;">
    </div>
    <div style="padding:40px;">
      <h2 style="margin:0 0 12px;color:#111;font-size:22px;font-weight:800;">${esc(name)}님, 환영해요!</h2>
      <p style="margin:0 0 24px;color:#555;font-size:15px;line-height:1.7;">lumi 가입이 완료됐어요.<br>이제 사진 한 장만 올리면, 캡션·해시태그·게시까지 자동이에요.</p>
      <div style="background:#fff0f6;border-radius:12px;padding:20px 24px;margin-bottom:28px;">
        <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#C8507A;">첫 번째로 할 일</p>
        <p style="margin:0;font-size:14px;color:#555;line-height:1.7;">📸 대시보드에서 <strong>매장 사진 한 장</strong>을 올려보세요.<br>lumi가 바로 캡션을 만들어 드릴게요.</p>
      </div>
      <div style="text-align:center;">
        <a href="https://lumi.it.kr/dashboard" style="display:inline-block;background:#C8507A;color:#fff;text-decoration:none;padding:14px 36px;border-radius:99px;font-size:15px;font-weight:700;">첫 사진 올리러 가기 →</a>
      </div>
      <p style="margin:28px 0 0;font-size:13px;color:#aaa;text-align:center;">정식 출시 전까지 모든 기능 무료 · 언제든지 탈퇴 가능</p>
    </div>
    <div style="background:#f9f9f9;padding:20px 40px;text-align:center;">
      <p style="margin:0;font-size:12px;color:#bbb;">© 2026 lumi · 서울특별시 용산구 이태원동<br>문의: <a href="https://lumi.it.kr/support" style="color:#C8507A;text-decoration:none;">고객센터</a></p>
    </div>
  </div>
</body>
</html>`
          })
        });
        console.log('[lumi] 웰컴 이메일 발송 완료');
      }
    } catch(emailErr) {
      console.error('[lumi] 웰컴 이메일 발송 실패:', emailErr.message);
    }

    // 5) 솔라피 웰컴 알림톡 (기존 그대로)
    try {
      await fetch('https://lumi.it.kr/.netlify/functions/send-kakao', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-lumi-secret': process.env.LUMI_SECRET
        },
        body: JSON.stringify({
          type: 'welcome',
          to: phone,
          variables: { '#{이름}': name }
        })
      });
      console.log('[lumi] 웰컴 알림톡 발송 완료');
    } catch(kakaoErr) {
      console.error('[lumi] 웰컴 알림톡 발송 실패:', kakaoErr.message);
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, token, refreshToken, user: safeUser })
    };
  } catch (err) {
    console.error('register error:', err && err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '가입 처리 중 오류가 발생했습니다.' }) };
  }
};
