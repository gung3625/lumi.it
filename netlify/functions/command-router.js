// command-router.js — 채팅 명령 메인 진입점
// 메모리 project_linear_canvas_ui_doctrine_0428.md
//
// POST /api/command-router
// Body: { input: string }
// Response: { ok, intent, ability_level, cost_tier, summary, payload, history_id }

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { classify } = require('./_shared/command-classifier');
const { execute } = require('./_shared/command-executor');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // 인증 (선택적 — 미인증도 weather/calc 등은 동작)
  const token = extractBearerToken(event);
  const { payload: jwt } = verifySellerToken(token);
  const sellerId = jwt?.seller_id || null;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청 형식이에요' }) };
  }

  const input = String(body.input || '').trim();
  if (!input) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: '명령을 입력해 주세요' }),
    };
  }

  try {
    // Gate 1+2: 분류
    const cls = await classify(input, { sellerId });
    const intent = cls.intent;

    // 처리
    const result = await execute({
      input,
      intent,
      sellerId,
      fastReason: cls.reason,
    });

    // 히스토리 저장 (sellerId 있을 때만)
    let historyId = null;
    if (sellerId) {
      try {
        const admin = getAdminClient();
        const { data } = await admin
          .from('command_history')
          .insert({
            seller_id: sellerId,
            input: input.slice(0, 500),
            intent,
            ability_level: result.ability_level || 2,
            cost_tier: result.cost_tier || 0,
            summary: (result.summary || '').slice(0, 300),
            result_payload: result.payload || {},
            status: result.ok ? 'done' : (intent === 'abuse' || intent === 'invalid' ? 'blocked' : 'failed'),
            blocked_reason: (intent === 'abuse' || intent === 'invalid') ? (cls.reason || '차단') : null,
          })
          .select('id')
          .single();
        historyId = data?.id || null;
      } catch (_) {}
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: result.ok,
        intent,
        confidence: cls.confidence ?? null,
        ability_level: result.ability_level,
        cost_tier: result.cost_tier,
        summary: result.summary,
        payload: result.payload,
        history_id: historyId,
        cached: !!(result.payload && result.payload.cached),
        fast: !!cls.fast,
      }),
    };
  } catch (e) {
    console.error('[command-router] error:', e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '명령을 처리하지 못했어요. 잠시 후 다시 시도해 주세요' }),
    };
  }
};
