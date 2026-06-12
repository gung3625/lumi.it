// request-ig-help.js — 사장님이 IG 연결에서 막혔을 때 lumi 에 도움 요청.
//
// 2026-05-20 (IG 연결 가이드 보강 #5): signup step 3 또는 settings 의 진단 모달
// 에서 "다 됐는데 안 돼요" 버튼 누르면 본 endpoint 가 lumi@lumi.it.kr 으로 알림 메일
// 발송. 사장님 정보 + 막힌 단계 + 자유 메시지 첨부.
//
// POST /api/request-ig-help
// Auth: Bearer 토큰 (사장님 식별 필수)
// Body: {
//   stage: 'oauth_error_3' | 'signup_step3_stuck' | 'settings_reconnect' | 'other',
//   userSelectedReason?: 'personal-account' | 'no-fb-page' | 'page-not-linked' | 'all-done-still-fails' | 'other',
//   message?: string (최대 500자),
//   contextUrl?: string (사장님 현재 URL — 디버그용)
// }
// 응답: { ok: true } 또는 { ok: false, error: '...' }
//
// 처리:
//   1. me.js 유사 흐름으로 seller 식별 + 매장 정보 조회
//   2. Resend 으로 lumi@lumi.it.kr 에 도움 요청 이메일 발송
//   3. (Optional) lumi 어드민 카톡 알림 — 일단 이메일만 우선
//
// rate-limit: 사장님당 1시간 5건 (memory bucket, beta 30명 안에서 충분)

'use strict';

const { Resend } = require('resend');
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { verifySellerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const NOTIFY_TO = 'lumi@lumi.it.kr';
const NOTIFY_FROM = 'lumi <noreply@lumi.it.kr>';

const STAGE_LABELS = {
  'oauth_error_3': 'OAuth 실패 — 비즈니스 계정 없음 (error=3)',
  'signup_step3_stuck': '회원가입 step 3 에서 막힘',
  'settings_reconnect': 'settings 재연동 시도 중 막힘',
  'other': '기타',
};

const REASON_LABELS = {
  'personal-account': '인스타가 아직 개인 계정',
  'no-fb-page': 'Facebook 페이지가 없음',
  'page-not-linked': '페이지는 있는데 인스타와 연결 안 됨',
  'all-done-still-fails': '다 했는데 연동 안 됨',
  'other': '기타',
};

function htmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
  return b.count <= 5;
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
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: '인증이 필요합니다.' }) };
  }

  if (!rateLimit(userId)) {
    return { statusCode: 429, headers: CORS, body: JSON.stringify({ ok: false, error: '너무 많은 요청이에요. 잠시 후 다시 시도해주세요.' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: '잘못된 요청' }) };
  }

  const stage = (typeof body.stage === 'string' && STAGE_LABELS[body.stage]) ? body.stage : 'other';
  const reason = (typeof body.userSelectedReason === 'string' && REASON_LABELS[body.userSelectedReason]) ? body.userSelectedReason : null;
  const message = (typeof body.message === 'string' ? body.message.trim() : '').slice(0, 500);
  const contextUrl = (typeof body.contextUrl === 'string' ? body.contextUrl.trim() : '').slice(0, 300);

  // seller 정보 조회 — 이름, 매장, 휴대폰
  let sellerInfo = null;
  try {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('sellers')
      .select('id, owner_name, store_name, phone, ig_username, biz_category')
      .eq('id', userId)
      .maybeSingle();
    if (!error && data) sellerInfo = data;
  } catch (e) {
    console.warn('[request-ig-help] seller 조회 실패:', e && e.message);
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[request-ig-help] RESEND_API_KEY 미설정 — 이메일 발송 스킵.', { userId, stage, reason });
    // 사장님에게는 ok 응답 (서버 fail 노출 X) — 어드민이 어차피 log 봄
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  }

  const e = htmlEscape;
  const sellerName = e(sellerInfo?.owner_name || '(이름 미상)');
  const storeName = e(sellerInfo?.store_name || '(매장명 미상)');
  const phone = sellerInfo?.phone || '';
  const igHandle = sellerInfo?.ig_username || '';
  const category = sellerInfo?.biz_category || '';
  const stageLabel = e(STAGE_LABELS[stage] || stage);
  const reasonLabel = reason ? e(REASON_LABELS[reason] || reason) : '<span style="color:#888;">(선택 안 함)</span>';
  const messageEsc = message ? e(message).replace(/\n/g, '<br>') : '<span style="color:#888;">(메시지 없음)</span>';

  const html = `
    <div style="font-family:-apple-system,'Pretendard',sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1d1d1f;">
      <h1 style="font-size:20px;font-weight:800;margin:0 0 16px;color:#c0392b;">🆘 IG 연결 도움 요청 — ${storeName}</h1>
      <p style="color:#6e6e73;margin:0 0 20px;font-size:14px;">사장님이 인스타 연결에서 막혔어요. 카톡 또는 전화로 1:1 도움 부탁드려요.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:8px 0;width:110px;color:#6e6e73;"><strong>매장</strong></td><td style="padding:8px 0;">${storeName}</td></tr>
        <tr><td style="padding:8px 0;color:#6e6e73;"><strong>대표자</strong></td><td style="padding:8px 0;">${sellerName}</td></tr>
        <tr><td style="padding:8px 0;color:#6e6e73;"><strong>카테고리</strong></td><td style="padding:8px 0;">${e(category)}</td></tr>
        <tr><td style="padding:8px 0;color:#6e6e73;"><strong>휴대폰</strong></td><td style="padding:8px 0;"><a href="tel:${e(phone)}" style="color:#C8507A;text-decoration:none;">${e(phone)}</a></td></tr>
        <tr><td style="padding:8px 0;color:#6e6e73;"><strong>인스타 핸들</strong></td><td style="padding:8px 0;">${igHandle ? `<a href="https://instagram.com/${e(igHandle)}" style="color:#C8507A;text-decoration:none;">@${e(igHandle)}</a>` : '<span style="color:#888;">(미입력)</span>'}</td></tr>
        <tr><td style="padding:8px 0;color:#6e6e73;"><strong>막힌 단계</strong></td><td style="padding:8px 0;">${stageLabel}</td></tr>
        <tr><td style="padding:8px 0;color:#6e6e73;"><strong>본인 진단</strong></td><td style="padding:8px 0;">${reasonLabel}</td></tr>
        <tr><td style="padding:8px 0;color:#6e6e73;vertical-align:top;"><strong>메시지</strong></td><td style="padding:8px 0;">${messageEsc}</td></tr>
        ${contextUrl ? `<tr><td style="padding:8px 0;color:#6e6e73;"><strong>URL</strong></td><td style="padding:8px 0;color:#888;font-size:12px;word-break:break-all;">${e(contextUrl)}</td></tr>` : ''}
        <tr><td style="padding:8px 0;color:#6e6e73;"><strong>요청 시각</strong></td><td style="padding:8px 0;color:#888;font-size:12px;">${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC</td></tr>
      </table>
      <hr style="border:none;border-top:1px solid #e5e5e4;margin:24px 0;">
      <p style="font-size:13px;color:#6e6e73;margin:0;">
        Supabase 콘솔: <a href="https://supabase.com/dashboard/project/cldsozdocxpvkbuxwqep/editor" style="color:#C8507A;">sellers 보기</a>
      </p>
    </div>
  `;

  try {
    const resend = new Resend(apiKey);
    await resend.emails.send({
      from: NOTIFY_FROM,
      to: [NOTIFY_TO],
      subject: `[루미] 🆘 IG 연결 도움 요청 — ${sellerInfo?.store_name || '매장'} (${sellerInfo?.owner_name || ''})`,
      html,
      replyTo: NOTIFY_TO,
    });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  } catch (mailErr) {
    console.error('[request-ig-help] 메일 발송 실패:', mailErr && mailErr.message);
    // 사장님에게는 ok 응답 (실패 노출보다 신뢰감)
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  }
};
