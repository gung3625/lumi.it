// 셀러 brand 설정 저장/조회 — brand-admin.html "학습 내용 저장" 백엔드.
// GET  /api/brand-settings?sellerId=...   (sellerId 또는 본인)
// POST /api/brand-settings  body: { sellerId?, settings:{...} }
// 헤더: Authorization: Bearer <jwt> (관리자 only)
//
// 동작:
//   1) admin-guard 통과 (users.is_admin = true 또는 환경변수 폴백)
//   2) 대상 셀러 행 조회 (sellers.id 또는 호출 admin의 email → sellers.email)
//   3) GET: sellers.brand_settings + brand_settings_updated_at 반환
//   4) POST: settings whitelist 검증 후 sellers UPDATE
//
// 저장 위치: sellers.brand_settings (jsonb), sellers.brand_settings_updated_at
// (마이그: 20260507000006_sellers_brand_settings.sql)
//
// whitelist 키 (brand-admin.html saveAll() payload 기준):
//   tone        : 'friendly' | 'pro' | 'lively' | 'calm' | 'custom'
//   tone_custom : string (≤ 500자)
//   samples     : [{ text: string(≤2000), stars: 1..5 }] 최대 5개
//   ban_words   : [string(≤20)] 최대 20개
//   must_words  : [string(≤20)] 최대 20개
//   hashtags    : { season:[#tag(≤30)], product:[...], store:[...] } 그룹별 최대 30, 합계 30
//
// 반환:
//   200 { ok:true, data:{ sellerId, settings:{...}, updatedAt:'...' } }
//   400 검증 실패 / body 파싱 실패 / sellerId 형식
//   401 미인증
//   403 비관리자
//   404 셀러 없음
//   500 서버 오류
//
// 주의:
//   - whitelist 외 키는 무시 (임의 jsonb 저장 차단)
//   - 캡션 raw 텍스트(samples)는 로그에 출력하지 않음
//   - 이번 작업은 저장/조회만. 캡션 생성 함수가 brand_settings 를 읽도록 하는 wire는 후속 작업.

const { getAdminClient } = require('./_shared/supabase-admin');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { requireAdmin } = require('./_shared/admin-guard');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_TONES = ['friendly', 'pro', 'lively', 'calm', 'custom'];
const ALLOWED_HASHTAG_GROUPS = ['season', 'product', 'store'];

const MAX_TONE_CUSTOM_LEN = 500;
const MAX_SAMPLE_TEXT_LEN = 2000;
const MAX_SAMPLES = 5;
const MAX_WORD_LEN = 20;
const MAX_WORDS = 20;
const MAX_HASHTAG_LEN = 30;
const MAX_HASHTAGS_PER_GROUP = 30;
const MAX_HASHTAGS_TOTAL = 30;

// ──────────────────────────────────────────────
// 셀러 행 조회 (sellerId 우선, 아니면 호출자 email → sellers.email)
// ──────────────────────────────────────────────
async function loadSeller(admin, target) {
  if (target.sellerId) {
    const { data, error } = await admin
      .from('sellers')
      .select('id, email, brand_settings, brand_settings_updated_at')
      .eq('id', target.sellerId)
      .maybeSingle();
    if (error) {
      console.error('[brand-settings] sellers select 오류:', error.message);
      return { error: '셀러 조회 실패', status: 500 };
    }
    if (!data) return { error: '셀러를 찾을 수 없습니다.', status: 404 };
    return { seller: data };
  }

  // 호출자 email → sellers.email 매칭
  if (target.email) {
    const { data, error } = await admin
      .from('sellers')
      .select('id, email, brand_settings, brand_settings_updated_at')
      .eq('email', target.email)
      .maybeSingle();
    if (error) {
      console.error('[brand-settings] sellers by email 오류:', error.message);
      return { error: '셀러 조회 실패', status: 500 };
    }
    if (!data) return { error: '셀러를 찾을 수 없습니다.', status: 404 };
    return { seller: data };
  }

  return { error: '대상 셀러를 식별할 수 없습니다.', status: 400 };
}

// ──────────────────────────────────────────────
// settings whitelist 검증·정규화
// 잘못된 키는 drop, 잘못된 값은 무시(또는 trim/clip).
// 반환: { ok:true, value } | { ok:false, error }
// ──────────────────────────────────────────────
function validateSettings(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'settings는 객체여야 합니다.' };
  }

  const out = {};

  // tone
  if (input.tone !== undefined) {
    if (typeof input.tone !== 'string' || !ALLOWED_TONES.includes(input.tone)) {
      return { ok: false, error: 'tone 값이 올바르지 않습니다.' };
    }
    out.tone = input.tone;
  }

  // tone_custom
  if (input.tone_custom !== undefined) {
    if (typeof input.tone_custom !== 'string') {
      return { ok: false, error: 'tone_custom은 문자열이어야 합니다.' };
    }
    out.tone_custom = input.tone_custom.trim().slice(0, MAX_TONE_CUSTOM_LEN);
  }

  // samples: [{ text, stars }]
  if (input.samples !== undefined) {
    if (!Array.isArray(input.samples)) {
      return { ok: false, error: 'samples는 배열이어야 합니다.' };
    }
    if (input.samples.length > MAX_SAMPLES) {
      return { ok: false, error: `samples는 최대 ${MAX_SAMPLES}개까지 허용됩니다.` };
    }
    const cleaned = [];
    for (const s of input.samples) {
      if (!s || typeof s !== 'object') continue;
      const text = typeof s.text === 'string' ? s.text.trim().slice(0, MAX_SAMPLE_TEXT_LEN) : '';
      if (!text) continue;
      let stars = Number(s.stars);
      if (!Number.isFinite(stars)) stars = 3;
      stars = Math.max(1, Math.min(5, Math.round(stars)));
      cleaned.push({ text, stars });
    }
    out.samples = cleaned;
  }

  // ban_words / must_words
  for (const key of ['ban_words', 'must_words']) {
    if (input[key] === undefined) continue;
    if (!Array.isArray(input[key])) {
      return { ok: false, error: `${key}는 배열이어야 합니다.` };
    }
    if (input[key].length > MAX_WORDS) {
      return { ok: false, error: `${key}는 최대 ${MAX_WORDS}개까지 허용됩니다.` };
    }
    const seen = new Set();
    const cleaned = [];
    for (const w of input[key]) {
      if (typeof w !== 'string') continue;
      const t = w.trim().slice(0, MAX_WORD_LEN);
      if (!t) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      cleaned.push(t);
    }
    out[key] = cleaned;
  }

  // hashtags: { season:[], product:[], store:[] }
  if (input.hashtags !== undefined) {
    if (input.hashtags == null || typeof input.hashtags !== 'object' || Array.isArray(input.hashtags)) {
      return { ok: false, error: 'hashtags는 객체여야 합니다.' };
    }
    const cleaned = { season: [], product: [], store: [] };
    let total = 0;
    for (const g of ALLOWED_HASHTAG_GROUPS) {
      const arr = input.hashtags[g];
      if (arr === undefined) continue;
      if (!Array.isArray(arr)) {
        return { ok: false, error: `hashtags.${g}는 배열이어야 합니다.` };
      }
      const seen = new Set();
      for (const t of arr) {
        if (typeof t !== 'string') continue;
        let tag = t.trim();
        if (!tag) continue;
        if (!tag.startsWith('#')) tag = '#' + tag;
        tag = tag.slice(0, MAX_HASHTAG_LEN);
        if (seen.has(tag)) continue;
        seen.add(tag);
        cleaned[g].push(tag);
        total += 1;
        if (cleaned[g].length > MAX_HASHTAGS_PER_GROUP) {
          return { ok: false, error: `hashtags.${g}는 최대 ${MAX_HASHTAGS_PER_GROUP}개까지 허용됩니다.` };
        }
        if (total > MAX_HASHTAGS_TOTAL) {
          return { ok: false, error: `hashtags 합계는 최대 ${MAX_HASHTAGS_TOTAL}개까지 허용됩니다.` };
        }
      }
    }
    out.hashtags = cleaned;
  }

  return { ok: true, value: out };
}

// ──────────────────────────────────────────────
// 핸들러
// ──────────────────────────────────────────────
exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: 'Method not allowed' }),
    };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[brand-settings] admin client 초기화 실패:', e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: '서버 설정 오류입니다.' }),
    };
  }

  // 관리자 권한 체크
  const guard = await requireAdmin(event, admin);
  if (!guard.ok) {
    return {
      statusCode: guard.status,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: guard.error }),
    };
  }

  // 대상 sellerId 추출 (query/body) — 미지정 시 호출자 email로 fallback
  const target = {};
  if (event.httpMethod === 'GET') {
    const qs = (event.queryStringParameters && event.queryStringParameters.sellerId) || '';
    if (qs) {
      if (!UUID_RE.test(String(qs))) {
        return {
          statusCode: 400,
          headers: CORS,
          body: JSON.stringify({ ok: false, error: 'sellerId 형식이 올바르지 않습니다.' }),
        };
      }
      target.sellerId = String(qs);
    } else {
      target.email = String(guard.user.email || '').toLowerCase();
    }

    const found = await loadSeller(admin, target);
    if (found.error) {
      return {
        statusCode: found.status,
        headers: CORS,
        body: JSON.stringify({ ok: false, error: found.error }),
      };
    }
    const seller = found.seller;
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        data: {
          sellerId: seller.id,
          settings: seller.brand_settings || {},
          updatedAt: seller.brand_settings_updated_at || null,
        },
      }),
    };
  }

  // POST
  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: '잘못된 요청 형식입니다.' }),
    };
  }

  if (body.sellerId !== undefined && body.sellerId !== null && body.sellerId !== '') {
    if (!UUID_RE.test(String(body.sellerId))) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ ok: false, error: 'sellerId 형식이 올바르지 않습니다.' }),
      };
    }
    target.sellerId = String(body.sellerId);
  } else {
    target.email = String(guard.user.email || '').toLowerCase();
  }

  // settings 검증
  const validated = validateSettings(body.settings);
  if (!validated.ok) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: validated.error }),
    };
  }

  const found = await loadSeller(admin, target);
  if (found.error) {
    return {
      statusCode: found.status,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: found.error }),
    };
  }
  const seller = found.seller;

  // 기존 settings 위에 whitelist 키만 머지 (부분 업데이트 허용)
  const merged = Object.assign({}, seller.brand_settings || {}, validated.value);
  const updatedAt = new Date().toISOString();

  try {
    const { error: upErr } = await admin
      .from('sellers')
      .update({
        brand_settings: merged,
        brand_settings_updated_at: updatedAt,
      })
      .eq('id', seller.id);
    if (upErr) {
      console.error('[brand-settings] sellers UPDATE 오류:', upErr.message);
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ ok: false, error: '저장 실패' }),
      };
    }
  } catch (e) {
    console.error('[brand-settings] sellers UPDATE 예외:', e && e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: '저장 실패' }),
    };
  }

  // 로그 — raw 캡션·이름은 출력 X. 키 갯수만.
  const keysCount = Object.keys(validated.value).length;
  const samplesCount = Array.isArray(validated.value.samples) ? validated.value.samples.length : 0;
  console.log(
    `[brand-settings] admin=${String(guard.user.id).slice(0, 8)} seller=${String(seller.id).slice(0, 8)} ` +
      `keys=${keysCount} samples=${samplesCount}`
  );

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      data: {
        sellerId: seller.id,
        settings: merged,
        updatedAt,
      },
    }),
  };
};
