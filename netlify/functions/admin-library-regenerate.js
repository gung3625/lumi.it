const { corsHeaders, getOrigin } = require('./_shared/auth');
// admin-library-regenerate.js — 특정 슬롯 재생성 트리거 (admin-only).
// POST /api/admin-library-regenerate
// Body: { industry, content_type, slot_index }
// generate-library-background 를 트리거.

const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { getAdminClient } = require('./_shared/supabase-admin');


const VALID_INDUSTRIES = ['cafe', 'restaurant', 'beauty', 'nail', 'flower', 'clothing', 'gym'];
const CONTENT_TYPES = ['image', 'video'];
const SLOTS_PER_TYPE = 2; // 업종당 이미지 2 + 영상 2

async function requireAdmin(event) {
  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) throw Object.assign(new Error('인증이 필요합니다.'), { statusCode: 401 });

  const admin = getAdminClient();
  const { data, error: dbErr } = await admin.from('sellers').select('is_admin').eq('id', user.id).single();
  if (dbErr || !data) throw Object.assign(new Error('사용자 조회 실패'), { statusCode: 500 });
  if (!data.is_admin) throw Object.assign(new Error('관리자 권한이 없습니다.'), { statusCode: 401 });

  return { userId: user.id };
}

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    await requireAdmin(event);
  } catch (err) {
    return {
      statusCode: err.statusCode || 401,
      headers: headers,
      body: JSON.stringify({ error: err.message }),
    };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {}

  const { mode, industry, content_type: contentType, slot_index: slotIndex } = body;
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  // Fix-2: DEPLOY_PRIME_URL 우선 사용 (preview deploy 포함)
  const siteUrl = process.env.DEPLOY_PRIME_URL || process.env.URL || 'https://lumi.it.kr';
  const targetUrl = `${siteUrl}/.netlify/functions/generate-library-background`;

  // mode='all': 7업종 × 2타입 × 2슬롯 = 28개 트리거
  // Background Function은 202를 ~500ms 안에 반환하므로 await 해도 OK (Lambda 종료 전 fetch 유실 방지).
  if (mode === 'all') {
    try {
      const tasks = [];
      for (const ind of VALID_INDUSTRIES) {
        for (const ct of CONTENT_TYPES) {
          for (let i = 0; i < SLOTS_PER_TYPE; i++) {
            tasks.push({ industry: ind, content_type: ct, slot_index: i });
          }
        }
      }

      // 순차 + 각 호출 await (Lambda 종료로 fetch 유실되는 문제 해결)
      // Background Function은 202만 받고 끊으므로 총 소요 ~5–15s (Lambda 26s 한도 내)
      let triggered = 0;
      let failed = 0;
      for (const t of tasks) {
        try {
          const res = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
            body: JSON.stringify(t),
          });
          if (res.status === 202 || res.status === 200) {
            triggered++;
          } else {
            failed++;
            let snippet = '';
            try { snippet = (await res.text()).slice(0, 120); } catch (_) {}
            console.warn(`[admin-library-regenerate] ${t.industry}/${t.content_type}[${t.slot_index}] HTTP ${res.status}: ${snippet}`);
          }
        } catch (e) {
          failed++;
          console.warn(`[admin-library-regenerate] fetch 실패 ${t.industry}/${t.content_type}[${t.slot_index}]:`, e.message);
        }
        // OpenAI rate limit 방지: 호출 간 150ms 간격
        await new Promise((r) => setTimeout(r, 150));
      }
      console.log(`[admin-library-regenerate] 전체 생성 트리거 완료: 성공 ${triggered} / 실패 ${failed}`);
      return {
        statusCode: 202,
        headers: headers,
        body: JSON.stringify({
          message: `전체 라이브러리 재생성이 트리거되었습니다. (성공 ${triggered} / 실패 ${failed}) 잠시 후 목록을 새로고침하세요.`,
          triggered,
          failed,
        }),
      };
    } catch (err) {
      console.error('[admin-library-regenerate] 전체 생성 오류:', err.message);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '서버 오류가 발생했습니다.' }) };
    }
  }

  // 단일 슬롯 재생성 모드
  if (!industry || !VALID_INDUSTRIES.includes(industry)) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: '유효하지 않은 업종입니다.' }) };
  }
  if (!contentType || !['image', 'video'].includes(contentType)) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: '유효하지 않은 content_type입니다. (image | video)' }) };
  }
  if (typeof slotIndex !== 'number' || slotIndex < 0 || slotIndex > 1) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'slot_index는 0 또는 1이어야 합니다.' }) };
  }

  try {
    // Background Function의 202 응답까지만 await (Lambda 종료로 fetch 유실 방지).
    // 실제 생성은 Background Function 내부에서 계속 진행됨.
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
      body: JSON.stringify({ industry, content_type: contentType, slot_index: slotIndex }),
    }).catch((e) => {
      console.warn('[admin-library-regenerate] background 트리거 경고:', e.message);
      return null;
    });

    if (!res || (res.status !== 202 && res.status !== 200)) {
      let snippet = '';
      try { snippet = res ? (await res.text()).slice(0, 150) : 'no response'; } catch (_) {}
      console.error(`[admin-library-regenerate] 트리거 실패 ${industry}/${contentType}[${slotIndex}]: ${res?.status} ${snippet}`);
      return { statusCode: 502, headers: headers, body: JSON.stringify({ error: '생성 함수 트리거에 실패했습니다.' }) };
    }

    console.log(`[admin-library-regenerate] 재생성 트리거: ${industry}/${contentType}[${slotIndex}]`);

    return {
      statusCode: 202,
      headers: headers,
      body: JSON.stringify({
        message: `${industry} ${contentType} 슬롯 ${slotIndex} 재생성이 시작되었습니다. 잠시 후 라이브러리를 새로고침하세요.`,
        industry,
        content_type: contentType,
        slot_index: slotIndex,
      }),
    };
  } catch (err) {
    console.error('[admin-library-regenerate] 예기치 않은 오류:', err.message);
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '서버 오류가 발생했습니다.' }) };
  }
};
