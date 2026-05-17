// auth-refresh.js — seller-jwt access 토큰 갱신 (audit #2)
//
// POST /api/auth-refresh
// Body: { refreshToken: "<plain hex>" }
// 응답: { access, refresh, expiresAt }
//
// 흐름:
//   1) refreshToken → sha256 hash
//   2) seller_refresh_tokens 조회: hash 일치 + revoked_at NULL + expires_at 미래
//   3) 새 access JWT (14일) + 새 refresh token (30일) 발급
//   4) 옛 row revoke (revoked_at, replaced_by_id) — rotation chain (forensic)
//   5) 클라이언트 둘 다 localStorage 갱신
//
// 보안:
//   - 평문 refresh 는 DB 에 없음 (hash 만)
//   - rotation 으로 옛 토큰 재사용 차단 — 도난 시 한쪽만 사용 가능
//   - timing-safe 비교는 sha256 hash lookup 자체로 보장
//
// 사장님 결정 2026-05-17: 14일 JWT 만료마다 카카오 재로그인 불편 → 30일 refresh
//   토큰으로 사장님 한 달 이내 사용 시 끊김 없는 경험.

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { getAdminClient } = require('./_shared/supabase-admin');
const {
  signSellerToken,
  generateRefreshToken,
  hashRefreshToken,
} = require('./_shared/seller-jwt');

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'POST 전용' }),
    };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '잘못된 요청 본문' }) };
  }

  const refresh = typeof body.refreshToken === 'string' ? body.refreshToken.trim() : '';
  const hash = hashRefreshToken(refresh);
  if (!hash) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'refreshToken 누락' }) };
  }

  const admin = getAdminClient();

  // 1) hash 조회 — revoked 안 됨 + 미만료
  const { data: row, error: selErr } = await admin
    .from('seller_refresh_tokens')
    .select('id, seller_id, expires_at, revoked_at')
    .eq('token_hash', hash)
    .maybeSingle();

  if (selErr) {
    console.error('[auth-refresh] DB 조회 실패:', selErr.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류' }) };
  }
  if (!row) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: '유효하지 않은 refresh token' }) };
  }
  if (row.revoked_at) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: '재사용된 refresh token (revoke 됨)' }) };
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: '만료된 refresh token' }) };
  }

  // 2) 새 access JWT + 새 refresh token 발급 (rotation)
  const newAccess = signSellerToken({ seller_id: row.seller_id });
  const { plain: newRefreshPlain, hash: newHash, expiresAt: newExpires } = generateRefreshToken();

  // 3) 새 row insert
  const { data: newRow, error: insErr } = await admin
    .from('seller_refresh_tokens')
    .insert({
      seller_id: row.seller_id,
      token_hash: newHash,
      expires_at: newExpires.toISOString(),
      user_agent: event.headers && (event.headers['user-agent'] || event.headers['User-Agent']) || null,
      ip_address: event.headers && (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
    })
    .select('id')
    .single();
  if (insErr) {
    console.error('[auth-refresh] 새 refresh insert 실패:', insErr.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류' }) };
  }

  // 4) 옛 row revoke + replaced_by_id (rotation chain)
  await admin
    .from('seller_refresh_tokens')
    .update({
      revoked_at: new Date().toISOString(),
      replaced_by_id: newRow.id,
      last_used_at: new Date().toISOString(),
    })
    .eq('id', row.id);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      access: newAccess,
      refresh: newRefreshPlain,
      expiresAt: newExpires.toISOString(),
    }),
  };
};
