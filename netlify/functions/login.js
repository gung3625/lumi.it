const { getAdminClient } = require('./_shared/supabase-admin');
const { corsHeaders, getOrigin } = require('./_shared/auth');

// H5 — CORS는 handler 안에서 동적 origin 화이트리스트 적용 (corsHeaders + getOrigin)

// fail-closed 전환: 정상 쿼리 실패 시 1회 재시도 후에도 실패하면 차단.
// 공격자가 rate_limits 테이블을 DOS해서 무제한 요청을 통과시키는 것 방지.
async function checkRateLimit(supabase, kind, ip, { windowSeconds = 600, max = 10 } = {}) {
  const nowIso = new Date().toISOString();
  async function runOnce() {
    const { data: existing, error: selErr } = await supabase
      .from('rate_limits')
      .select('count, first_at')
      .eq('kind', kind)
      .eq('ip', ip)
      .maybeSingle();
    if (selErr) throw selErr;

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
  }

  try {
    return await runOnce();
  } catch (e1) {
    console.error(`[rate-limit:${kind}] 1차 실패, 재시도:`, e1.message);
    try {
      return await runOnce();
    } catch (e2) {
      console.error(`[rate-limit:${kind}] 2차 실패 — fail-closed 차단:`, e2.message);
      return { ok: false, count: 0, failClosed: true };
    }
  }
}

function toSafeUser(profile, hasIg) {
  return {
    name: profile.name,
    storeName: profile.store_name,
    instagram: profile.instagram_handle || '',
    email: profile.email,
    phone: profile.phone || '',
    birthdate: profile.birthdate || '',
    gender: profile.gender || '',
    storeDesc: profile.store_desc || '',
    region: profile.region || '',
    sidoCode: profile.sido_code || '',
    sigunguCode: profile.sigungu_code || '',
    storeSido: profile.store_sido || '',
    bizCategory: profile.biz_category,
    captionTone: profile.caption_tone,
    tagStyle: profile.tag_style,
    customCaptions: profile.custom_captions || [],
    agreeMarketing: profile.agree_marketing === true,
    agreeMarketingAt: profile.agree_marketing_at || null,
    plan: profile.plan,
    trialStart: profile.trial_start,
    autoRenew: profile.auto_renew === true,
    autoStory: profile.auto_story === true,
    autoFestival: profile.auto_festival === true,
    igConnected: !!hasIg,
  };
}

exports.handler = async (event) => {
  const CORS = { ...corsHeaders(getOrigin(event)), 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabase = getAdminClient();
  const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || 'unknown');
  const rl = await checkRateLimit(supabase, 'login', ip, { windowSeconds: 600, max: 10 });
  if (!rl.ok) {
    return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: '로그인 시도가 너무 많습니다. 10분 후 다시 시도해주세요.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const { email, password } = body;
  if (!email || !password) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '이메일과 비밀번호를 입력하세요.' }) };
  }

  // 계정 열거 방지: 이메일 존재/비번 불일치 모두 동일한 401 메시지로 통일.
  // 타이밍 공격 방지: 계정 조회와 인증 요청을 병렬 실행 → 응답 시간 편차 최소화.
  const AUTH_ERROR_BODY = JSON.stringify({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });

  try {
    // 1) 인증 + 프로필 조회 병렬 실행 (존재 여부에 관계없이 양쪽 호출 → timing 균등화)
    const [signInResult, profileResult] = await Promise.all([
      supabase.auth.signInWithPassword({ email, password }),
      supabase.from('users').select('*').eq('email', email).maybeSingle(),
    ]);

    const { data: signInData, error: signInErr } = signInResult;
    const { data: profile, error: profileErr } = profileResult;

    if (profileErr) {
      console.error('[login] users select error:', profileErr.message);
    }

    // 계정 없음 OR 비번 틀림 → 동일 응답 (enumeration 방지)
    if (!profile || signInErr || !signInData || !signInData.session) {
      return { statusCode: 401, headers: CORS, body: AUTH_ERROR_BODY };
    }

    const token = signInData.session.access_token;
    const refreshToken = signInData.session.refresh_token;

    // 2) IG 연동 여부 조회
    let hasIg = false;
    try {
      const { data: ig } = await supabase
        .from('ig_accounts')
        .select('ig_user_id')
        .eq('user_id', profile.id)
        .maybeSingle();
      hasIg = !!ig;
    } catch (e) { /* noop */ }

    const safeUser = toSafeUser(profile, hasIg);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, token, refreshToken, user: safeUser })
    };
  } catch (err) {
    console.error('login error:', err && err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '로그인 처리 중 오류가 발생했습니다.' }) };
  }
};
