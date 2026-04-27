// 마켓 권한 스코프 비동기 검증 — Sprint 1 (Principle 1, 2)
// POST /api/market-permission-check
// 헤더: Authorization: Bearer <seller-jwt>
// body: { market: 'coupang'|'naver' }
//
// 동작:
// - market_credentials에서 자격증명 복호화
// - 실제 권한 필요 액션 시뮬레이션 (예: 카테고리 조회, 상품 등록 가능 여부)
// - 결과를 market_credentials 컬럼에 저장 (verification_error)
// - 응답: { success: true, scope_ok, error?: 친화 메시지 }
//
// 호출 시점:
// - 클라이언트가 connect-coupang/connect-naver 성공 직후 백그라운드로 호출
// - 결과 도착 시 UI에서 "판매 권한 확인 완료" 또는 "권한 부족" 표시
// - 셀러를 막지 않음 — 다음 단계로 이동 가능

const fetch = require('node-fetch');
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { signCoupang } = require('./_shared/coupang-signature');
const { decrypt, decryptToken, isAvailable: encryptionAvailable } = require('./_shared/encryption');
const { translateMarketError } = require('./_shared/market-errors');
const { recordAudit } = require('./_shared/onboarding-utils');

const COUPANG_API_HOST = 'https://api-gateway.coupang.com';
const NAVER_API_HOST = 'https://api.commerce.naver.com';

async function checkCoupangPermission({ vendorId, accessKey, secretKey }) {
  // 권한 시뮬레이션: 카테고리 추천 API (셀러가 상품 등록 권한이 없으면 403)
  const path = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products`;
  const query = `vendorId=${vendorId}&maxPerPage=1`;
  const { authorization } = signCoupang({ method: 'GET', path, query, accessKey, secretKey });
  const url = `${COUPANG_API_HOST}${path}?${query}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: { Authorization: authorization, 'Content-Type': 'application/json;charset=UTF-8' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (r.status === 200) return { ok: true, status: 200 };
    if (r.status === 403) return { ok: false, status: 403, scopeError: true };
    return { ok: false, status: r.status };
  } catch (e) {
    clearTimeout(timeout);
    return { ok: false, status: e.name === 'AbortError' ? 408 : 0 };
  }
}

async function checkNaverPermission({ accessToken }) {
  // 권한 시뮬레이션: 채널 조회 (스코프 없으면 403)
  const url = `${NAVER_API_HOST}/external/v1/sellers`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (r.status === 200) return { ok: true, status: 200 };
    if (r.status === 403) return { ok: false, status: 403, scopeError: true };
    return { ok: false, status: r.status };
  } catch (e) {
    clearTimeout(timeout);
    return { ok: false, status: e.name === 'AbortError' ? 408 : 0 };
  }
}

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
  const market = String(body.market || '').toLowerCase();
  if (!['coupang', 'naver'].includes(market)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '지원하지 않는 마켓입니다.' }) };
  }

  const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
  if (!encryptionAvailable() && !isSignupMock) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 보안 설정 오류' }) };
  }

  let admin;
  try { admin = getAdminClient(); } catch (e) {
    if (isSignupMock) {
      // Supabase 미설정 — 모킹 응답으로 graceful
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          success: true,
          scopeOk: true,
          market,
          mock: true,
        }),
      };
    }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류' }) };
  }

  const { data: cred, error: selErr } = await admin
    .from('market_credentials')
    .select('id, credentials_encrypted, access_token_encrypted, market_seller_id')
    .eq('seller_id', payload.seller_id)
    .eq('market', market)
    .maybeSingle();
  if (selErr || !cred) {
    if (isSignupMock) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ success: true, scopeOk: true, market, mock: true }),
      };
    }
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '연결된 마켓을 찾을 수 없습니다.' }) };
  }

  // 모킹 토글 — 마켓별 환경변수 재사용
  const isMock = market === 'coupang'
    ? (process.env.COUPANG_VERIFY_MOCK || 'true').toLowerCase() !== 'false'
    : (process.env.NAVER_VERIFY_MOCK || 'true').toLowerCase() !== 'false';

  let result;
  if (isMock) {
    result = { ok: true, status: 200, mock: true };
  } else {
    try {
      if (market === 'coupang') {
        const decrypted = decrypt(cred.credentials_encrypted);
        result = await checkCoupangPermission({
          vendorId: decrypted.vendorId,
          accessKey: decrypted.accessKey,
          secretKey: decrypted.secretKey,
        });
      } else {
        const accessToken = cred.access_token_encrypted ? decryptToken(cred.access_token_encrypted) : null;
        if (!accessToken) {
          result = { ok: false, status: 401 };
        } else {
          result = await checkNaverPermission({ accessToken });
        }
      }
    } catch (e) {
      console.error(`[market-permission-check] ${market} 복호화/호출 실패:`, e.message);
      result = { ok: false, status: 500 };
    }
  }

  const now = new Date().toISOString();
  const errorMsg = result.ok ? null : translateMarketError(market, result.status).cause;

  await admin
    .from('market_credentials')
    .update({
      last_verified_at: now,
      verification_error: errorMsg,
      updated_at: now,
    })
    .eq('id', cred.id);

  await recordAudit(admin, {
    actor_id: payload.seller_id,
    actor_type: 'seller',
    action: `market_permission_check_${market}`,
    resource_type: 'market_credentials',
    resource_id: cred.id,
    metadata: { mock: Boolean(isMock), status: result.status, scope_ok: result.ok },
    event,
  });

  console.log(`[market-permission-check] ${market} seller=${payload.seller_id.slice(0, 8)} ok=${result.ok} status=${result.status} mock=${isMock}`);

  if (result.ok) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        scopeOk: true,
        market,
        mock: Boolean(isMock),
      }),
    };
  }

  const friendly = translateMarketError(market, result.status);
  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      scopeOk: false,
      market,
      error: friendly,
      mock: Boolean(isMock),
    }),
  };
};
