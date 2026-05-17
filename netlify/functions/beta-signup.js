// beta-signup.js — 루미 베타 사용자 모집 폼 처리.
//
// POST /api/beta-signup
// Body: { storeName, ownerName, category, phone, instagramHandle?, termsAgreed: true }
// 응답: { ok: true } 또는 { ok: false, error: '...' }
//
// 보안 / 안정성:
// - rate-limit: 분당 5건 per IP (악의적 spam 방어)
// - 모든 필드 trim + 길이 제한
// - 휴대폰 형식 검증 (010-xxxx-xxxx 또는 01x-xxx[x]-xxxx)
// - 약관 동의 명시 (termsAgreed === true)
// - 중복 휴대폰 — DB unique index 가 409 반환
//
// 인증 X — 정식 가입 전 사용자 대상.

const { getAdminClient } = require('./_shared/supabase-admin');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { Resend } = require('resend');

const NOTIFY_TO = 'lumi@lumi.it.kr';
const NOTIFY_FROM = 'lumi <noreply@lumi.it.kr>';

function htmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function notifyByEmail({ storeName, ownerName, category, phone, instagram, ip, userAgent, createdAt }) {
  if (!process.env.RESEND_API_KEY) return { skipped: true };
  const resend = new Resend(process.env.RESEND_API_KEY);
  const e = htmlEscape;
  const igCell = instagram
    ? `<a href="https://instagram.com/${e(instagram)}" style="color:#C8507A;text-decoration:none;">@${e(instagram)}</a>`
    : `<span style="color:#888;">(없음)</span>`;
  const html = `
    <div style="font-family:-apple-system,'Pretendard',sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1d1d1f;">
      <h1 style="font-size:20px;font-weight:800;margin:0 0 16px;">새 베타 신청자 — ${e(storeName)}</h1>
      <p style="color:#6e6e73;margin:0 0 20px;font-size:14px;">lumi.it.kr/beta 폼 신청.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:8px 0;width:90px;color:#6e6e73;"><strong>매장 이름</strong></td><td style="padding:8px 0;">${e(storeName)}</td></tr>
        <tr><td style="padding:8px 0;color:#6e6e73;"><strong>대표자</strong></td><td style="padding:8px 0;">${e(ownerName)}</td></tr>
        <tr><td style="padding:8px 0;color:#6e6e73;"><strong>카테고리</strong></td><td style="padding:8px 0;">${e(category)}</td></tr>
        <tr><td style="padding:8px 0;color:#6e6e73;"><strong>휴대폰</strong></td><td style="padding:8px 0;"><a href="tel:${e(phone)}" style="color:#C8507A;text-decoration:none;">${e(phone)}</a></td></tr>
        <tr><td style="padding:8px 0;color:#6e6e73;"><strong>인스타</strong></td><td style="padding:8px 0;">${igCell}</td></tr>
        <tr><td style="padding:8px 0;color:#6e6e73;"><strong>신청 시각</strong></td><td style="padding:8px 0;">${e(createdAt)}</td></tr>
        <tr><td style="padding:8px 0;color:#6e6e73;"><strong>IP</strong></td><td style="padding:8px 0;color:#6e6e73;font-size:12px;">${e(ip || '-')}</td></tr>
      </table>
      <hr style="border:none;border-top:1px solid #e5e5e4;margin:24px 0;">
      <p style="font-size:13px;color:#6e6e73;margin:0;">
        Supabase 콘솔: <a href="https://supabase.com/dashboard/project/cldsozdocxpvkbuxwqep/editor" style="color:#C8507A;">beta_signups 보기</a>
      </p>
    </div>
  `;
  return resend.emails.send({
    from: NOTIFY_FROM,
    to: [NOTIFY_TO],
    subject: `[lumi] 베타 신청 — ${storeName} (${ownerName})`,
    html,
    replyTo: NOTIFY_TO,
  });
}

const MAX = { name: 80, phone: 20, category: 40, instagram: 40 };
const PHONE_RE = /^01[016789]-?\d{3,4}-?\d{4}$/;

const rateBuckets = new Map();
function rateLimit(ip) {
  if (!ip) return true;
  const now = Date.now();
  const b = rateBuckets.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > b.resetAt) { b.count = 0; b.resetAt = now + 60_000; }
  b.count++;
  rateBuckets.set(ip, b);
  if (rateBuckets.size > 500) {
    for (const [k, v] of rateBuckets) if (now > v.resetAt) rateBuckets.delete(k);
  }
  return b.count <= 5;
}

function clean(s, max) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'POST 전용' }) };
  }

  const ip = (event.headers && (event.headers['x-forwarded-for'] || '').split(',')[0].trim()) || null;
  if (!rateLimit(ip)) {
    return { statusCode: 429, headers, body: JSON.stringify({ ok: false, error: '너무 많은 요청이에요. 잠시 후 다시 시도해주세요.' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: '잘못된 요청' }) };
  }

  const storeName = clean(body.storeName, MAX.name);
  const ownerName = clean(body.ownerName, MAX.name);
  const category  = clean(body.category, MAX.category);
  const phoneRaw  = clean(body.phone, MAX.phone);
  const instagram = clean(body.instagramHandle, MAX.instagram).replace(/^@+/, '');
  const termsAgreed = body.termsAgreed === true;

  if (!storeName) return bad(headers, '매장 이름을 입력해주세요.');
  if (!ownerName) return bad(headers, '대표자 이름을 입력해주세요.');
  if (!category)  return bad(headers, '매장 카테고리를 선택해주세요.');
  if (!phoneRaw)  return bad(headers, '휴대폰 번호를 입력해주세요.');
  // 휴대폰 검증 — '-' 있어도 없어도 OK, 통일 형식으로 정규화
  const phone = phoneRaw.replace(/[^0-9-]/g, '');
  if (!PHONE_RE.test(phone)) return bad(headers, '휴대폰 형식이 올바르지 않아요. (예: 010-1234-5678)');
  if (!termsAgreed) return bad(headers, '개인정보 수집·이용 동의가 필요해요.');

  // 휴대폰 정규화 — 010-xxxx-xxxx 형식 통일 (DB unique 위해)
  const digits = phone.replace(/-/g, '');
  const normalized = digits.length === 11
    ? `${digits.slice(0,3)}-${digits.slice(3,7)}-${digits.slice(7)}`
    : `${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6)}`;

  try {
    const admin = getAdminClient();
    const { error } = await admin.from('beta_signups').insert({
      store_name: storeName,
      owner_name: ownerName,
      category,
      phone: normalized,
      instagram_handle: instagram || null,
      terms_agreed_at: new Date().toISOString(),
      user_agent: (event.headers && event.headers['user-agent']) || null,
      ip_address: ip,
    });
    if (error) {
      // unique violation = 23505 (Postgres) — 같은 휴대폰 중복
      const isDuplicate = error.code === '23505' || /duplicate|unique/i.test(error.message || '');
      if (isDuplicate) {
        return { statusCode: 409, headers, body: JSON.stringify({ ok: false, error: '이미 신청하신 휴대폰 번호예요. 곧 연락드릴게요.' }) };
      }
      console.error('[beta-signup] insert 실패:', error.message);
      return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: '저장에 실패했어요. 잠시 후 다시 시도해주세요.' }) };
    }

    // insert 성공 — lumi@lumi.it.kr 으로 알림 이메일.
    // 이메일 실패해도 사용자에게는 성공 응답 (DB 저장은 됐으니 사장님이 콘솔에서도 볼 수 있음).
    try {
      await notifyByEmail({
        storeName, ownerName, category, phone: normalized, instagram,
        ip, userAgent: (event.headers && event.headers['user-agent']) || '',
        createdAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
      });
    } catch (e) {
      console.error('[beta-signup] 이메일 알림 실패:', e && e.message);
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error('[beta-signup] 예외:', e && e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: '서버 오류가 발생했어요.' }) };
  }
};

function bad(headers, msg) {
  return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: msg }) };
}
