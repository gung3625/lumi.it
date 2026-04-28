// Sprint 3.6 — OpenAI 국외이전 동의 토글
// POST /api/seller-openai-consent  body: { granted: boolean }
// GET  /api/seller-openai-consent  → { granted, grantedAt, revokedAt }
// Headers: Authorization: Bearer <seller-jwt>
const { getAdminClient } = require('./_shared/supabase-admin');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { verifySellerToken } = require('./_shared/seller-jwt');
const audit = require('./_shared/audit-log');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const tok = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  let claims;
  try { claims = verifySellerToken(tok); } catch {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }
  const sellerId = claims.seller_id;
  if (!sellerId) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증 정보가 올바르지 않습니다.' }) };
  }

  let admin;
  try { admin = getAdminClient(); } catch (e) {
    console.error('[seller-openai-consent] admin init 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류입니다.' }) };
  }

  if (event.httpMethod === 'GET') {
    const { data: seller, error } = await admin
      .from('sellers')
      .select('openai_consent_at, openai_consent_revoked_at')
      .eq('id', sellerId)
      .maybeSingle();
    if (error || !seller) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '셀러 정보를 찾을 수 없습니다.' }) };
    }
    const granted = Boolean(seller.openai_consent_at) && !seller.openai_consent_revoked_at;
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        granted,
        grantedAt: seller.openai_consent_at,
        revokedAt: seller.openai_consent_revoked_at,
      }),
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* ignore */ }
  const granted = Boolean(body.granted);
  const now = new Date().toISOString();

  const update = granted
    ? { openai_consent_at: now, openai_consent_revoked_at: null }
    : { openai_consent_at: null, openai_consent_revoked_at: now };

  const { error: upErr } = await admin.from('sellers').update(update).eq('id', sellerId);
  if (upErr) {
    console.error('[seller-openai-consent] update 실패:', upErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '동의 처리에 실패했습니다.' }) };
  }

  await audit.logConsent(admin, {
    sellerId,
    consentType: 'openai_intl_transfer',
    consentVersion: 'v1',
    granted,
    event,
  });

  console.log(`[seller-openai-consent] seller=${sellerId.slice(0, 8)} granted=${granted}`);
  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      granted,
      grantedAt: granted ? now : null,
      revokedAt: granted ? null : now,
      restrictedFeatures: granted ? [] : ['tone_learning', 'cs_auto_reply', 'caption_generation', 'ocr', 'category_mapping'],
    }),
  };
};
