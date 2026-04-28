// 우선순위 큐 카드 — Sprint 3 (메인 화면 핵심)
// GET /api/priority-queue
// 응답: { cards: [...], totals: {...}, ai_message: "..." }

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { buildPriorityCards, buildMockPriorityCards } = require('./_shared/priority-queue');

function buildAiMessage(totals) {
  const total = totals.total_tasks || 0;
  if (total === 0) {
    return '오늘 처리할 일이 없어요. 잠시 쉬셔도 돼요.';
  }
  const minutes = Math.max(1, Math.round(total * 0.5));  // 평균 30초/건 가정
  return `오늘 처리할 일 ${total}개, 약 ${minutes}분이면 끝나요.`;
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { payload, error } = verifySellerToken(token);
  if (error || !payload) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요해요.' }) };
  }

  const isSignupMock = (process.env.SIGNUP_MOCK || 'false').toLowerCase() === 'true';
  let admin = null;
  try { admin = getAdminClient(); } catch { /* */ }

  if (!admin && isSignupMock) {
    const r = buildMockPriorityCards();
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ...r, ai_message: buildAiMessage(r.totals), mocked: true }),
    };
  }

  if (!admin) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류예요.' }) };
  }

  const result = await buildPriorityCards(admin, payload.seller_id);
  if (!result.ok) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '우선순위 카드를 불러오지 못했어요.' }) };
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ ...result, ai_message: buildAiMessage(result.totals) }),
  };
};
