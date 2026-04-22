// 자동응답 설정 조회/저장 — Bearer 토큰 인증 필수
// GET: 현재 설정 반환 (없으면 기본값 생성 후 반환)
// POST: 설정 upsert — ai_mode는 business 플랜일 때만 사장님 토글 허용
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { isAdminEmail, isAdminUserId } = require('./_shared/admin');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const DEFAULT_SETTINGS = {
  enabled: false,
  shadow_mode: true,
  keyword_rules: [],
  default_comment_reply: '감사합니다 😊 궁금한 점은 DM으로 문의해 주세요!',
  default_dm_reply: '안녕하세요! 메시지 감사해요 😊',
  negative_keyword_blocklist: ['비싸','별로','불만','환불','최악','맛없','이상해','짜증','실망'],
  ai_mode: false,
  ai_confidence_threshold: 0.85,
};

// business 플랜만 AI 모드 토글 가능
function canUseAiMode(plan) {
  return plan === 'business';
}

// 설정 조회 또는 기본값 생성
// - business 플랜이 아니면 ai_mode=false 강제
// - business 플랜이면 DB 저장값 유지 (사장님 선택 보존)
async function getOrCreateSettings(admin, userId, plan) {
  const { data, error } = await admin
    .from('auto_reply_settings')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.error('[auto-reply-settings] select 오류:', error.message);
    throw new Error('설정 조회 실패');
  }

  const allowAi = canUseAiMode(plan);

  if (data) {
    // business 플랜이 아닐 때만 ai_mode=false로 강제 덮어쓰기
    if (!allowAi && data.ai_mode === true) {
      await admin
        .from('auto_reply_settings')
        .update({ ai_mode: false, updated_at: new Date().toISOString() })
        .eq('user_id', userId);
      data.ai_mode = false;
    }
    // business 플랜이면 DB 저장값 유지 (NULL이면 false로 노출)
    if (data.ai_mode === null || data.ai_mode === undefined) {
      data.ai_mode = false;
    }
    return data;
  }

  // 기본값 insert — ai_mode는 항상 false에서 시작
  const defaults = {
    user_id: userId,
    ...DEFAULT_SETTINGS,
  };
  const { data: inserted, error: insertErr } = await admin
    .from('auto_reply_settings')
    .insert(defaults)
    .select()
    .single();
  if (insertErr) {
    console.error('[auto-reply-settings] insert 오류:', insertErr.message);
    throw new Error('설정 생성 실패');
  }
  return inserted;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  const admin = getAdminClient();

  try {
    // plan 조회
    const { data: userData, error: userErr } = await admin
      .from('users')
      .select('plan, is_admin, email')
      .eq('id', user.id)
      .maybeSingle();
    if (userErr || !userData) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '사용자 조회 실패' }) };
    }
    const plan = userData.plan || 'trial';
    const isAdmin = isAdminEmail(user.email) || isAdminEmail(userData.email) || userData.is_admin === true || isAdminUserId(user.id);
    const effectivePlan = isAdmin ? 'business' : plan;

    // GET: 설정 반환
    if (event.httpMethod === 'GET') {
      const settings = await getOrCreateSettings(admin, user.id, effectivePlan);
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ success: true, settings, plan: effectivePlan, isAdmin }),
      };
    }

    // POST: 설정 upsert
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
    }

    // 허용 필드 — ai_mode 포함 (단 business 플랜일 때만 실제 반영)
    const ALLOWED_FIELDS = [
      'enabled',
      'shadow_mode',
      'keyword_rules',
      'default_comment_reply',
      'default_dm_reply',
      'negative_keyword_blocklist',
      'ai_mode',
      'ai_confidence_threshold',
    ];
    const update = { updated_at: new Date().toISOString() };
    for (const field of ALLOWED_FIELDS) {
      if (body[field] !== undefined) update[field] = body[field];
    }
    // business 플랜만 ai_mode 토글 허용, 그 외는 false 강제
    if (canUseAiMode(effectivePlan)) {
      if (body.ai_mode !== undefined) {
        update.ai_mode = body.ai_mode === true;
      }
    } else {
      update.ai_mode = false;
    }

    const { data: upserted, error: upsertErr } = await admin
      .from('auto_reply_settings')
      .upsert({ user_id: user.id, ...DEFAULT_SETTINGS, ...update }, { onConflict: 'user_id' })
      .select()
      .single();

    if (upsertErr) {
      console.error('[auto-reply-settings] upsert 오류:', upsertErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '설정 저장 실패' }) };
    }

    console.log(`[auto-reply-settings] upsert 완료 user=${user.id} plan=${effectivePlan}`);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, settings: upserted, plan: effectivePlan, isAdmin }),
    };
  } catch (err) {
    console.error('[auto-reply-settings] 예외:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message || '서버 오류' }) };
  }
};
