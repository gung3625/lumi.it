// comments.js — 사장님 인스타 게시물 최근 댓글 N개 조회
// GET /api/comments?limit=20
// 헤더: Authorization: Bearer <jwt>
//
// 현재 단계 (Phase 1):
//   - IG 미연동 사장님 → { ok: true, items: [], igConnected: false }
//   - IG 연동 사장님 → { ok: true, items: [], igConnected: true } (실제 댓글 fetch 는 Phase 2 작업)
//
// Phase 2 (별도 PR):
//   - ig_accounts_decrypted 뷰에서 access_token 받기
//   - IG Graph API /me/media?fields=id,caption,comments{id,text,from,timestamp}
//   - 응답 정리 후 items 배열에 packaging
//   - meta-webhook 으로 받은 auto_reply_log 와 merge

'use strict';

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { getAdminClient } = require('./_shared/supabase-admin');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user || !user.id) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[comments] admin 초기화 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류' }) };
  }

  // IG 연동 여부 확인
  const { data: igRow } = await admin
    .from('ig_accounts')
    .select('ig_user_id')
    .eq('user_id', user.id)
    .maybeSingle();

  const igConnected = !!igRow;

  // Phase 1: 빈 배열 + 연동 상태만 반환. 사장님 UI 가 igConnected 로 분기 (CTA vs 댓글 목록).
  // Phase 2: 여기서 IG Graph API 호출 + auto_reply_log merge.
  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      igConnected,
      items: [],
    }),
  };
};
