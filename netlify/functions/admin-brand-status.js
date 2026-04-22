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

  // ── mode=generate-images: 7업종 × image 2슬롯 = 14개 생성 트리거 ──
  if (body.mode === 'generate-images') {
    const siteUrl = process.env.URL || 'https://lumi.it.kr';
    const target = `${siteUrl}/.netlify/functions/generate-library-background`;
    const onlyIndustries = Array.isArray(body.industries) && body.industries.length
      ? body.industries.filter((i) => ALL_INDUSTRIES.includes(i))
      : ALL_INDUSTRIES;
    const slotsPerType = Number.isInteger(body.slotsPerIndustry) ? body.slotsPerIndustry : 2;

    const tasks = [];
    for (const ind of onlyIndustries) {
      for (let i = 0; i < slotsPerType; i++) {
        tasks.push({ industry: ind, content_type: 'image', slot_index: i });
      }
    }

    let triggered = 0, failed = 0;
    const results = [];
    for (const t of tasks) {
      try {
        const res = await fetch(target, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.LUMI_SECRET}`,
          },
          body: JSON.stringify(t),
        });
        if (res.status === 202 || res.status === 200) { triggered++; results.push({ ...t, status: 'triggered' }); }
        else { failed++; const txt = await res.text().catch(() => ''); results.push({ ...t, status: `HTTP ${res.status}`, detail: txt.slice(0, 120) }); }
      } catch (e) {
        failed++;
        results.push({ ...t, status: 'error', detail: e.message });
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return { statusCode: 200, headers, body: JSON.stringify({ triggered, failed, total: tasks.length, results }) };
  }

  // ── mode=cancel-all-pending: 아직 게시 안 된 is_brand_auto 예약 전부 cancelled=true ──
  if (body.mode === 'cancel-all-pending') {
    try {
      const supabase = getAdminClient();
      const { data: rows, error: selErr } = await supabase
        .from('reservations')
        .select('reserve_key, industry, scheduled_at, caption_status, is_sent, cancelled')
        .eq('is_brand_auto', true)
        .eq('is_sent', false)
        .or('cancelled.is.null,cancelled.eq.false');
      if (selErr) return { statusCode: 500, headers, body: JSON.stringify({ error: selErr.message }) };
      const keys = (rows || []).map(r => r.reserve_key);
      if (keys.length === 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ cancelled: 0, message: '취소할 예약 없음' }) };
      }
      const { error: updErr } = await supabase
        .from('reservations')
        .update({ cancelled: true })
        .in('reserve_key', keys);
      if (updErr) return { statusCode: 500, headers, body: JSON.stringify({ error: updErr.message }) };
      return { statusCode: 200, headers, body: JSON.stringify({ cancelled: keys.length, keys }) };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── mode=post-all: daily-content-background의 post-all 모드 트리거 ──
  if (body.mode === 'post-all') {
    const siteUrl = process.env.URL || 'https://lumi.it.kr';
    const target = `${siteUrl}/.netlify/functions/daily-content-background`;
    try {
      const res = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adminSecret: process.env.LUMI_SECRET,
          mode: 'post-all',
          skipVideo: body.skipVideo === true,
          skipImage: body.skipImage === true,
          industries: body.industries,
        }),
      });
      return { statusCode: 202, headers, body: JSON.stringify({ triggered: true, status: res.status }) };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
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
      .select('reserve_key, industry, media_type, caption_status, scheduled_at, cancelled, is_sent')
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
