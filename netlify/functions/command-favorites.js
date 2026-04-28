// command-favorites.js — 사이드바 즐겨찾기 명령
//
// GET /api/command-favorites
// POST /api/command-favorites — { label, command_text, icon? }
// DELETE /api/command-favorites?id=X

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const DEFAULT_FAVORITES = [
  { label: '오늘 뜨는 상품', command_text: '오늘 뜨는 상품 추천해 줘', icon: 'T', sort_order: 0 },
  { label: '쿠팡 가격 점검', command_text: '쿠팡 판매가가 비싼 상품 알려 줘', icon: 'P', sort_order: 1 },
  { label: '재고 부족', command_text: '재고 5개 이하 상품 보여 줘', icon: 'S', sort_order: 2 },
  { label: '이번 주 매출', command_text: '이번 주 매출 요약', icon: 'R', sort_order: 3 },
];

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const token = extractBearerToken(event);
  const { payload: jwt, error: jwtErr } = verifySellerToken(token);
  if (jwtErr) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요해요' }) };
  }
  const sellerId = jwt.seller_id;

  let admin;
  try { admin = getAdminClient(); } catch (_) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'DB 초기화 실패' }) };
  }

  if (event.httpMethod === 'GET') {
    try {
      const { data } = await admin
        .from('command_favorites')
        .select('id, label, command_text, icon, sort_order')
        .eq('seller_id', sellerId)
        .order('sort_order', { ascending: true });

      const favorites = (data && data.length > 0) ? data : DEFAULT_FAVORITES;
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ ok: true, favorites, isDefault: !data || data.length === 0 }),
      };
    } catch (e) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ ok: true, favorites: DEFAULT_FAVORITES, isDefault: true }),
      };
    }
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청' }) };
    }
    const label = String(body.label || '').slice(0, 50).trim();
    const commandText = String(body.command_text || '').slice(0, 300).trim();
    const icon = String(body.icon || '·').slice(0, 4);
    if (!label || !commandText) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'label·command_text 필요' }) };
    }
    try {
      const { data, error } = await admin
        .from('command_favorites')
        .insert({
          seller_id: sellerId,
          label,
          command_text: commandText,
          icon,
          sort_order: 999,
        })
        .select('id, label, command_text, icon, sort_order')
        .single();
      if (error) throw error;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, favorite: data }) };
    } catch (e) {
      return {
        statusCode: 409,
        headers: CORS,
        body: JSON.stringify({ error: '같은 이름의 즐겨찾기가 이미 있어요' }),
      };
    }
  }

  if (event.httpMethod === 'DELETE') {
    const id = (event.queryStringParameters || {}).id;
    if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id 필요' }) };
    try {
      const { error } = await admin
        .from('command_favorites')
        .delete()
        .eq('id', id)
        .eq('seller_id', sellerId);
      if (error) throw error;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    } catch (e) {
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: '삭제 실패' }),
      };
    }
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
