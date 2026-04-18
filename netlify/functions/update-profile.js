const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const FIELD_MAP = {
  name: 'name',
  storeName: 'store_name',
  instagram: 'instagram_handle',
  phone: 'phone',
  birthdate: 'birthdate',
  storeDesc: 'store_desc',
  sidoCode: 'sido_code',
  sigunguCode: 'sigungu_code',
  storeSido: 'store_sido',
  region: 'region',
  bizCategory: 'biz_category',
  captionTone: 'caption_tone',
  tagStyle: 'tag_style',
  customCaptions: 'custom_captions',
  autoStory: 'auto_story',
  autoFestival: 'auto_festival',
  retentionUnsubscribed: 'retention_unsubscribed',
  featToggles: 'feat_toggles',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { user, error: authError } = await verifyBearerToken(token);
  if (authError || !user) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const update = {};
  for (const [camel, snake] of Object.entries(FIELD_MAP)) {
    if (body[camel] !== undefined) update[snake] = body[camel];
  }
  if (Object.keys(update).length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '변경할 내용이 없습니다.' }) };
  }
  update.updated_at = new Date().toISOString();

  try {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('users')
      .update(update)
      .eq('id', user.id)
      .select()
      .single();

    if (error) {
      console.error('update-profile error:', error.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '저장 중 오류가 발생했습니다.' }) };
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, user: data }) };
  } catch (err) {
    console.error('update-profile exception:', err.message || err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '저장 중 오류가 발생했습니다.' }) };
  }
};
