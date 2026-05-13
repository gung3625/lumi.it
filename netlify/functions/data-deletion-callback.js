// Meta 데이터 삭제 콜백 — App Review 정책 준수 endpoint.
//
// 흐름:
//   1) 사장님이 facebook.com 또는 threads.net 에서 lumi 앱 권한 회수
//   2) Meta 가 POST signed_request 를 본 endpoint 로 전송
//   3) 본 endpoint:
//      a. signed_request 검증 (HMAC-SHA256 with META_APP_SECRET / THREADS_APP_SECRET)
//      b. payload.user_id 추출
//      c. ig_accounts 에서 threads_user_id / ig_user_id 매칭 시도
//      d. 매칭 성공 시 → ig_accounts row 삭제 + Vault secret 폐기
//      e. data_deletion_requests insert (status=completed/not_found)
//   4) 응답: { url, confirmation_code } — Meta 가 confirmation_code 저장 +
//      사용자에게 status URL 노출
//
// signed_request 형식 (Facebook 표준):
//   <base64url(signature)>.<base64url(payload_json)>
//   sig = HMAC_SHA256(payload_b64url, app_secret)
//
// 비고:
//   - sellers (lumi 자체 계정) 는 보존. Meta 권한 회수 = IG/Threads 연동만 해제.
//   - matching 실패해도 200 응답 + status='not_found' 마킹 — Meta 의 retry 방지.
//   - 어느 secret 으로 검증해야 하는지 불명확하므로 META + THREADS 양쪽 시도.

'use strict';

const crypto = require('crypto');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { getAdminClient } = require('./_shared/supabase-admin');

const STATUS_URL_BASE = 'https://lumi.it.kr/data-deletion-status';

function b64urlDecode(b64url) {
  // base64url → base64 + padding
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  const padded = pad ? b64 + '='.repeat(4 - pad) : b64;
  return Buffer.from(padded, 'base64');
}

function parseSignedRequest(signedRequest, secrets) {
  if (!signedRequest || typeof signedRequest !== 'string') return null;
  const [sigB64, payloadB64] = signedRequest.split('.');
  if (!sigB64 || !payloadB64) return null;

  // HMAC 비교 — 가능한 secret 들 (META_APP_SECRET / THREADS_APP_SECRET) 모두 시도.
  let matchedSecret = null;
  for (const sec of secrets) {
    if (!sec) continue;
    const expected = crypto
      .createHmac('sha256', sec)
      .update(payloadB64)
      .digest();
    let provided;
    try { provided = b64urlDecode(sigB64); } catch (_) { continue; }
    if (expected.length === provided.length && crypto.timingSafeEqual(expected, provided)) {
      matchedSecret = sec;
      break;
    }
  }
  if (!matchedSecret) return null;

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch (_) {
    return null;
  }
  return payload;
}

async function deleteVaultSecretSafe(admin, secretId) {
  if (!secretId) return;
  try {
    await admin.rpc('delete_vault_secret', { p_secret_id: secretId });
  } catch (e) {
    console.warn('[data-deletion-callback] delete_vault_secret 경고 (무시):', e && e.message);
  }
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // form-encoded 또는 JSON 둘 다 지원 — Meta 는 일반적으로 form-encoded.
  let signedRequest = null;
  try {
    const ct = (event.headers && (event.headers['content-type'] || event.headers['Content-Type'])) || '';
    if (ct.includes('application/x-www-form-urlencoded')) {
      const params = new URLSearchParams(event.body || '');
      signedRequest = params.get('signed_request');
    } else if (ct.includes('application/json')) {
      const body = JSON.parse(event.body || '{}');
      signedRequest = body.signed_request || null;
    } else {
      // 형식 추론 — '.' 두 개로 split 가능하면 raw signed_request 로 간주
      const raw = String(event.body || '');
      if (raw.includes('.') && !raw.includes('=')) signedRequest = raw;
      else {
        const params = new URLSearchParams(raw);
        signedRequest = params.get('signed_request');
      }
    }
  } catch (e) {
    console.error('[data-deletion-callback] body 파싱 실패:', e && e.message);
  }

  if (!signedRequest) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'signed_request 누락' }) };
  }

  const secrets = [
    process.env.META_APP_SECRET,
    process.env.THREADS_APP_SECRET,
  ].filter(Boolean);
  if (!secrets.length) {
    console.error('[data-deletion-callback] APP_SECRET 환경변수 없음');
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류' }) };
  }

  const payload = parseSignedRequest(signedRequest, secrets);
  if (!payload) {
    console.warn('[data-deletion-callback] signed_request 서명 검증 실패');
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'invalid signature' }) };
  }

  const metaUserId = payload.user_id ? String(payload.user_id) : null;
  if (!metaUserId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'user_id 누락' }) };
  }

  let admin;
  try { admin = getAdminClient(); }
  catch (e) {
    console.error('[data-deletion-callback] admin client 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류' }) };
  }

  const confirmationCode = crypto.randomBytes(16).toString('hex');

  // 매칭 — threads_user_id 또는 ig_user_id (Meta 가 보내는 user_id 가 어느 쪽인지 확실 X)
  let matchedRow = null;
  let matchedChannel = 'unknown';
  try {
    const { data: tRow } = await admin
      .from('ig_accounts')
      .select('user_id, ig_user_id, threads_user_id, access_token_secret_id, page_access_token_secret_id, threads_token_secret_id')
      .eq('threads_user_id', metaUserId)
      .maybeSingle();
    if (tRow) { matchedRow = tRow; matchedChannel = 'threads'; }
  } catch (_) { /* 무시 — 다음 분기 시도 */ }
  if (!matchedRow) {
    try {
      const { data: igRow } = await admin
        .from('ig_accounts')
        .select('user_id, ig_user_id, threads_user_id, access_token_secret_id, page_access_token_secret_id, threads_token_secret_id')
        .eq('ig_user_id', metaUserId)
        .maybeSingle();
      if (igRow) { matchedRow = igRow; matchedChannel = 'ig'; }
    } catch (_) { /* 무시 */ }
  }

  // 매칭 실패 — 로그용으로만 기록, 사장님이 lumi@lumi.it.kr 로 직접 문의 유도
  if (!matchedRow) {
    try {
      await admin.from('data_deletion_requests').insert({
        confirmation_code: confirmationCode,
        meta_user_id: metaUserId,
        channel: 'unknown',
        seller_id: null,
        status: 'not_found',
        completed_at: new Date().toISOString(),
      });
    } catch (e) {
      console.warn('[data-deletion-callback] not_found row insert 실패 (무시):', e && e.message);
    }
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `${STATUS_URL_BASE}?code=${confirmationCode}`,
        confirmation_code: confirmationCode,
      }),
    };
  }

  // 매칭 — 실제 삭제 처리
  let status = 'pending';
  let errMsg = null;
  try {
    // 1) Vault secret 들 폐기 (PR #194 의 delete_vault_secret RPC)
    await deleteVaultSecretSafe(admin, matchedRow.access_token_secret_id);
    await deleteVaultSecretSafe(admin, matchedRow.page_access_token_secret_id);
    await deleteVaultSecretSafe(admin, matchedRow.threads_token_secret_id);

    // 2) ig_accounts row 삭제 — 사장님이 회수한 채널 (IG/Threads) 만 영향, sellers 보존.
    //    threads_user_id 매칭이면 threads_* 만 비우고, ig_user_id 매칭이면 row 전체 삭제.
    if (matchedChannel === 'threads') {
      // Threads 만 회수 — IG 는 보존하고 threads_* 만 비움
      const { error: upErr } = await admin
        .from('ig_accounts')
        .update({
          threads_user_id: null,
          threads_token_secret_id: null,
          threads_token_expires_at: null,
          threads_token_invalid_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', matchedRow.user_id);
      if (upErr) throw new Error(`ig_accounts update 실패: ${upErr.message}`);
    } else {
      // IG 회수 → 전체 ig_accounts row 삭제 (threads_* 도 같이 사라짐)
      const { error: delErr } = await admin
        .from('ig_accounts')
        .delete()
        .eq('user_id', matchedRow.user_id);
      if (delErr) throw new Error(`ig_accounts delete 실패: ${delErr.message}`);
    }
    status = 'completed';
  } catch (e) {
    status = 'failed';
    errMsg = String(e && e.message || 'unknown').slice(0, 500);
    console.error('[data-deletion-callback] 삭제 처리 실패:', errMsg);
  }

  try {
    await admin.from('data_deletion_requests').insert({
      confirmation_code: confirmationCode,
      meta_user_id: metaUserId,
      channel: matchedChannel,
      seller_id: matchedRow.user_id,
      status,
      error_message: errMsg,
      completed_at: status === 'completed' || status === 'failed' ? new Date().toISOString() : null,
    });
  } catch (e) {
    console.warn('[data-deletion-callback] 추적 row insert 실패 (무시):', e && e.message);
  }

  console.log(`[data-deletion-callback] meta_user=${metaUserId.slice(0, 8)} channel=${matchedChannel} status=${status} code=${confirmationCode.slice(0, 8)}`);

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: `${STATUS_URL_BASE}?code=${confirmationCode}`,
      confirmation_code: confirmationCode,
    }),
  };
};
