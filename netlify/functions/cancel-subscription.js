// 구독 해지
// Supabase Bearer 토큰 검증 → public.users.auto_renew=false (plan 유지: 기간 끝까지 이용)
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Bearer 토큰 검증
  const token = extractBearerToken(event);
  if (!token) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    console.warn('[cancel-subscription] 토큰 검증 실패');
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증에 실패했습니다.' }) };
  }

  const admin = getAdminClient();

  try {
    // 회원 조회
    const { data: profile, error: fetchErr } = await admin
      .from('users')
      .select('id, email, name, store_name, plan, auto_renew, trial_start')
      .eq('id', user.id)
      .single();

    if (fetchErr || !profile) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '회원 정보를 찾을 수 없습니다.' }) };
    }

    if (!profile.plan || profile.plan === 'trial' || profile.plan === 'free') {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '활성 구독이 없습니다.' }) };
    }

    const { error: updateErr } = await admin
      .from('users')
      .update({
        plan: 'free',
        auto_renew: false,
      })
      .eq('id', user.id);

    if (updateErr) {
      console.error('[cancel-subscription] users update 오류:', updateErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '처리 중 오류가 발생했습니다.' }) };
    }

    // 이탈 방지 이메일 발송
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    if (RESEND_API_KEY && profile.email) {
      try {
        const userName = profile.name || profile.store_name || '사장님';
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + RESEND_API_KEY },
          body: JSON.stringify({
            from: 'lumi <no-reply@lumi.it.kr>',
            to: [profile.email],
            subject: `(광고) ${esc(userName)}님, 정말 떠나시는 건가요?`,
            html: `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"></head><body style="margin:0;padding:0;background:#f9f9f9;font-family:-apple-system,sans-serif;"><div style="max-width:560px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);"><div style="background:#C8507A;padding:32px 40px;text-align:center;"><img src="https://lumi.it.kr/assets/logo.png" alt="lumi" style="height:48px;"></div><div style="padding:40px;"><h2 style="margin:0 0 12px;color:#111;font-size:22px;font-weight:800;">${esc(userName)}님, 아쉬워요</h2><p style="margin:0 0 24px;color:#555;font-size:15px;line-height:1.7;">구독 취소가 완료됐어요.<br>자동 갱신이 해제돼 다음 결제 주기부터는 청구되지 않아요.</p><div style="background:#fff0f6;border-radius:12px;padding:20px 24px;margin-bottom:28px;"><p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#C8507A;">혹시 이런 이유였나요?</p><p style="margin:0;font-size:14px;color:#555;line-height:1.7;">• 캡션 퀄리티가 기대에 못 미쳤다면 → 말투 학습 피드백을 남겨주세요<br>• 가격이 부담이었다면 → 다른 플랜을 검토해보세요<br>• 사용법을 잘 모르겠다면 → 1:1 도움 드릴게요</p></div><div style="text-align:center;"><a href="https://lumi.it.kr/support" style="display:inline-block;background:#C8507A;color:#fff;text-decoration:none;padding:14px 36px;border-radius:99px;font-size:15px;font-weight:700;">피드백 남기기</a></div><p style="margin:28px 0 0;font-size:13px;color:#aaa;text-align:center;">마음이 바뀌시면 언제든 다시 구독할 수 있어요.</p></div></div></body></html>`,
          }),
        });
      } catch (e) {
        console.error('[cancel-subscription] 이메일 실패:', e.message);
      }
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        message: '구독이 취소됐어요. 자동 갱신이 해제됐어요.',
      }),
    };

  } catch (err) {
    console.error('[cancel-subscription] error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '처리 중 오류가 발생했습니다.' }) };
  }
};
