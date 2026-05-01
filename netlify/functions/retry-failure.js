// 실패 재시도 / 무시 처리 — Sprint 5 실패 추적
// POST /api/retry-failure
// Body: { failure_id, action? } — action: 'retry' (기본) | 'resolve' (무시·해결 처리)
//
// 동작:
// 1. failure_log 조회 + 셀러 검증
// 2. action = 'resolve' → resolved=true 갱신 후 반환
// 3. action = 'retry'   → 카테고리별 내부 함수 호출 (fetch)
// 4. 성공 시 resolved=true, 실패 시 retry_count++

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');

// 카테고리 → 내부 API 경로 매핑
// 실제 Netlify 함수 내부 호출은 fetch(SITE_URL + '/api/...') 방식 사용
const CATEGORY_ENDPOINT = {
  product_register: '/api/register-product',
  product_update: '/api/update-product',
  tracking_send: '/api/submit-tracking',
  order_collect: '/api/sync-orders',
  claim_process: '/api/process-return',
  mapping: null, // 매핑은 자동 재시도 불가 — 수동 해결 필요
};

async function callInternalRetry(category, rawResponse, siteUrl, token) {
  const endpoint = CATEGORY_ENDPOINT[category];
  if (!endpoint) {
    return { success: false, error: '이 카테고리는 자동 재시도를 지원하지 않아요. 직접 처리해 주세요.' };
  }

  // raw_response에 저장된 원본 요청 페이로드로 재시도
  const retryBody = rawResponse?.retry_payload || rawResponse?.request_body || null;
  if (!retryBody) {
    return { success: false, error: '재시도 페이로드가 없어요. 직접 처리해 주세요.' };
  }

  try {
    const res = await fetch(`${siteUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: typeof retryBody === 'string' ? retryBody : JSON.stringify(retryBody),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success !== false) {
      return { success: true, data };
    }
    return { success: false, error: data.error || `마켓 응답 오류 (${res.status})` };
  } catch (err) {
    return { success: false, error: `네트워크 오류: ${err.message}` };
  }
}

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

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) { /* */ }

  const { failure_id, action = 'retry' } = body;
  if (!failure_id) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'failure_id가 필요해요.' }) };
  }
  if (!['retry', 'resolve'].includes(action)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'action은 retry 또는 resolve여야 해요.' }) };
  }

  let admin = null;
  try { admin = getAdminClient(); } catch (_) { /* */ }
  if (!admin) {
    return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: 'DB 연결 실패' }) };
  }

  try {
    // 실패 항목 조회
    const { data: failure, error: fetchErr } = await admin
      .from('failure_log')
      .select('*')
      .eq('id', failure_id)
      .eq('seller_id', payload.seller_id)
      .single();

    if (fetchErr || !failure) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '실패 항목을 찾을 수 없어요.' }) };
    }

    if (failure.resolved) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '이미 해결된 항목이에요.' }) };
    }

    // 무시·해결 처리
    if (action === 'resolve') {
      const { error: updErr } = await admin
        .from('failure_log')
        .update({ resolved: true, resolved_at: new Date().toISOString() })
        .eq('id', failure_id);
      if (updErr) throw updErr;
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ success: true, message: '해결 처리되었어요.' }),
      };
    }

    // 재시도
    const siteUrl = process.env.URL || 'https://lumi.it.kr';
    const retryResult = await callInternalRetry(failure.category, failure.raw_response, siteUrl, token);

    if (retryResult.success) {
      // 성공 → resolved=true
      await admin
        .from('failure_log')
        .update({ resolved: true, resolved_at: new Date().toISOString(), last_retry_at: new Date().toISOString() })
        .eq('id', failure_id);
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ success: true, message: '재시도 성공! 해결 처리되었어요.' }),
      };
    } else {
      // 실패 → retry_count++
      await admin
        .from('failure_log')
        .update({ retry_count: (failure.retry_count || 0) + 1, last_retry_at: new Date().toISOString() })
        .eq('id', failure_id);
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ success: false, error: retryResult.error || '재시도에 실패했어요.' }),
      };
    }
  } catch (err) {
    console.error('[retry-failure]', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '처리 중 오류가 발생했어요.' }),
    };
  }
};
