// 플랜 조회 — Bearer 토큰 검증 후 admin client로 RLS 우회.
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { isAdminEmail } = require('./_shared/admin');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

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

  try {
    const admin = getAdminClient();

    const { data: userData, error: userErr } = await admin
      .from('users')
      .select('plan, name, store_name, instagram_handle, biz_category, caption_tone, tag_style, store_desc, region, sido_code, sigungu_code, auto_story, auto_festival, trial_start, is_admin, email')
      .eq('id', user.id)
      .single();

    if (userErr || !userData) {
      console.error('[check-plan] users select error:', userErr && userErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '사용자 조회 실패' }) };
    }

    const { data: igData } = await admin
      .from('ig_accounts')
      .select('ig_user_id')
      .eq('user_id', user.id)
      .maybeSingle();

    const isAdmin = isAdminEmail(user.email) || isAdminEmail(userData.email) || userData.is_admin === true;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        plan: isAdmin ? 'business' : (userData.plan || 'trial'),
        isAdmin: isAdmin,
        trialStart: userData.trial_start || null,
        user: {
          name: userData.name,
          storeName: userData.store_name,
          instagram: userData.instagram_handle,
          bizCategory: userData.biz_category,
          captionTone: userData.caption_tone,
          tagStyle: userData.tag_style,
          storeDesc: userData.store_desc,
          region: userData.region,
          autoStory: userData.auto_story,
          autoFestival: userData.auto_festival,
          sidoCode: userData.sido_code,
          sigunguCode: userData.sigungu_code,
        },
        igConnected: !!(igData && igData.ig_user_id),
      }),
    };
  } catch (err) {
    console.error('[check-plan] unexpected:', err && err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
