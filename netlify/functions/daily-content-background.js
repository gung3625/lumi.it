// 매일 KST 08:00 (cron: UTC 23:00 전날) 실행되는 브랜드 자동 게시 파이프라인.
// 흐름:
//   1) KST 기준 오늘 요일 → brand_weekday_schedule 에서 업종 조회
//   2) brand_content_library 에서 image 1건 + video 1건 pickup (last_used_at NULLS FIRST)
//   3) getBrandCaption 으로 업종별 캡션 생성 + brand-footer append
//   4) 업종별 최적 업로드 시간 계산 (이미지=피크 / 영상=+4시간 저녁)
//   5) reservations 테이블에 2건 insert (user_id=LUMI_BRAND_USER_ID, is_brand_auto=true)
//   6) brand_content_library.last_used_at / use_count 갱신
//
// scheduler(매분 cron)가 scheduled_at 도달 시 process-and-post-background 호출 →
// 기존 분기(is_brand_auto === true)가 자동 게시까지 수행.
//
// 개인정보 로그 금지. 사용자 식별자는 환경변수 기반이라 OK.
const { getAdminClient } = require('./_shared/supabase-admin');
const { getBrandCaption } = require('./_shared/brand-prompts');
const { generateBrandFooter } = require('./_shared/brand-footer');

const headers = {
  'Content-Type': 'application/json',
};

// 업종별 이미지(피크) 업로드 시간 — KST
// 기존 get-best-time.js BEST_TIMES 와 일관된 시간대
const INDUSTRY_PEAK_TIME = {
  cafe:       { hour: 10, minute: 30 },
  restaurant: { hour: 12, minute: 0 },
  beauty:     { hour: 15, minute: 0 },
  nail:       { hour: 14, minute: 0 },
  flower:     { hour: 11, minute: 0 },
  clothing:   { hour: 20, minute: 0 },
  gym:        { hour: 19, minute: 0 },
};

// KST 기준 오늘 요일 (0=일, 6=토)
function getTodayWeekdayKST() {
  const nowUtc = new Date();
  // KST = UTC + 9h
  const kst = new Date(nowUtc.getTime() + 9 * 60 * 60 * 1000);
  return kst.getUTCDay();
}

// 업종별 KST 시각을 오늘 기준으로 UTC ISO 문자열로 변환.
// hourOffset: 이미지=0(피크), 영상=+4(저녁)
function buildScheduledAtIso(industry, hourOffset = 0) {
  const peak = INDUSTRY_PEAK_TIME[industry] || { hour: 12, minute: 0 };
  let targetHourKst = peak.hour + hourOffset;
  if (targetHourKst > 23) targetHourKst = 23;
  const targetMinute = peak.minute;

  const nowUtc = new Date();
  // "오늘 KST 날짜" 구하기: UTC 기준 + 9h 후의 YYYY-MM-DD
  const kstTodayMs = nowUtc.getTime() + 9 * 60 * 60 * 1000;
  const kstToday = new Date(kstTodayMs);
  const y = kstToday.getUTCFullYear();
  const m = kstToday.getUTCMonth();
  const d = kstToday.getUTCDate();

  // 원하는 KST 시각의 UTC 시각 = (KST 시각) - 9h
  const utcHour = targetHourKst - 9;
  // Date.UTC 는 overflow 처리(음수 hour → 전날) 자동 수행
  const scheduledUtc = new Date(Date.UTC(y, m, d, utcHour, targetMinute, 0));

  // 과거 시간이면 즉시 처리되도록 지금 + 2분으로 밀어줌 (scheduler 픽업 보장)
  const minFutureMs = nowUtc.getTime() + 2 * 60 * 1000;
  if (scheduledUtc.getTime() < minFutureMs) {
    return new Date(minFutureMs).toISOString();
  }
  return scheduledUtc.toISOString();
}

async function pickupLibraryRow(supabase, industry, contentType) {
  const { data, error } = await supabase
    .from('brand_content_library')
    .select('id, public_url, storage_bucket, storage_path')
    .eq('industry', industry)
    .eq('content_type', contentType)
    .eq('status', 'ready')
    .order('last_used_at', { ascending: true, nullsFirst: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(`[daily-content] 라이브러리 조회 실패 (${industry}/${contentType}):`, error.message);
    return null;
  }
  if (!data) {
    console.warn(`[daily-content] 라이브러리에 ${industry}/${contentType} 슬롯 없음 — 건너뜀`);
    return null;
  }
  if (!data.public_url) {
    console.warn(`[daily-content] public_url 누락 id=${data.id} — 건너뜀`);
    return null;
  }
  return data;
}

async function buildReservationRow({
  brandUserId,
  industry,
  contentType,
  libraryRow,
  scheduledAtIso,
  bizCategoryFallback,
}) {
  // 업종별 캡션 생성 + 브랜드 푸터 append
  let captionText = '';
  try {
    const { caption } = await getBrandCaption(industry, contentType);
    captionText = caption || '';
  } catch (e) {
    console.warn(`[daily-content] getBrandCaption 실패(${industry}/${contentType}):`, e.message);
    // 실패 시 industry-free 폴백
    captionText = '오늘도 좋은 하루 보내세요.';
  }

  let footer = '';
  try {
    footer = await generateBrandFooter({ industry, openaiKey: process.env.OPENAI_API_KEY });
  } catch (e) {
    console.warn(`[daily-content] generateBrandFooter 실패(${industry}):`, e.message);
    footer = '';
  }

  const finalCaption = footer ? `${captionText}\n\n${footer}` : captionText;

  const kstDateStr = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const reserveKey = `brand-auto:${kstDateStr}:${contentType}:${industry}`;
  const isReels = contentType === 'video';
  const publicUrl = libraryRow.public_url;

  const row = {
    reserve_key: reserveKey,
    user_id: brandUserId,
    user_message: '',
    biz_category: bizCategoryFallback,
    caption_tone: '친근하게',
    tag_style: 'mid',
    weather: {},
    trends: [],
    store_profile: {},
    post_mode: 'scheduled',
    scheduled_at: scheduledAtIso,
    submitted_at: new Date().toISOString(),
    story_enabled: false,
    post_to_thread: false,
    nearby_event: false,
    nearby_festivals: '',
    tone_likes: '',
    tone_dislikes: '',
    custom_captions: '',
    relay_mode: true,
    use_weather: false,
    is_sent: false,
    caption_status: 'scheduled',
    selected_caption_index: 0,
    generated_captions: [finalCaption],
    captions: [finalCaption],
    image_urls: [publicUrl],
    image_keys: [],
    media_type: isReels ? 'REELS' : 'IMAGE',
    video_url: isReels ? publicUrl : null,
    video_key: null,
    frame_urls: isReels ? [publicUrl] : [],
    is_brand_auto: true,
    cancelled: false,
    industry,
    captions_generated_at: new Date().toISOString(),
  };
  return row;
}

exports.handler = async (event) => {
  console.log('[daily-content] HANDLER_ENTRY');

  const brandUserId = process.env.LUMI_BRAND_USER_ID;
  if (!brandUserId) {
    console.error('[daily-content] LUMI_BRAND_USER_ID 환경변수 없음 — 중단');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'LUMI_BRAND_USER_ID 미설정' }) };
  }

  let supabase;
  try {
    supabase = getAdminClient();
  } catch (e) {
    console.error('[daily-content] getAdminClient 실패:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase 클라이언트 초기화 실패' }) };
  }

  try {
    const weekday = getTodayWeekdayKST();
    console.log('[daily-content] 오늘 KST 요일:', weekday);

    // 1) 요일 → 업종 매핑 조회
    const { data: scheduleRow, error: schedErr } = await supabase
      .from('brand_weekday_schedule')
      .select('industry')
      .eq('weekday', weekday)
      .maybeSingle();

    if (schedErr || !scheduleRow) {
      console.error('[daily-content] brand_weekday_schedule 조회 실패:', schedErr?.message || 'not found');
      return { statusCode: 500, headers, body: JSON.stringify({ error: '요일 매핑 조회 실패' }) };
    }
    const industry = scheduleRow.industry;
    console.log('[daily-content] 오늘 업종:', industry);

    // 2) 라이브러리 pickup (image + video 병렬)
    const [imageRow, videoRow] = await Promise.all([
      pickupLibraryRow(supabase, industry, 'image'),
      pickupLibraryRow(supabase, industry, 'video'),
    ]);

    const scheduledIsoImage = buildScheduledAtIso(industry, 0);
    const scheduledIsoVideo = buildScheduledAtIso(industry, 4);

    const reservationRows = [];
    const libraryIdsToMark = [];

    if (imageRow) {
      const row = await buildReservationRow({
        brandUserId,
        industry,
        contentType: 'image',
        libraryRow: imageRow,
        scheduledAtIso: scheduledIsoImage,
        bizCategoryFallback: industry,
      });
      reservationRows.push(row);
      libraryIdsToMark.push(imageRow.id);
    }

    if (videoRow) {
      const row = await buildReservationRow({
        brandUserId,
        industry,
        contentType: 'video',
        libraryRow: videoRow,
        scheduledAtIso: scheduledIsoVideo,
        bizCategoryFallback: industry,
      });
      reservationRows.push(row);
      libraryIdsToMark.push(videoRow.id);
    }

    if (reservationRows.length === 0) {
      console.warn('[daily-content] 게시 가능한 라이브러리 슬롯 없음 — 종료');
      return { statusCode: 200, headers, body: JSON.stringify({ inserted: 0, industry, weekday }) };
    }

    // 3) 멱등성: 당일 is_brand_auto 예약 이미 존재 시 스킵
    const kstDateStr = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const kstStart = new Date(`${kstDateStr}T00:00:00+09:00`).toISOString();
    const { data: existing } = await supabase
      .from('reservations')
      .select('id')
      .eq('is_brand_auto', true)
      .gte('submitted_at', kstStart)
      .limit(1);
    if (existing && existing.length > 0) {
      console.log('[daily-content] 오늘 이미 브랜드 자동 예약 존재 — 스킵');
      return { statusCode: 200, headers, body: JSON.stringify({ inserted: 0, reason: 'already-exists' }) };
    }

    // 4) reservations insert
    const { error: insertErr } = await supabase
      .from('reservations')
      .insert(reservationRows);

    if (insertErr) {
      console.error('[daily-content] reservations insert 실패:', insertErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: '예약 저장 실패' }) };
    }

    // 4) 라이브러리 last_used_at / use_count 갱신
    //    use_count 는 단순 +1 이라 순차 update 로 처리 (RLS/RPC 불필요)
    const nowIso = new Date().toISOString();
    for (const libId of libraryIdsToMark) {
      try {
        // 현재 use_count 조회 후 +1 (작은 스케일이라 충돌 없음)
        const { data: cur } = await supabase
          .from('brand_content_library')
          .select('use_count')
          .eq('id', libId)
          .maybeSingle();
        const nextCount = (cur?.use_count || 0) + 1;
        const { error: updErr } = await supabase
          .from('brand_content_library')
          .update({ last_used_at: nowIso, use_count: nextCount })
          .eq('id', libId);
        if (updErr) console.warn('[daily-content] 라이브러리 갱신 실패:', libId, updErr.message);
      } catch (e) {
        console.warn('[daily-content] 라이브러리 갱신 예외:', libId, e.message);
      }
    }

    console.log(`[daily-content] 완료: ${reservationRows.length}건 예약 생성 (industry=${industry}, weekday=${weekday})`);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        inserted: reservationRows.length,
        industry,
        weekday,
        scheduledAtImage: scheduledIsoImage,
        scheduledAtVideo: scheduledIsoVideo,
      }),
    };
  } catch (err) {
    console.error('[daily-content] 에러:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '처리 중 오류' }) };
  }
};
