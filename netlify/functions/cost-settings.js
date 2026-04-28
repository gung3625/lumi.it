// cost-settings.js Function — Sprint 4 셀러 비용 설정
// GET /api/cost-settings — 현재 설정 조회 (없으면 default)
// POST /api/cost-settings — 업서트 (포장재·송장비·광고비 비율 등)
// 메모리 project_phase1_strategic_differentiation.md (Profit 11단계 입력값)

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const DEFAULTS = {
  packaging_cost_per_unit: 500,
  shipping_cost_per_unit: 3000,
  ad_spend_ratio: 0.0,
  payment_fee_ratio: 3.30,
  vat_applicable: true,
  market_fee_overrides: {},
};

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const token = extractBearerToken(event);
  const { payload, error: jwtErr } = verifySellerToken(token);
  if (jwtErr) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: jwtErr }) };
  }
  const sellerId = payload.seller_id;

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase 초기화 실패' }) };
  }

  if (event.httpMethod === 'GET') {
    try {
      const { data } = await admin
        .from('seller_cost_settings')
        .select('*')
        .eq('seller_id', sellerId)
        .maybeSingle();
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          ok: true,
          settings: data || { seller_id: sellerId, ...DEFAULTS },
          is_default: !data,
        }),
      };
    } catch (e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (_) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '요청 형식 오류' }) };
    }

    const updates = {
      packaging_cost_per_unit: clampInt(body.packaging_cost_per_unit, 0, 50000, DEFAULTS.packaging_cost_per_unit),
      shipping_cost_per_unit: clampInt(body.shipping_cost_per_unit, 0, 50000, DEFAULTS.shipping_cost_per_unit),
      ad_spend_ratio: clampNum(body.ad_spend_ratio, 0, 100, DEFAULTS.ad_spend_ratio),
      payment_fee_ratio: clampNum(body.payment_fee_ratio, 0, 50, DEFAULTS.payment_fee_ratio),
      vat_applicable: body.vat_applicable !== false,
      market_fee_overrides: body.market_fee_overrides && typeof body.market_fee_overrides === 'object'
        ? body.market_fee_overrides
        : {},
    };

    try {
      // Upsert (PRIMARY KEY = seller_id)
      const { data: existing } = await admin
        .from('seller_cost_settings')
        .select('seller_id')
        .eq('seller_id', sellerId)
        .maybeSingle();

      if (existing) {
        await admin
          .from('seller_cost_settings')
          .update(updates)
          .eq('seller_id', sellerId);
      } else {
        await admin
          .from('seller_cost_settings')
          .insert({ seller_id: sellerId, ...updates });
      }

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          ok: true,
          message: '비용 설정을 저장했어요. 다음 수익 계산부터 반영돼요.',
          settings: { seller_id: sellerId, ...updates },
        }),
      };
    } catch (e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
