// 매장 정보 업데이트 — settings.html "저장하기" 버튼이 호출
// POST /api/update-profile
//
// 입력: Authorization: Bearer <jwt> (Supabase JWT 우선 / seller-jwt fallback)
//       body: { storeName?, industry?, phone?, displayName?, ownerName?,
//               storeDesc?, toneSample1?, toneSample2?, toneSample3? }
//             (camelCase, 미전달 키는 무시)
//
// 동작:
//   1) JWT 검증 → seller 행 식별 (me.js / account-delete.js와 동일 패턴)
//   2) 입력 검증 (길이·형식)
//   3) sellers UPDATE (camel→snake 매핑, 미전달 키는 그대로 둠)
//   4) 응답: { ok: true, profile: {...} }
//
// 주의:
//   - 빈 문자열은 NULL로 변환 (사용자가 명시적으로 비움)
//   - 미전달 키 (undefined)는 무시 (부분 업데이트)

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

// camelCase → sellers 컬럼 매핑 (업데이트 허용 컬럼만)
const FIELD_MAP = {
  storeName: 'store_name',
  industry: 'industry',
  phone: 'phone',
  displayName: 'display_name',
  ownerName: 'owner_name',
  storeDesc: 'store_desc',
  toneSample1: 'tone_sample_1',
  toneSample2: 'tone_sample_2',
  toneSample3: 'tone_sample_3',
  toneRequest: 'tone_request',
};

// 길이 제한 (sellers 컬럼 특성에 맞게)
const MAX_LEN = {
  store_name: 50,    // signup-complete와 일치
  industry: 50,
  phone: 20,
  display_name: 50,
  owner_name: 50,
  store_desc: 1000,
  tone_sample_1: 500,
  tone_sample_2: 500,
  tone_sample_3: 500,
  tone_request: 500,
};

function sanitizeValue(snakeKey, raw) {
  if (raw === null) return null;
  if (typeof raw !== 'string') return undefined; // 잘못된 타입 → 무시
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;          // 빈 문자열 → NULL
  const limit = MAX_LEN[snakeKey];
  if (limit && trimmed.length > limit) return undefined; // 길이 초과 → 검증 실패용 sentinel
  return trimmed;
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
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
    console.error('[update-profile] admin client 초기화 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류입니다.' }) };
  }

  // ──────────────────────────────────────────────
  // 1) JWT 검증 → seller 행 식별
  //    Supabase JWT 우선 (OAuth 사용자), seller-jwt fallback (카카오 자체 JWT)
  // ──────────────────────────────────────────────
  let sellerQuery = null;
  try {
    const { data: supaAuthData } = await admin.auth.getUser(token);
    if (supaAuthData && supaAuthData.user && supaAuthData.user.email) {
      sellerQuery = { field: 'email', value: supaAuthData.user.email };
    }
  } catch (_) { /* fallthrough */ }

  if (!sellerQuery) {
    const { payload, error: authErr } = verifySellerToken(token);
    if (authErr || !payload) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 만료되었습니다. 다시 로그인해주세요.' }) };
    }
    sellerQuery = { field: 'id', value: payload.seller_id };
  }

  // ──────────────────────────────────────────────
  // 2) 입력 파싱 + 검증
  // ──────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청 형식입니다.' }) };
  }

  const update = {};
  const validationErrors = [];

  for (const [camel, snake] of Object.entries(FIELD_MAP)) {
    if (body[camel] === undefined) continue; // 미전달 키 무시
    const v = sanitizeValue(snake, body[camel]);
    if (v === undefined) {
      validationErrors.push(`${camel}: 형식이 올바르지 않거나 길이가 초과되었습니다.`);
      continue;
    }
    update[snake] = v;
  }

  // phone은 단순 형식 체크 (숫자·하이픈만 허용, 비워두기는 NULL)
  if (Object.prototype.hasOwnProperty.call(update, 'phone') && update.phone !== null) {
    if (!/^[0-9\-+\s()]+$/.test(update.phone)) {
      validationErrors.push('phone: 숫자·하이픈만 입력해주세요.');
      delete update.phone;
    }
  }

  if (validationErrors.length > 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: validationErrors.join(' ') }) };
  }

  if (Object.keys(update).length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '변경할 내용이 없습니다.' }) };
  }

  update.updated_at = new Date().toISOString();

  // ──────────────────────────────────────────────
  // 3) sellers UPDATE (본인 row만)
  // ──────────────────────────────────────────────
  try {
    const { data, error } = await admin
      .from('sellers')
      .update(update)
      .eq(sellerQuery.field, sellerQuery.value)
      .select('id, store_name, industry, phone, display_name, owner_name, store_desc, tone_sample_1, tone_sample_2, tone_sample_3, tone_request, updated_at')
      .maybeSingle();

    if (error) {
      console.error('[update-profile] sellers UPDATE 실패:', error.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '저장 중 오류가 발생했습니다.' }) };
    }

    if (!data) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '계정을 찾을 수 없습니다.' }) };
    }

    console.log(`[update-profile] seller=${data.id.slice(0, 8)} keys=${Object.keys(update).filter(k => k !== 'updated_at').join(',')}`);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        success: true,
        profile: {
          id: data.id,
          storeName: data.store_name || null,
          industry: data.industry || null,
          displayName: data.display_name || null,
          ownerName: data.owner_name || null,
          storeDesc: data.store_desc || null,
          toneSample1: data.tone_sample_1 || null,
          toneSample2: data.tone_sample_2 || null,
          toneSample3: data.tone_sample_3 || null,
          toneRequest: data.tone_request || '',
          updatedAt: data.updated_at,
        },
      }),
    };
  } catch (err) {
    console.error('[update-profile] 예외:', err && err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '저장 중 오류가 발생했습니다.' }) };
  }
};
