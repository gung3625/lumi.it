// reply-comment.js — 사장님이 받은 IG 댓글에 답글 작성.
// POST /api/reply-comment
// 헤더: Authorization: Bearer <jwt>
// 본문: { commentId: string, message: string }
//
// 응답:
//   성공:        { ok: true, replyId: "<ig-comment-id>" }
//   토큰 만료:   { ok: false, tokenExpired: true }
//   IG 거부:     { ok: false, error: "<message>" } (status 4xx)
//   서버 오류:   { ok: false, error: "..." } (status 5xx)
//
// 동작:
//  1) JWT 검증 + body 파싱·검증 (commentId 영숫자, message 1~2200자)
//  2) ig_accounts_decrypted 뷰에서 토큰 조회
//  3) IG Graph POST /{commentId}/replies?message=...&access_token=...
//  4) 성공 시 sellers/<id>.json Blobs 캐시 삭제 → 다음 /api/comments 호출은 fresh

'use strict';

const { getStore } = require('@netlify/blobs');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { getAdminClient } = require('./_shared/supabase-admin');
const { getIgTokenForSeller, igGraphRequest, IgGraphError, markIgTokenInvalid } = require('./_shared/ig-graph');

// IG 댓글 id: 보통 긴 숫자 또는 18_숫자 형태. 보수적으로 영숫자/_/- 허용.
const COMMENT_ID_RE = /^[A-Za-z0-9_-]{3,64}$/;
const MAX_MESSAGE_LEN = 2200;
const MIN_MESSAGE_LEN = 1;

function getCacheStore() {
  return getStore({
    name: 'comments',
    consistency: 'eventual',
    siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
    token: process.env.NETLIFY_TOKEN,
  });
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user || !user.id) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: '인증이 필요합니다.' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: '잘못된 요청 본문' }) };
  }

  const commentId = String(body.commentId || '').trim();
  const message = String(body.message || '').trim();

  if (!COMMENT_ID_RE.test(commentId)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: '댓글 ID 형식이 올바르지 않습니다.' }) };
  }
  if (message.length < MIN_MESSAGE_LEN) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: '답글 내용을 입력해주세요.' }) };
  }
  if (message.length > MAX_MESSAGE_LEN) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: `답글은 ${MAX_MESSAGE_LEN}자 이내로 작성해주세요.` }) };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[reply-comment] admin 초기화 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: '서버 오류' }) };
  }

  const igCtx = await getIgTokenForSeller(user.id, admin);
  if (!igCtx) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'IG 연동이 필요합니다.' }) };
  }

  // IG Graph: 답글 작성
  let resp;
  try {
    resp = await igGraphRequest(igCtx.accessToken, `/${commentId}/replies`, { message }, { method: 'POST' });
  } catch (e) {
    if (e instanceof IgGraphError && e.isTokenExpired()) {
      await markIgTokenInvalid(admin, user.id, 'reply-comment');
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, tokenExpired: true }) };
    }
    console.warn('[reply-comment] Graph 호출 실패:', e && e.message);
    const status = (e instanceof IgGraphError && e.status >= 400 && e.status < 500) ? e.status : 502;
    return { statusCode: status, headers: CORS, body: JSON.stringify({ ok: false, error: (e && e.message) || '답글 전송 실패' }) };
  }

  // 성공 — 캐시 무효화 (다음 /api/comments 호출에서 fresh 데이터)
  try {
    await getCacheStore().delete(`sellers/${user.id}.json`);
  } catch (e) {
    console.warn('[reply-comment] 캐시 무효화 무시:', e && e.message);
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ ok: true, replyId: (resp && resp.id) || '' }),
  };
};
