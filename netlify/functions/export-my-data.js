// 자기정보 이동권 (PIPA §35) — 회원이 자기 데이터를 JSON으로 다운로드
// GET /api/export-my-data
// 헤더: Authorization: Bearer <jwt> (Supabase JWT or seller-jwt)
// 응답: Content-Disposition: attachment; filename="lumi-data-export-<sellerId>-<YYYYMMDD>.json"
//       JSON body — sellers row + 관련 테이블 전체
//
// 인증: me.js / account-delete.js 동일 패턴 (Supabase JWT 우선, seller-jwt fallback)
// 보안:
//   - service_role(admin client) 사용 — RLS 우회
//   - 토큰 secret_id (vault) 만 노출, 평문 access_token 은 응답 X
//   - 본인 행만 select (seller_id / user_id eq)
//   - PII 컬럼은 sellers 본인 행에 한해서만 노출 (자기 정보이므로 OK)

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

// 본인 데이터를 select 할 때 안전하게 빈 배열을 반환 (테이블이 없거나 컬럼이 없어도 export 자체는 실패 X)
async function safeSelect(admin, table, column, value) {
  if (!value) return [];
  try {
    const { data, error } = await admin.from(table).select('*').eq(column, value);
    if (error) {
      console.warn(`[export-my-data] ${table} select 경고:`, error.message);
      return [];
    }
    return data || [];
  } catch (e) {
    console.warn(`[export-my-data] ${table} select 예외:`, e && e.message);
    return [];
  }
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

function ymdUtc(d) {
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  if (!token) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[export-my-data] admin client 초기화 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류입니다.' }) };
  }

  // 1) Supabase JWT 우선 (OAuth 사용자) — auth.users.id 와 email 확보
  let authUserId = null;
  let authEmail = null;
  let sellerQuery = null;
  try {
    const { data: supaAuthData } = await admin.auth.getUser(token);
    if (supaAuthData && supaAuthData.user && supaAuthData.user.email) {
      authUserId = supaAuthData.user.id;
      authEmail = supaAuthData.user.email;
      sellerQuery = { field: 'email', value: authEmail };
    }
  } catch (_) { /* fallthrough */ }

  // 2) seller-jwt fallback (HS256)
  if (!sellerQuery) {
    const { payload, error: authErr } = verifySellerToken(token);
    if (authErr || !payload) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 만료되었습니다. 다시 로그인해주세요.' }) };
    }
    sellerQuery = { field: 'id', value: payload.seller_id };
  }

  // sellers 본인 행 조회 (모든 컬럼 — 자기 데이터)
  const { data: seller, error: selErr } = await admin
    .from('sellers')
    .select('*')
    .eq(sellerQuery.field, sellerQuery.value)
    .maybeSingle();

  if (selErr) {
    console.error('[export-my-data] sellers select 오류:', selErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '회원 정보 조회에 실패했습니다.' }) };
  }
  if (!seller) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '회원을 찾을 수 없습니다.' }) };
  }

  const sellerId = seller.id;
  // user_id 기반 테이블(ig_accounts/reservations/...) 매칭용 — Supabase JWT 사용자만 보유
  // seller-jwt 단독 사용자는 auth.users.id 가 없을 수 있음 → 빈 배열
  const userId = authUserId || null;

  // ────────────────────────────────────────────────────────────
  // seller_id (UUID, sellers.id) FK 테이블
  // ────────────────────────────────────────────────────────────
  const [
    tiktokAccounts,
    marketplaceClaims,
    failureLog,
    optionChangeLog,
    productChangeLog,
    orderMappings,
  ] = await Promise.all([
    safeSelect(admin, 'tiktok_accounts',     'seller_id', sellerId),
    safeSelect(admin, 'marketplace_claims',  'seller_id', sellerId),
    safeSelect(admin, 'failure_log',         'seller_id', sellerId),
    safeSelect(admin, 'option_change_log',   'seller_id', sellerId),
    safeSelect(admin, 'product_change_log',  'seller_id', sellerId),
    safeSelect(admin, 'order_mappings',      'seller_id', sellerId),
  ]);

  // ────────────────────────────────────────────────────────────
  // user_id (auth.users.id, public.users.id) FK 테이블
  // — Supabase JWT 사용자만 매칭 가능
  // ────────────────────────────────────────────────────────────
  const [
    usersProfile,
    igAccounts,
    reservations,
    orders,
    toneFeedback,
    captionHistory,
    linkpages,
  ] = await Promise.all([
    safeSelect(admin, 'users',           'id',      userId),
    safeSelect(admin, 'ig_accounts',     'user_id', userId),
    safeSelect(admin, 'reservations',    'user_id', userId),
    safeSelect(admin, 'orders',          'user_id', userId),
    safeSelect(admin, 'tone_feedback',   'user_id', userId),
    safeSelect(admin, 'caption_history', 'user_id', userId),
    safeSelect(admin, 'linkpages',       'user_id', userId),
  ]);

  console.log(`[export-my-data] seller=${String(sellerId).slice(0, 8)} reservations=${reservations.length} ig=${igAccounts.length} tiktok=${tiktokAccounts.length}`);

  const exportedAt = new Date();
  const filename = `lumi-data-export-${String(sellerId).slice(0, 8)}-${ymdUtc(exportedAt)}.json`;

  const body = {
    exportedAt: exportedAt.toISOString(),
    sellerId,
    note: '본 파일은 회원 본인의 lumi 서비스 데이터 전체입니다. 개인정보보호법 §35 자기정보이동권에 의거 발급되었습니다. 파일을 안전하게 보관하세요.',
    data: {
      profile: seller,
      usersProfile: usersProfile.length ? usersProfile[0] : null,
      instagramAccounts: igAccounts,
      tiktokAccounts,
      reservations,
      orders,
      toneFeedback,
      captionHistory,
      linkpages,
      marketplaceClaims,
      failureLog,
      optionChangeLog,
      productChangeLog,
      orderMappings,
    },
  };

  return {
    statusCode: 200,
    headers: {
      ...CORS,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
    body: JSON.stringify(body, null, 2),
  };
};
