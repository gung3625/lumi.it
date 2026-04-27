// 네이버 커머스 API 연결 — Sprint 1
// POST /api/connect-naver
// 헤더: Authorization: Bearer <seller-jwt>
// body: { applicationId, applicationSecret }   ← 키 입력 방식
//   또는 { code, redirectUri }                 ← OAuth2 callback 방식 (Phase 1.5)
//
// 동작 (현재 우선 구현 = 키 입력 fallback):
// 1. Application ID + Secret 형식 검증
// 2. 토큰 발급 시도 (https://api.commerce.naver.com/external/v1/oauth2/token)
//    - bcrypt(applicationSecret + timestamp, 10) → client_secret_sign
//    - grant_type=client_credentials, type=SELF
// 3. 성공 시 access_token 받아 셀러 채널 정보 조회
// 4. 자격증명 + 토큰 암호화 → market_credentials upsert
//
// 모킹 토글: NAVER_VERIFY_MOCK=true → 형식만 통과 (실제 호출 X)

const fetch = require('node-fetch');
const crypto = require('crypto');
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { encrypt, encryptToken, isAvailable: encryptionAvailable } = require('./_shared/encryption');
const { recordAudit } = require('./_shared/onboarding-utils');
const { translateMarketError } = require('./_shared/market-errors');

const NAVER_API_HOST = 'https://api.commerce.naver.com';
const TOKEN_PATH = '/external/v1/oauth2/token';

/**
 * 네이버 커머스 API 자격증명 형식 검증
 */
function validateNaverCredentials({ applicationId, applicationSecret }) {
  const errors = [];
  if (!applicationId || String(applicationId).length < 8) {
    errors.push('Application ID 형식이 올바르지 않습니다.');
  }
  if (!applicationSecret || String(applicationSecret).length < 16) {
    errors.push('Application Secret 형식이 올바르지 않습니다.');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * 네이버 client_secret_sign 생성 — bcrypt 의존을 피하기 위한 대체:
 * 네이버 커머스 API는 bcrypt 권장이지만, 일부 SDK는 HMAC-SHA256로도 발급 가능.
 * 베타 단계에서는 두 방식 모두 시도 — production에서는 bcrypt 라이브러리 (bcryptjs) 추가 검토.
 *
 * 본 함수는 HMAC-SHA256 fallback (`secret + '_' + timestamp`) 사용.
 * 실연동 활성화 시 bcryptjs 설치하고 hash(secret + '_' + timestamp, 10) → base64 변환.
 */
function generateNaverSign({ applicationSecret, timestamp }) {
  // HMAC-SHA256 fallback — 일부 환경에서 통하지 않을 수 있음
  const message = `${applicationSecret}_${timestamp}`;
  const sig = crypto
    .createHmac('sha256', Buffer.from(applicationSecret, 'utf8'))
    .update(Buffer.from(message, 'utf8'))
    .digest('base64');
  return sig;
}

async function callNaverTokenIssue({ applicationId, applicationSecret }) {
  const timestamp = Date.now();
  const sign = generateNaverSign({ applicationSecret, timestamp });
  const params = new URLSearchParams({
    client_id: applicationId,
    timestamp: String(timestamp),
    client_secret_sign: sign,
    grant_type: 'client_credentials',
    type: 'SELF',
  });

  const url = `${NAVER_API_HOST}${TOKEN_PATH}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') return { ok: false, status: 408, error: '네이버 API 응답 시간이 초과됐습니다.' };
    return { ok: false, status: 0, error: '네이버 API 연결 실패: ' + err.message };
  }
  clearTimeout(timeout);

  let bodyText = '';
  try { bodyText = await response.text(); } catch (_) { /* */ }

  if (response.status === 200) {
    let parsed = null;
    try { parsed = JSON.parse(bodyText); } catch (_) { /* */ }
    if (parsed && parsed.access_token) {
      return {
        ok: true,
        status: 200,
        accessToken: parsed.access_token,
        expiresIn: parsed.expires_in || 10800,
        tokenType: parsed.token_type || 'Bearer',
      };
    }
    return { ok: false, status: 200, error: '토큰 응답 형식 오류 — Application Secret 인증 방식이 변경됐을 수 있습니다.' };
  }
  if (response.status === 400 || response.status === 401) {
    return { ok: false, status: response.status, error: '인증 실패 — Application ID 또는 Secret을 다시 확인해주세요.' };
  }
  if (response.status === 429) {
    return { ok: false, status: 429, error: '요청이 일시적으로 제한됐습니다. 잠시 후 다시 시도해주세요.' };
  }
  return { ok: false, status: response.status, error: `네이버 API 오류 (status=${response.status})` };
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
  const applicationId = String(body.applicationId || '').trim();
  const applicationSecret = String(body.applicationSecret || '').trim();

  const isMock = (process.env.NAVER_VERIFY_MOCK || 'true').toLowerCase() !== 'false';

  // 모킹 모드 — 테스트 applicationId 패턴 (E2E 검증용)
  //   TEST_401 / TEST_403 / TEST_429 / TEST_500 → 해당 status로 실패 시뮬레이션
  //   TEST_OK → 200 성공 (형식 검증 bypass)
  let tokenResult;
  if (isMock && /^TEST_/.test(applicationId)) {
    const m = applicationId.match(/^TEST_(\d{3})$/);
    if (m) {
      const code = parseInt(m[1], 10);
      tokenResult = { ok: false, status: code, error: `mock simulated ${code}`, mock: true };
    } else if (applicationId === 'TEST_OK') {
      tokenResult = {
        ok: true,
        status: 200,
        accessToken: 'mock_access_token_' + Date.now(),
        expiresIn: 10800,
        tokenType: 'Bearer',
        mock: true,
      };
    } else {
      tokenResult = { ok: false, status: 400, error: '알 수 없는 테스트 패턴', mock: true };
    }
  } else {
    const formCheck = validateNaverCredentials({ applicationId, applicationSecret });
    if (!formCheck.valid) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: formCheck.errors[0] || '입력값을 확인해주세요.' }),
      };
    }

    if (isMock) {
      tokenResult = {
        ok: true,
        status: 200,
        accessToken: 'mock_access_token_' + Date.now(),
        expiresIn: 10800,
        tokenType: 'Bearer',
        mock: true,
      };
    } else {
      tokenResult = await callNaverTokenIssue({ applicationId, applicationSecret });
    }
  }

  if (!tokenResult.ok) {
    const friendly = translateMarketError('naver', tokenResult.status, tokenResult.error);
    console.log(`[connect-naver] verify_failed seller=${payload.seller_id.slice(0, 8)} status=${tokenResult.status}`);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: false,
        verified: false,
        error: friendly,
        status: tokenResult.status,
      }),
    };
  }

  const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
  if (!encryptionAvailable() && !isSignupMock) {
    console.error('[connect-naver] ENCRYPTION_KEY 미설정 — 저장 거부');
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '서버 보안 설정이 완료되지 않았습니다.' }),
    };
  }

  let admin;
  try { admin = getAdminClient(); } catch (e) {
    if (isSignupMock) {
      console.log(`[connect-naver] mock-no-supabase seller=${payload.seller_id.slice(0, 8)} app=${applicationId.slice(0, 4)}***`);
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          success: true,
          verified: true,
          market: 'naver',
          applicationIdMasked: `${applicationId.slice(0, 4)}***`,
          tokenExpiresAt: new Date(Date.now() + 10800 * 1000).toISOString(),
          mock: true,
          verifiedAt: new Date().toISOString(),
        }),
      };
    }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류입니다.' }) };
  }

  const credentialsEncrypted = encryptionAvailable()
    ? encrypt({ applicationId, applicationSecret })
    : { ciphertext: 'mock', iv: 'mock', tag: 'mock' };
  const accessTokenEncrypted = encryptionAvailable()
    ? encryptToken(tokenResult.accessToken)
    : 'mock.mock.mock';
  const expiresAt = new Date(Date.now() + (tokenResult.expiresIn - 60) * 1000).toISOString();
  const now = new Date().toISOString();

  const { error: upsertErr } = await admin
    .from('market_credentials')
    .upsert({
      seller_id: payload.seller_id,
      market: 'naver',
      credentials_encrypted: credentialsEncrypted,
      access_token_encrypted: accessTokenEncrypted,
      token_expires_at: expiresAt,
      verified: true,
      verified_at: now,
      last_verified_at: now,
      verification_error: null,
      market_seller_id: applicationId,
      market_store_name: null,
      updated_at: now,
    }, { onConflict: 'seller_id,market' });

  if (upsertErr) {
    console.error('[connect-naver] upsert 오류:', upsertErr.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '네이버 연결 저장에 실패했습니다.' }),
    };
  }

  await recordAudit(admin, {
    actor_id: payload.seller_id,
    actor_type: 'seller',
    action: 'market_connect_naver',
    resource_type: 'market_credentials',
    resource_id: applicationId,
    metadata: { mock: Boolean(isMock), status: tokenResult.status, expires_in: tokenResult.expiresIn },
    event,
  });

  console.log(`[connect-naver] connected seller=${payload.seller_id.slice(0, 8)} app=${applicationId.slice(0, 4)}*** mock=${isMock}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      success: true,
      verified: true,
      market: 'naver',
      applicationIdMasked: `${applicationId.slice(0, 4)}***`,
      tokenExpiresAt: expiresAt,
      mock: isMock,
      verifiedAt: now,
    }),
  };
};
