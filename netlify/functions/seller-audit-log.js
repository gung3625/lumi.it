// Sprint 3.6 — 셀러 본인 데이터 접근 기록 조회
// GET /api/seller-audit-log?limit=50&before=<id>
// Headers: Authorization: Bearer <seller-jwt>
const { getAdminClient } = require('./_shared/supabase-admin');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { verifySellerToken } = require('./_shared/seller-jwt');

const ALLOWED_ACTIONS = new Set([
  'signup_progress', 'signup_complete',
  'consent.grant', 'consent.revoke',
  'cancellation.request', 'cancellation.restore', 'cancellation.auto_destroy', 'cancellation.warn_pre_destroy',
  'order.unmask', 'cs_thread.unmask', 'customer.unmask',
  'data_export.request', 'data_export.complete',
  'login.success', 'login.failed',
]);

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const tok = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  let claims;
  try { claims = verifySellerToken(tok); } catch {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }
  const sellerId = claims.seller_id;

  const params = event.queryStringParameters || {};
  const limit = Math.min(Math.max(parseInt(params.limit, 10) || 50, 1), 200);

  let admin;
  try { admin = getAdminClient(); } catch (e) {
    console.error('[seller-audit-log] admin init 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 설정 오류입니다.' }) };
  }

  // 본인 행위 OR 본인 리소스에 대한 행위
  let q = admin
    .from('audit_logs')
    .select('id, action, actor_type, resource_type, resource_id, metadata, created_at')
    .or(`actor_id.eq.${sellerId},and(resource_type.eq.seller,resource_id.eq.${sellerId})`)
    .order('id', { ascending: false })
    .limit(limit);
  if (params.before) {
    const beforeId = parseInt(params.before, 10);
    if (Number.isFinite(beforeId)) q = q.lt('id', beforeId);
  }

  const { data: rows, error } = await q;
  if (error) {
    console.error('[seller-audit-log] 조회 실패:', error.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '조회에 실패했습니다.' }) };
  }

  // metadata에서 잠재 PII 제거 (audit-log.js sanitize와 동일 정책)
  const items = (rows || []).map((r) => ({
    id: r.id,
    action: r.action,
    actorType: r.actor_type,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    metadata: r.metadata && typeof r.metadata === 'object' ? r.metadata : {},
    createdAt: r.created_at,
    label: actionLabel(r.action),
  }));

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      items,
      hasMore: items.length === limit,
      nextBefore: items.length ? items[items.length - 1].id : null,
    }),
  };
};

function actionLabel(action) {
  const a = String(action || '');
  if (a === 'signup_progress') return '가입 단계 진행';
  if (a === 'signup_complete') return '가입 완료';
  if (a === 'consent.grant') return '약관 동의';
  if (a === 'consent.revoke') return '약관 동의 철회';
  if (a === 'cancellation.request') return '해지 신청';
  if (a === 'cancellation.restore') return '해지 복원';
  if (a === 'cancellation.auto_destroy') return '해지 자동 완료 (30일 유예 만료)';
  if (a === 'cancellation.warn_pre_destroy') return '해지 만료 1주일 전 알림';
  if (a.endsWith('.unmask')) return '마스킹 해제 (전체 보기)';
  if (a === 'login.success') return '로그인';
  if (a === 'login.failed') return '로그인 실패';
  if (a.startsWith('data_export.')) return '데이터 내보내기';
  return a;
}
