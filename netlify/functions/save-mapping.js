// 매핑 저장 (생성 또는 수정) — POST /api/save-mapping
// Body: { id?, market, market_option_name, master_product_id?, master_option_name? }
// id 없으면 INSERT, id 있으면 UPDATE (본인 소유 검증)
// 인증: verifySellerToken

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const VALID_MARKETS = new Set(['coupang', 'naver', 'toss']);

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

  const { id, market, market_option_name, master_product_id, master_option_name } = body;

  // 필수 필드 검증
  if (!market || !VALID_MARKETS.has(market)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '유효한 마켓을 입력해주세요. (coupang | naver | toss)' }) };
  }
  if (!market_option_name || typeof market_option_name !== 'string' || !market_option_name.trim()) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '마켓 옵션명을 입력해주세요.' }) };
  }

  const optionName = market_option_name.trim().slice(0, 500);
  const masterOption = master_option_name ? String(master_option_name).trim().slice(0, 500) : null;
  const masterProductId = master_product_id || null;

  let admin;
  try { admin = getAdminClient(); } catch {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
  }

  try {
    if (id) {
      // UPDATE — 본인 소유 검증 포함
      const { data, error: upErr } = await admin
        .from('order_mappings')
        .update({
          market,
          market_option_name: optionName,
          master_product_id: masterProductId,
          master_option_name: masterOption,
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('seller_id', payload.seller_id)
        .select('id, market, market_option_name, master_product_id, master_option_name, use_count, updated_at')
        .single();

      if (upErr || !data) {
        return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '매핑을 찾을 수 없거나 권한이 없어요.' }) };
      }

      console.log(`[save-mapping] updated seller=${payload.seller_id.slice(0, 8)} id=${id.slice(0, 8)}`);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, mapping: data }) };
    } else {
      // INSERT — upsert on conflict (같은 seller+market+option 조합 중복 방지)
      const { data, error: insErr } = await admin
        .from('order_mappings')
        .upsert(
          {
            seller_id: payload.seller_id,
            market,
            market_option_name: optionName,
            master_product_id: masterProductId,
            master_option_name: masterOption,
          },
          { onConflict: 'seller_id,market,market_option_name', ignoreDuplicates: false }
        )
        .select('id, market, market_option_name, master_product_id, master_option_name, use_count, created_at')
        .single();

      if (insErr) {
        console.error('[save-mapping] insert error:', insErr.message);
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '매핑 저장 중 오류가 발생했어요.' }) };
      }

      console.log(`[save-mapping] created seller=${payload.seller_id.slice(0, 8)} id=${data?.id?.slice(0, 8)}`);
      return { statusCode: 201, headers: CORS, body: JSON.stringify({ success: true, mapping: data }) };
    }
  } catch (err) {
    console.error('[save-mapping] unexpected error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류예요.' }) };
  }
};
