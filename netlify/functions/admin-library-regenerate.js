// admin-library-regenerate.js — 특정 슬롯 재생성 트리거 (admin-only).
// POST /api/admin-library-regenerate
// Body: { industry, content_type, slot_index }
// generate-library-background 를 트리거.

const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { getAdminClient } = require('./_shared/supabase-admin');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const VALID_INDUSTRIES = ['cafe', 'restaurant', 'beauty', 'nail', 'flower', 'clothing', 'gym'];
const CONTENT_TYPES = ['image', 'video'];
const SLOTS_PER_TYPE = 2; // 업종당 이미지 2 + 영상 2

async function requireAdmin(event) {
  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) throw Object.assign(new Error('인증이 필요합니다.'), { statusCode: 401 });

  const admin = getAdminClient();
  const { data, error: dbErr } = await admin.from('users').select('is_admin').eq('id', user.id).single();
  if (dbErr || !data) throw Object.assign(new Error('사용자 조회 실패'), { statusCode: 500 });
  if (!data.is_admin) throw Object.assign(new Error('관리자 권한이 없습니다.'), { statusCode: 401 });

  return { userId: user.id };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    await requireAdmin(event);
  } catch (err) {
    return {
      statusCode: err.statusCode || 401,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {}

  const { mode, industry, content_type: contentType, slot_index: slotIndex } = body;
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  // Fix-2: DEPLOY_PRIME_URL 우선 사용 (preview deploy 포함)
  const siteUrl = process.env.DEPLOY_PRIME_URL || process.env.URL || 'https://lumi.it';
  const targetUrl = `${siteUrl}/.netlify/functions/generate-library-background`;

  // mode='all': 7업종 × 2타입 × 2슬롯 = 28개를 순차 fire-and-forget으로 트리거
  if (mode === 'all') {
    try {
      let triggered = 0;
      for (const ind of VALID_INDUSTRIES) {
        for (const ct of CONTENT_TYPES) {
          for (let i = 0; i < SLOTS_PER_TYPE; i++) {
            // fire-and-forget — 응답 대기 없이 즉시 다음으로
            fetch(targetUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
              body: JSON.stringify({ industry: ind, content_type: ct, slot_index: i }),
            }).catch((e) => {
              console.warn(`[admin-library-regenerate] 트리거 경고 ${ind}/${ct}[${i}]:`, e.message);
            });
            triggered++;
            // OpenAI rate limit 방지: 호출 간 200ms 간격
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      }
      console.log(`[admin-library-regenerate] 전체 생성 트리거 완료: ${triggered}개`);
      return {
        statusCode: 202,
        headers: CORS,
        body: JSON.stringify({
          message: `전체 라이브러리 재생성이 트리거되었습니다. (${triggered}개 슬롯) 잠시 후 목록을 새로고침하세요.`,
          triggered,
        }),
      };
    } catch (err) {
      console.error('[admin-library-regenerate] 전체 생성 오류:', err.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류가 발생했습니다.' }) };
    }
  }

  // 단일 슬롯 재생성 모드
  if (!industry || !VALID_INDUSTRIES.includes(industry)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '유효하지 않은 업종입니다.' }) };
  }
  if (!contentType || !['image', 'video'].includes(contentType)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '유효하지 않은 content_type입니다. (image | video)' }) };
  }
  if (typeof slotIndex !== 'number' || slotIndex < 0 || slotIndex > 1) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'slot_index는 0 또는 1이어야 합니다.' }) };
  }

  try {
    // fire-and-forget (non-blocking)
    fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
      body: JSON.stringify({ industry, content_type: contentType, slot_index: slotIndex }),
    }).catch((e) => {
      console.warn('[admin-library-regenerate] background 트리거 경고:', e.message);
    });

    console.log(`[admin-library-regenerate] 재생성 트리거: ${industry}/${contentType}[${slotIndex}]`);

    return {
      statusCode: 202,
      headers: CORS,
      body: JSON.stringify({
        message: `${industry} ${contentType} 슬롯 ${slotIndex} 재생성이 시작되었습니다. 잠시 후 라이브러리를 새로고침하세요.`,
        industry,
        content_type: contentType,
        slot_index: slotIndex,
      }),
    };
  } catch (err) {
    console.error('[admin-library-regenerate] 예기치 않은 오류:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류가 발생했습니다.' }) };
  }
};
