// 매주 월요일 새벽 KST 03:00 (cron: UTC 일요일 18:00) 실행.
// admin-shuffle-weekday.js 와 동일한 로직이지만 인증 체크 없이 cron 자동 실행용.
// 관심사 분리: 관리자 수동 셔플(admin-shuffle-weekday) vs 자동 주간 셔플(본 파일).
const { getAdminClient } = require('./_shared/supabase-admin');
const { utcToKstDate } = require('./_shared/kst-utils');

const INDUSTRIES = ['cafe', 'restaurant', 'beauty', 'nail', 'flower', 'clothing', 'gym'];

// Fisher-Yates 셔플
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 이번 주 월요일 날짜 (YYYY-MM-DD) — KST 기준
function getThisMonday() {
  const kst = utcToKstDate(new Date());
  const day = kst.getUTCDay(); // KST 기준 요일 (월=1)
  const diff = day === 0 ? -6 : 1 - day;
  kst.setUTCDate(kst.getUTCDate() + diff);
  return kst.toISOString().slice(0, 10);
}

exports.handler = async () => {
  console.log('[scheduled-weekday-shuffle] HANDLER_ENTRY');
  let supabase;
  try {
    supabase = getAdminClient();
  } catch (e) {
    console.error('[scheduled-weekday-shuffle] getAdminClient 실패:', e.message);
    return { statusCode: 500 };
  }

  try {
    const shuffled = shuffleArray(INDUSTRIES);
    const weekStartDate = getThisMonday();
    const now = new Date().toISOString();

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
      console.error('[scheduled-weekday-shuffle] upsert 실패:', upsertErr.message);
      return { statusCode: 500 };
    }

    console.log('[scheduled-weekday-shuffle] 셔플 완료. week_start_date:', weekStartDate);
    return { statusCode: 200 };
  } catch (err) {
    console.error('[scheduled-weekday-shuffle] 예외:', err.message);
    return { statusCode: 500 };
  }
};
