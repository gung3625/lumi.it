// Step 3 말투 학습 샘플 저장 — Sprint 1
// POST /api/signup-tone-samples
// 헤더: Authorization: Bearer <seller-jwt>
// body: { greeting, closing, recommendation, skipped }
// 응답: { success: true, stored: number, skipped: boolean }
//
// 동작:
// - tone_samples 테이블에 셀러별 샘플 저장 (없으면 생성, 있으면 update)
// - skipped=true 면 sellers.tone_skipped=true 만 기록
// - SIGNUP_MOCK=true 인 환경에서는 graceful 통과
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { recordAudit } = require('./_shared/onboarding-utils');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error: authErr } = verifySellerToken(token);
  if (authErr || !payload) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청 형식입니다.' }) };
  }

  const greeting = String(body.greeting || '').trim().slice(0, 200);
  const closing = String(body.closing || '').trim().slice(0, 200);
  const recommendation = String(body.recommendation || '').trim().slice(0, 200);
  const skipped = body.skipped === true;

  const samples = [];
  if (!skipped) {
    if (greeting) samples.push({ kind: 'greeting', text: greeting });
    if (closing) samples.push({ kind: 'closing', text: closing });
    if (recommendation) samples.push({ kind: 'recommendation', text: recommendation });
  }

  const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    if (isSignupMock) {
      console.log(`[signup-tone-samples] mock seller=${payload.seller_id.slice(0, 8)} samples=${samples.length} skipped=${skipped}`);
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ success: true, stored: samples.length, skipped, mock: true }),
      };
    }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류입니다.' }) };
  }

  const now = new Date().toISOString();
  let stored = 0;

  if (skipped) {
    // 셀러 row에 skipped 플래그만 기록 (tone_skipped 컬럼은 마이그레이션에 없으니 metadata 사용)
    await recordAudit(admin, {
      actor_id: payload.seller_id,
      actor_type: 'seller',
      action: 'tone_skip',
      resource_type: 'seller',
      resource_id: payload.seller_id,
      metadata: { skipped: true },
      event,
    });
  } else if (samples.length > 0) {
    // tone_samples 테이블 — 없으면 audit_logs에라도 기록
    try {
      const rows = samples.map((s) => ({
        seller_id: payload.seller_id,
        kind: s.kind,
        text: s.text,
        source: 'onboarding_step3',
        created_at: now,
      }));
      const { error: insErr } = await admin.from('tone_samples').insert(rows);
      if (insErr) {
        // 테이블이 없는 경우 (Sprint 1 시점) — audit_logs에만 기록
        await recordAudit(admin, {
          actor_id: payload.seller_id,
          actor_type: 'seller',
          action: 'tone_samples_inline',
          resource_type: 'seller',
          resource_id: payload.seller_id,
          metadata: { samples: rows.map((r) => ({ kind: r.kind, length: r.text.length })) },
          event,
        });
        stored = samples.length;  // best-effort 카운트
      } else {
        stored = samples.length;
      }
    } catch (e) {
      console.error('[signup-tone-samples] tone_samples insert 실패:', e.message);
    }
  }

  console.log(`[signup-tone-samples] seller=${payload.seller_id.slice(0, 8)} stored=${stored} skipped=${skipped}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      stored,
      skipped,
    }),
  };
};
