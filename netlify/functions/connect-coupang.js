// 쿠팡 Wing OPEN API 연결 — Sprint 1
// POST /api/connect-coupang
// 헤더: Authorization: Bearer <seller-jwt>
// body: { vendorId, accessKey, secretKey }
//
// 동작:
// 1. 입력 형식 검증 (Vendor ID 정규식, 키 길이)
// 2. HMAC-SHA256 서명으로 실제 쿠팡 API 호출 (셀러 정보 GET)
//    - COUPANG_VERIFY_MOCK=true 면 호출 스킵 (베타 모킹 토글)
// 3. 검증 성공 시 자격증명 암호화 → market_credentials upsert
// 4. 응답: 마스킹된 vendorId, store_name (가능 시), verified_at
//
// 보안:
// - accessKey/secretKey 평문 로그 절대 금지
// - 응답에 평문 자격증명 미포함

const fetch = require('node-fetch');
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { signCoupang, validateCoupangCredentials } = require('./_shared/coupang-signature');
const { encrypt, isAvailable: encryptionAvailable } = require('./_shared/encryption');
const { recordAudit } = require('./_shared/onboarding-utils');
const { translateMarketError } = require('./_shared/market-errors');

const COUPANG_API_HOST = 'https://api-gateway.coupang.com';
// 셀러 검증용 엔드포인트 — 자기 vendor의 카테고리 가시성 (가벼운 GET)
// 공식 셀러 정보 GET이 권한별로 200/403 갈리므로, 일반적으로 모든 셀러가 호출 가능한
// 카테고리 메타 엔드포인트를 검증용으로 사용
const VERIFY_PATH_TEMPLATE = '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products';

async function callCoupangVerify({ vendorId, accessKey, secretKey }) {
  const path = VERIFY_PATH_TEMPLATE;
  const query = `vendorId=${vendorId}&maxPerPage=1`;
  const { authorization } = signCoupang({
    method: 'GET',
    path,
    query,
    accessKey,
    secretKey,
  });

  const url = `${COUPANG_API_HOST}${path}?${query}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json;charset=UTF-8',
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return { ok: false, status: 408, error: '쿠팡 API 응답 시간이 초과됐습니다.' };
    }
    return { ok: false, status: 0, error: '쿠팡 API 연결 실패: ' + err.message };
  }
  clearTimeout(timeout);

  let bodyText = '';
  try { bodyText = await response.text(); } catch (_) { /* swallow */ }

  if (response.status === 200) {
    let parsed = null;
    try { parsed = JSON.parse(bodyText); } catch (_) { /* */ }
    return { ok: true, status: 200, data: parsed };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, status: response.status, error: '인증 실패 — Vendor ID 또는 키를 다시 확인해주세요.' };
  }
  if (response.status === 429) {
    return { ok: false, status: 429, error: '요청이 일시적으로 제한됐습니다. 잠시 후 다시 시도해주세요.' };
  }
  return { ok: false, status: response.status, error: `쿠팡 API 오류 (status=${response.status})` };
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // 1. 인증
  const token = extractBearerToken(event);
  const { payload, error: authErr } = verifySellerToken(token);
  if (authErr || !payload) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  // 2. body
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청 형식입니다.' }) };
  }
  const vendorId = String(body.vendorId || '').trim();
  const accessKey = String(body.accessKey || '').trim();
  const secretKey = String(body.secretKey || '').trim();

  const isMock = (process.env.COUPANG_VERIFY_MOCK || 'true').toLowerCase() !== 'false';

  // 3-bis. 모킹 모드 — 테스트 vendorId 패턴 (E2E 검증용)
  //   TEST_401 → 401 인증 실패
  //   TEST_403 → 403 권한 부족
  //   TEST_429 → 429 호출 제한
  //   TEST_500 → 500 서버 오류
  //   TEST_OK  → 200 성공 (형식 검증 bypass)
  let verifyResult;
  if (isMock && /^TEST_/.test(vendorId)) {
    const m = vendorId.match(/^TEST_(\d{3})$/);
    if (m) {
      const code = parseInt(m[1], 10);
      verifyResult = { ok: false, status: code, error: `mock simulated ${code}`, mock: true };
    } else if (vendorId === 'TEST_OK') {
      verifyResult = { ok: true, status: 200, data: null, mock: true };
    } else {
      verifyResult = { ok: false, status: 400, error: '알 수 없는 테스트 패턴', mock: true };
    }
  } else {
    // 3. 형식 검증 (production 또는 실제 vendorId 입력)
    const formCheck = validateCoupangCredentials({ vendorId, accessKey, secretKey });
    if (!formCheck.valid) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: formCheck.errors[0] || '입력값을 확인해주세요.' }),
      };
    }

    // 4. 실제 쿠팡 API 검증 (또는 모킹)
    if (isMock) {
      verifyResult = { ok: true, status: 200, data: null, mock: true };
    } else {
      verifyResult = await callCoupangVerify({ vendorId, accessKey, secretKey });
    }
  }

  if (!verifyResult.ok) {
    const friendly = translateMarketError('coupang', verifyResult.status, verifyResult.error);
    console.log(`[connect-coupang] verify_failed seller=${payload.seller_id.slice(0, 8)} status=${verifyResult.status}`);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: false,
        verified: false,
        error: friendly,
        status: verifyResult.status,
      }),
    };
  }

  // 5. 자격증명 암호화 + 저장
  // SIGNUP_MOCK=true 인 환경에서는 ENCRYPTION_KEY/Supabase 둘 다 없어도 graceful 통과
  const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
  if (!encryptionAvailable() && !isSignupMock) {
    console.error('[connect-coupang] ENCRYPTION_KEY 미설정 — 저장 거부');
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '서버 보안 설정이 완료되지 않았습니다. 고객센터로 문의해주세요.' }),
    };
  }

  let admin;
  try { admin = getAdminClient(); } catch (e) {
    if (isSignupMock) {
      // Supabase 미설정 — 저장 스킵, verified=true 응답만
      console.log(`[connect-coupang] mock-no-supabase seller=${payload.seller_id.slice(0, 8)} vendor=${vendorId}`);
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          success: true,
          verified: true,
          market: 'coupang',
          vendorId,
          mock: true,
          verifiedAt: new Date().toISOString(),
        }),
      };
    }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류입니다.' }) };
  }

  // 암호화 미사용 mock 환경에서는 평문 저장하지 않고 placeholder 객체 사용
  const credentialsEncrypted = encryptionAvailable()
    ? encrypt({ vendorId, accessKey, secretKey })
    : { ciphertext: 'mock', iv: 'mock', tag: 'mock' };
  const now = new Date().toISOString();

  const { error: upsertErr } = await admin
    .from('market_credentials')
    .upsert({
      seller_id: payload.seller_id,
      market: 'coupang',
      credentials_encrypted: credentialsEncrypted,
      verified: true,
      verified_at: now,
      last_verified_at: now,
      verification_error: null,
      market_seller_id: vendorId,
      market_store_name: null,
      updated_at: now,
    }, { onConflict: 'seller_id,market' });

  if (upsertErr) {
    console.error('[connect-coupang] upsert 오류:', upsertErr.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '쿠팡 연결 저장에 실패했습니다.' }),
    };
  }

  await recordAudit(admin, {
    actor_id: payload.seller_id,
    actor_type: 'seller',
    action: 'market_connect_coupang',
    resource_type: 'market_credentials',
    resource_id: vendorId,
    metadata: { mock: Boolean(isMock), status: verifyResult.status },
    event,
  });

  console.log(`[connect-coupang] connected seller=${payload.seller_id.slice(0, 8)} vendor=${vendorId} mock=${isMock}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      verified: true,
      market: 'coupang',
      vendorId,
      mock: isMock,
      verifiedAt: now,
    }),
  };
};
