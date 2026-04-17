const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 600000, 64, 'sha512').toString('hex');
  return salt + ':' + hash;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // IP rate limit: 10분 내 5회 제한
  const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || 'unknown');
  try {
    const rlStore = getStore({ name: 'rate-limit', consistency: 'strong', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });
    const rlKey = 'register:' + ip;
    const rlRaw = await rlStore.get(rlKey).catch(() => null);
    const rl = rlRaw ? JSON.parse(rlRaw) : { count: 0, firstAt: Date.now() };
    if (Date.now() - rl.firstAt > 600000) { rl.count = 0; rl.firstAt = Date.now(); }
    rl.count++;
    await rlStore.set(rlKey, JSON.stringify(rl));
    if (rl.count > 5) {
      return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: '가입 시도가 너무 많습니다. 10분 후 다시 시도해주세요.' }) };
    }
  } catch(e) {}

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const { name, storeName, instagram, email, phone, password, birthdate, gender, storeDesc, region, sidoCode, sigunguCode, storeSido, bizCategory, captionTone, tagStyle, agreeMarketing } = body;

  if (!name || !storeName || !email || !password) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '필수 정보가 누락됐습니다.' }) };
  }

  // 생년월일 형식 검사 (선택 필드 — 입력 시만 검사)
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

  try {
    const store = getStore({
      name: 'users', consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN
    });

    let existing;
    try { existing = await store.get('user:' + email); } catch(e) { existing = null; }
    if (existing) {
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: '이미 가입된 이메일입니다.' }) };
    }

    const user = {
      name,
      storeName,
      instagram: instagram.replace('@', ''),
      email,
      phone,
      birthdate,
      gender: gender || '',
      passwordHash: hashPassword(password),
      storeDesc: storeDesc || '',
      region: region || '',
      sidoCode: sidoCode || '',
      sigunguCode: sigunguCode || '',
      storeSido: storeSido || '',
      bizCategory: bizCategory || 'cafe',
      captionTone: captionTone || 'warm',
      tagStyle: tagStyle || 'mid',
      agreeMarketing: agreeMarketing === true,
      agreeMarketingAt: agreeMarketing === true ? new Date().toISOString() : null,
      plan: 'trial',
      trialStart: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      autoRenew: true
    };

    await store.set('user:' + email, JSON.stringify(user));

    // insta: 역조회 키 저장 — get-link-page, update-link-page에서 사용
    const instaId = instagram.replace('@', '').toLowerCase();
    if (instaId) await store.set('insta:' + instaId, email);

    const token = require('crypto').randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await store.set('token:' + token, JSON.stringify({ email, createdAt: new Date().toISOString(), expiresAt }));

    const { passwordHash, ...safeUser } = user;

    // 웰컴 이메일 발송 (Resend)
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
      // 이메일 실패해도 가입은 성공으로 처리
    }

    // 솔라피 웰컴 알림톡 발송
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
      body: JSON.stringify({ success: true, token, user: safeUser })
    };
  } catch (err) {
    console.error('register error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '가입 처리 중 오류가 발생했습니다.' }) };
  }
};
