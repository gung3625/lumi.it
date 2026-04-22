// admin-brand-status.js — LUMI_SECRET 인증 기반 브랜드 라이브러리 현황 조회.
// Background Function이 아닌 regular function이라 즉시 응답 반환.
// POST { adminSecret }
const { getAdminClient } = require('./_shared/supabase-admin');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const ALL_INDUSTRIES = ['cafe', 'restaurant', 'beauty', 'nail', 'flower', 'clothing', 'gym'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {}
  if (!body.adminSecret || body.adminSecret !== process.env.LUMI_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'unauthorized' }) };
  }

  try {
    const supabase = getAdminClient();

    // library 현황
    const { data: libRows, error: libErr } = await supabase
      .from('brand_content_library')
      .select('industry, content_type, status, public_url, last_used_at, use_count')
      .in('industry', ALL_INDUSTRIES);
    if (libErr) return { statusCode: 500, headers, body: JSON.stringify({ error: libErr.message }) };

    const summary = {};
    for (const ind of ALL_INDUSTRIES) {
      summary[ind] = { image_ready: 0, video_ready: 0, image_failed: 0, video_failed: 0, image_generating: 0, video_generating: 0 };
    }
    for (const r of libRows || []) {
      const bucket = summary[r.industry];
      if (!bucket) continue;
      if (r.status === 'ready' && r.public_url) bucket[`${r.content_type}_ready`]++;
      else if (r.status === 'failed') bucket[`${r.content_type}_failed`]++;
      else if (r.status === 'generating') bucket[`${r.content_type}_generating`]++;
    }

    // 오늘 예약 현황
    const kstDateStr = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const kstStart = new Date(`${kstDateStr}T00:00:00+09:00`).toISOString();
    const { data: todayRows } = await supabase
      .from('reservations')
      .select('reserve_key, industry, media_type, caption_status, scheduled_at')
      .eq('is_brand_auto', true)
      .gte('submitted_at', kstStart)
      .order('scheduled_at', { ascending: true });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        library: summary,
        today_reservations: todayRows || [],
        today_date_kst: kstDateStr,
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
