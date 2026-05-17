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
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error('[beta-signup] 예외:', e && e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: '서버 오류가 발생했어요.' }) };
  }
};

function bad(headers, msg) {
  return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: msg }) };
}
