// 주문에 매핑 적용 — POST /api/apply-mappings-to-order
// Body: { order_id: string }
// 동작:
//   1. 주문의 option_text 조회
//   2. seller+market+option_text 조합으로 order_mappings 룩업
//   3. 매핑 있으면 주문 master_option_name 업데이트
//   4. use_count++, last_applied_at 갱신
//   5. 매핑 결과 반환 (매핑 없으면 unmapped 표시)
// 인증: verifySellerToken

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error } = verifySellerToken(token);
  if (error || !payload) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요해요.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '요청 형식이 잘못됐어요.' }) };
  }

  const { order_id } = body;
  if (!order_id || typeof order_id !== 'string') {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'order_id가 필요해요.' }) };
  }

  let admin;
  try { admin = getAdminClient(); } catch {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
  }

  try {
    // 1. 주문 조회 (본인 소유 + option_text, market 필요)
    const { data: order, error: orderErr } = await admin
      .from('marketplace_orders')
      .select('id, seller_id, market, option_text, market_product_id')
      .eq('id', order_id)
      .eq('seller_id', payload.seller_id)
      .single();

    if (orderErr || !order) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '주문을 찾을 수 없어요.' }) };
    }

    const optionText = order.option_text;
    if (!optionText) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          success: true,
          mapped: false,
          reason: '주문에 옵션 정보가 없어요.',
          order_id,
        }),
      };
    }

    // 2. 매핑 룩업
    const { data: mapping, error: mapErr } = await admin
      .from('order_mappings')
      .select('id, master_product_id, master_option_name')
      .eq('seller_id', payload.seller_id)
      .eq('market', order.market)
      .eq('market_option_name', optionText)
      .maybeSingle();

    if (mapErr) {
      console.error('[apply-mappings-to-order] lookup error:', mapErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '매핑 조회 중 오류가 발생했어요.' }) };
    }

    if (!mapping) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          success: true,
          mapped: false,
          reason: '매핑된 옵션이 없어요.',
          market_option_name: optionText,
          order_id,
        }),
      };
    }

    // 3. 주문 업데이트 (master_option_name 반영)
    const now = new Date().toISOString();
    const updateFields = {};
    if (mapping.master_option_name) updateFields.mapped_option_name = mapping.master_option_name;
    if (mapping.master_product_id) updateFields.mapped_product_id = mapping.master_product_id;

    if (Object.keys(updateFields).length > 0) {
      await admin
        .from('marketplace_orders')
        .update(updateFields)
        .eq('id', order_id)
        .eq('seller_id', payload.seller_id);
    }

    // 4. use_count++, last_applied_at 갱신 (실패해도 전체 결과에 영향 X)
    // use_count 현재값 조회 후 +1 (원자성 보장 필요 시 DB 함수로 교체 가능)
    const { data: mappingRow } = await admin
      .from('order_mappings')
      .select('use_count')
      .eq('id', mapping.id)
      .single();

    await admin
      .from('order_mappings')
      .update({ use_count: (mappingRow?.use_count || 0) + 1, last_applied_at: now })
      .eq('id', mapping.id);

    console.log(`[apply-mappings-to-order] seller=${payload.seller_id.slice(0, 8)} order=${order_id.slice(0, 8)} mapping=${mapping.id.slice(0, 8)}`);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        mapped: true,
        order_id,
        market_option_name: optionText,
        master_option_name: mapping.master_option_name,
        master_product_id: mapping.master_product_id,
      }),
    };
  } catch (err) {
    console.error('[apply-mappings-to-order] unexpected error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류예요.' }) };
  }
};
