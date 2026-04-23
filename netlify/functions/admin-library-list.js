const { corsHeaders, getOrigin } = require('./_shared/auth');
// admin-library-list.js — 브랜드 라이브러리 전체 조회 (admin-only).
// GET /api/admin-library-list
// Response: { library: [...], schedule: [...] }

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');


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
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers, body: '' };
  if (event.httpMethod !== 'GET') {
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

  try {
    const supabase = getAdminClient();

    // 라이브러리 전체 조회 (업종·타입·생성일 순)
    const { data: library, error: libErr } = await supabase
      .from('brand_content_library')
      .select('id, industry, content_type, storage_bucket, storage_path, public_url, prompt, generated_at, last_used_at, use_count, status, error_message')
      .order('industry', { ascending: true })
      .order('content_type', { ascending: true })
      .order('generated_at', { ascending: true });

    if (libErr) {
      console.error('[admin-library-list] brand_content_library 조회 실패:', libErr.message);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '라이브러리 조회 실패' }) };
    }

    // 요일 스케줄 조회
    const { data: schedule, error: schedErr } = await supabase
      .from('brand_weekday_schedule')
      .select('weekday, industry, week_start_date, updated_at')
      .order('weekday', { ascending: true });

    if (schedErr) {
      console.error('[admin-library-list] brand_weekday_schedule 조회 실패:', schedErr.message);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '스케줄 조회 실패' }) };
    }

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ library: library || [], schedule: schedule || [] }),
    };
  } catch (err) {
    console.error('[admin-library-list] 예기치 않은 오류:', err.message);
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '서버 오류가 발생했습니다.' }) };
  }
};
