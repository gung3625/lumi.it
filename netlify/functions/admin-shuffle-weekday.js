const { corsHeaders, getOrigin } = require('./_shared/auth');
// admin-shuffle-weekday.js — 요일↔업종 매핑 Fisher-Yates 셔플 (admin-only).
// POST /api/admin-shuffle-weekday
// Response: { schedule: [{ weekday, industry, week_start_date }] }

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');


const INDUSTRIES = ['cafe', 'restaurant', 'beauty', 'nail', 'flower', 'clothing', 'gym'];

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

// Fisher-Yates 셔플
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 이번 주 월요일 날짜 (YYYY-MM-DD)
function getThisMonday() {
  const d = new Date();
  const day = d.getDay(); // 0=일
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
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

  try {
    const supabase = getAdminClient();
    const shuffled = shuffleArray(INDUSTRIES);
    const weekStartDate = getThisMonday();
    const now = new Date().toISOString();

    // 0=일 ~ 6=토 순서로 셔플된 업종 매핑
    const upsertRows = shuffled.map((industry, idx) => ({
      weekday: idx,
      industry,
      week_start_date: weekStartDate,
      updated_at: now,
    }));

    const { error: upsertErr } = await supabase
      .from('brand_weekday_schedule')
      .upsert(upsertRows, { onConflict: 'weekday' });

    if (upsertErr) {
      console.error('[admin-shuffle-weekday] upsert 실패:', upsertErr.message);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '스케줄 셔플 실패' }) };
    }

    // 결과 재조회
    const { data: schedule, error: selectErr } = await supabase
      .from('brand_weekday_schedule')
      .select('weekday, industry, week_start_date, updated_at')
      .order('weekday', { ascending: true });

    if (selectErr) {
      console.error('[admin-shuffle-weekday] 결과 조회 실패:', selectErr.message);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '스케줄 조회 실패' }) };
    }

    console.log('[admin-shuffle-weekday] 셔플 완료. week_start_date:', weekStartDate);

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ schedule: schedule || [], week_start_date: weekStartDate }),
    };
  } catch (err) {
    console.error('[admin-shuffle-weekday] 예기치 않은 오류:', err.message);
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '서버 오류가 발생했습니다.' }) };
  }
};
