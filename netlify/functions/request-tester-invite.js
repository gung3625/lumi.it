// request-tester-invite.js — 베타 사장님이 Meta Tester 초대 요청 보냄.
//
// 2026-05-23 (베타 흐름): 메타 비즈니스 인증 대기 중 — 일반 OAuth 불가능.
// Tester 로 미리 추가된 IG 계정만 권한 받음. 자동화 X — 루미팀(김현)이 메타
// Developer Console 에서 수동으로 Tester 추가해야 함.
// 본 endpoint = 베타 사장님이 본인 IG 핸들 알려주고 추가 요청 보내는 채널.
//
// POST /api/request-tester-invite
// Auth: Bearer 토큰 (사장님 식별 필수)
// Body: {
//   igHandle: string  // @ 없이 순수 username (필수)
//   contextUrl?: string
// }
// 응답: { ok: true, state: 'requested' | 'invited' | 'already_requested' } 또는 { ok: false, error: '...' }
//
// 처리:
//   1. seller 식별 + 매장 정보 조회
//   2. sellers row 업데이트: tester_requested_at = now, tester_requested_ig_handle = igHandle
//      (이미 invited 됐으면 'invited' 응답하고 끝 — 중복 요청 방지)
//   3. Resend 으로 lumi@lumi.it.kr 에 알림 — 사장님이 메타 콘솔에서 처리
//
// rate-limit: 사장님당 1시간 3건 (실수로 여러 번 누르는 케이스 방어)

'use strict';

const { Resend } = require('resend');
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { verifySellerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const NOTIFY_TO = 'lumi@lumi.it.kr';
const NOTIFY_FROM = 'lumi <noreply@lumi.it.kr>';

function htmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// IG 핸들 정규화 — @ 제거, 공백 제거, 소문자
function normalizeIgHandle(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  // URL 형태로 입력했을 가능성 — instagram.com/handle 또는 @handle 또는 handle
  s = s.replace(/^https?:\/\//, '').replace(/^(www\.)?instagram\.com\//, '').replace(/^@/, '').split(/[\/\?#]/)[0];
  return s.toLowerCase();
}

function isValidIgHandle(handle) {
  // IG 룰: 1~30자, 영문 소문자·숫자·언더바·마침표만
  return /^[a-z0-9._]{1,30}$/.test(handle);
}

const rateBuckets = new Map();
function rateLimit(userId) {
  if (!userId) return true;
  const now = Date.now();
  const b = rateBuckets.get(userId) || { count: 0, resetAt: now + 3600_000 };
  if (now > b.resetAt) { b.count = 0; b.resetAt = now + 3600_000; }
  b.count++;
  rateBuckets.set(userId, b);
  if (rateBuckets.size > 500) {
    for (const [k, v] of rateBuckets) if (now > v.resetAt) rateBuckets.delete(k);
  }
  return b.count <= 3;
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ ok: false, error: 'POST 전용' }) };
  }

  const token = extractBearerToken(event);
  let userId = null;
  const { user } = await verifyBearerToken(token);
  if (user && user.id) {
    userId = user.id;
  } else {
    const { payload } = verifySellerToken(token);
    if (payload && payload.seller_id) userId = payload.seller_id;
  }
  if (!userId) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: '로그인이 필요합니다.' }) };
  }

  if (!rateLimit(userId)) {
    return { statusCode: 429, headers: CORS, body: JSON.stringify({ ok: false, error: '너무 많은 요청이에요. 잠시 후 다시 시도해주세요.' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: '잘못된 요청' }) };
  }

  const igHandle = normalizeIgHandle(body.igHandle);
  if (!igHandle) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: '인스타 아이디를 입력해주세요.' }) };
  }
  if (!isValidIgHandle(igHandle)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: '인스타 아이디 형식이 올바르지 않아요. (영문·숫자·_·. 만 허용)' }) };
  }

  const contextUrl = (typeof body.contextUrl === 'string' ? body.contextUrl.trim() : '').slice(0, 300);

  // seller 정보 조회
  const admin = getAdminClient();
  let sellerInfo = null;
  try {
    const { data, error } = await admin
      .from('sellers')
      .select('id, owner_name, store_name, phone, display_name, industry, tester_requested_at, tester_invited_at, tester_requested_ig_handle')
      .eq('id', userId)
      .maybeSingle();
    if (!error && data) sellerInfo = data;
  } catch (e) {
    console.warn('[request-tester-invite] seller 조회 실패:', e && e.message);
  }
  if (!sellerInfo) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ ok: false, error: '계정 정보를 찾을 수 없습니다.' }) };
  }

  // 이미 invited 됐으면 — 새 요청 받지 않음 (이미 OAuth 가능 상태)
  if (sellerInfo.tester_invited_at) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, state: 'invited', message: '이미 테스터로 추가되셨어요. 이제 루미와 연결을 진행하세요.' }) };
  }

  // sellers 업데이트 — 요청 시각·핸들 저장 (덮어쓰기 OK — 사장님이 핸들 잘못 입력하고 재요청 가능)
  const nowIso = new Date().toISOString();
  const isRetry = !!sellerInfo.tester_requested_at;
  try {
    const { error: updErr } = await admin
      .from('sellers')
      .update({
        tester_requested_at: nowIso,
        tester_requested_ig_handle: igHandle,
        updated_at: nowIso,
      })
      .eq('id', userId);
    if (updErr) {
      console.error('[request-tester-invite] sellers UPDATE 실패:', updErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: '요청 저장에 실패했어요. 잠시 후 다시 시도해주세요.' }) };
    }
  } catch (e) {
    console.error('[request-tester-invite] sellers UPDATE 예외:', e && e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: '서버 오류' }) };
  }

  // 이메일 발송 — Resend 가 없으면 skip (DB 저장은 성공)
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[request-tester-invite] RESEND_API_KEY 미설정 — 이메일 스킵', { userId, igHandle });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, state: 'requested' }) };
  }

  const e = htmlEscape;
  const storeName = e(sellerInfo.store_name || sellerInfo.display_name || '(매장명 미상)');
  const ownerName = e(sellerInfo.owner_name || sellerInfo.display_name || '(이름 미상)');
  const phone = sellerInfo.phone || '';
  const category = sellerInfo.industry || '';
  const retryNote = isRetry ? `<p style="margin:0 0 12px;color:#d97706;font-size:13px;">⚠️ 재요청 — 이전 IG 핸들: <code>${e(sellerInfo.tester_requested_ig_handle || '')}</code></p>` : '';

  const html = `
    <div style="font-family:-apple-system,'Pretendard',sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1d1d1f;">
      <h1 style="font-size:20px;font-weight:800;margin:0 0 8px;color:#C8507A;">📨 Meta Tester 초대 요청 — ${storeName}</h1>
      <p style="color:#6e6e73;margin:0 0 16px;font-size:14px;">베타 사장님이 IG OAuth 받으려면 Meta Developer Console 에서 Tester 로 추가해야 합니다.</p>
      ${retryNote}
      <div style="background:#FEF3F2;padding:16px;border-radius:8px;margin:0 0 20px;border-left:3px solid #C8507A;">
        <div style="font-size:13px;color:#6e6e73;margin-bottom:4px;font-weight:600;">처리 절차</div>
        <ol style="margin:0;padding-left:18px;font-size:13px;color:#1d1d1f;line-height:1.7;">
          <li>Meta Developer Console → 루미 앱 → <b>Roles → Roles</b></li>
          <li><b>Add Instagram Testers</b> → 아래 IG 핸들 입력 → Submit</li>
          <li>사장님 IG 알림에 "Lumi 앱 테스터 초대" 도착 → 사장님이 수락</li>
          <li>아래 Supabase 콘솔에서 <code>tester_invited_at = now()</code> 마킹</li>
          <li>사장님에게 카톡·전화 "이제 루미와 연결 진행하세요" 알림</li>
        </ol>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:8px 0;width:110px;color:#6e6e73;"><strong>매장</strong></td><td style="padding:8px 0;">${storeName}</td></tr>
        <tr><td style="padding:8px 0;color:#6e6e73;"><strong>대표자</strong></td><td style="padding:8px 0;">${ownerName}</td></tr>
        <tr><td style="padding:8px 0;color:#6e6e73;"><strong>카테고리</strong></td><td style="padding:8px 0;">${e(category)}</td></tr>
        <tr><td style="padding:8px 0;color:#6e6e73;"><strong>휴대폰</strong></td><td style="padding:8px 0;"><a href="tel:${e(phone)}" style="color:#C8507A;text-decoration:none;">${e(phone)}</a></td></tr>
        <tr><td style="padding:8px 0;color:#6e6e73;"><strong>IG 핸들</strong></td><td style="padding:8px 0;"><a href="https://instagram.com/${e(igHandle)}" style="color:#C8507A;text-decoration:none;font-weight:700;font-size:16px;">@${e(igHandle)}</a> ← 이걸 복사하세요</td></tr>
        <tr><td style="padding:8px 0;color:#6e6e73;"><strong>seller_id</strong></td><td style="padding:8px 0;color:#888;font-size:12px;font-family:monospace;">${e(sellerInfo.id)}</td></tr>
        ${contextUrl ? `<tr><td style="padding:8px 0;color:#6e6e73;"><strong>URL</strong></td><td style="padding:8px 0;color:#888;font-size:12px;word-break:break-all;">${e(contextUrl)}</td></tr>` : ''}
        <tr><td style="padding:8px 0;color:#6e6e73;"><strong>요청 시각</strong></td><td style="padding:8px 0;color:#888;font-size:12px;">${nowIso.replace('T', ' ').slice(0, 19)} UTC</td></tr>
      </table>
      <hr style="border:none;border-top:1px solid #e5e5e4;margin:24px 0;">
      <p style="font-size:13px;color:#6e6e73;margin:0 0 8px;">
        <a href="https://developers.facebook.com/apps/" style="color:#C8507A;font-weight:600;">Meta Developer Console 열기 →</a>
      </p>
      <p style="font-size:13px;color:#6e6e73;margin:0;">
        <a href="https://supabase.com/dashboard/project/cldsozdocxpvkbuxwqep/editor" style="color:#C8507A;">Supabase sellers 보기 →</a>
        (id = <code>${e(sellerInfo.id)}</code> 검색)
      </p>
    </div>
  `;

  try {
    const resend = new Resend(apiKey);
    await resend.emails.send({
      from: NOTIFY_FROM,
      to: [NOTIFY_TO],
      subject: `[루미] 📨 Tester 초대 요청 — ${sellerInfo.store_name || sellerInfo.display_name || '베타 사장님'} (@${igHandle})`,
      html,
      replyTo: NOTIFY_TO,
    });
  } catch (mailErr) {
    console.error('[request-tester-invite] 메일 발송 실패 (DB 는 저장됨):', mailErr && mailErr.message);
    // 사장님에게는 ok 응답 — DB 저장 성공이라 어드민이 직접 발견 가능.
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, state: 'requested' }) };
};
