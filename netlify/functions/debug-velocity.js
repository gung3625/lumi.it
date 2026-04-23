// TEMPORARY DIAGNOSTIC ENDPOINT — velocity_pct 계속 null 이유 진단
// 배포 후 curl로 상태 확인 → 버그 픽스 → 이 파일 삭제
const { getAdminClient } = require('./_shared/supabase-admin');

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

exports.handler = async (event) => {
  const supa = getAdminClient();
  const params = new URLSearchParams(event.queryStringParameters ? Object.entries(event.queryStringParameters).map(([k,v])=>[k,v]).reduce((a,[k,v])=>(a+='&'+k+'='+encodeURIComponent(v),a),'') : '');
  const category = (event.queryStringParameters && event.queryStringParameters.category) || 'cafe';
  const keyword = (event.queryStringParameters && event.queryStringParameters.keyword) || '';

  const out = { category, keyword: keyword || '(auto-pick)', diagnostics: {} };

  // 1. trend_keywords 테이블 존재 + 카테고리별 카운트 + 날짜 분포
  try {
    const { count: totalCount, error: ce } = await supa
      .from('trend_keywords')
      .select('id', { count: 'exact', head: true })
      .eq('category', category);
    out.diagnostics.trend_keywords_total = { count: totalCount, error: ce?.message };
  } catch (e) { out.diagnostics.trend_keywords_total = { error: e.message }; }

  // 2. 최근 14일 날짜별 row 수
  try {
    const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const { data, error } = await supa
      .from('trend_keywords')
      .select('collected_date, keyword, weighted_score')
      .eq('category', category)
      .gte('collected_date', cutoff)
      .order('collected_date', { ascending: false })
      .limit(200);
    if (error) throw error;
    const byDate = {};
    (data || []).forEach(r => {
      byDate[r.collected_date] = byDate[r.collected_date] || { count: 0, samples: [] };
      byDate[r.collected_date].count++;
      if (byDate[r.collected_date].samples.length < 3) {
        byDate[r.collected_date].samples.push({ kw: r.keyword, ws: r.weighted_score });
      }
    });
    out.diagnostics.trend_keywords_last14 = byDate;
  } catch (e) { out.diagnostics.trend_keywords_last14 = { error: e.message }; }

  // 3. 특정 키워드의 전체 history
  const testKw = keyword || (() => {
    // auto-pick: 오늘의 top keyword from trend_keywords
    return null;
  })();
  if (testKw) {
    try {
      const { data, error } = await supa
        .from('trend_keywords')
        .select('collected_date, weighted_score, cross_source_count')
        .eq('category', category)
        .eq('keyword', testKw)
        .order('collected_date', { ascending: false })
        .limit(30);
      out.diagnostics.keyword_history = { count: (data || []).length, rows: data || [], error: error?.message };
    } catch (e) { out.diagnostics.keyword_history = { error: e.message }; }
  }

  // 4. legacy prev 스냅샷 존재 확인
  try {
    const prevKey = `l30d-domestic-prev:${category}`;
    const { data, error } = await supa.from('trends').select('keywords, collected_at').eq('category', prevKey).maybeSingle();
    if (data) {
      const k = data.keywords || {};
      const arr = Array.isArray(k.keywords) ? k.keywords : (Array.isArray(k) ? k : null);
      out.diagnostics.prev_snapshot = {
        exists: true,
        collected_at: data.collected_at,
        structure: arr ? 'nested-keywords' : (k?.keywords ? 'unknown' : 'missing-keywords'),
        top_level_keys: Object.keys(k || {}),
        item_count: arr?.length || 0,
        sample_items: (arr || []).slice(0, 3).map(i => ({ kw: i.keyword, score: i.score })),
      };
    } else {
      out.diagnostics.prev_snapshot = { exists: false, error: error?.message };
    }
  } catch (e) { out.diagnostics.prev_snapshot = { error: e.message }; }

  // 5. 현재 스냅샷도 확인 (l30d-domestic:cafe)
  try {
    const curKey = `l30d-domestic:${category}`;
    const { data } = await supa.from('trends').select('keywords, collected_at').eq('category', curKey).maybeSingle();
    if (data) {
      const k = data.keywords || {};
      const arr = Array.isArray(k.keywords) ? k.keywords : (Array.isArray(k) ? k : null);
      out.diagnostics.cur_snapshot = {
        exists: true,
        collected_at: data.collected_at,
        item_count: arr?.length || 0,
        sample: (arr || []).slice(0, 3).map(i => ({ kw: i.keyword, score: i.score })),
      };
    } else {
      out.diagnostics.cur_snapshot = { exists: false };
    }
  } catch (e) { out.diagnostics.cur_snapshot = { error: e.message }; }

  // 6. 오늘의 trend_keywords 상위 3건 (velocity_pct 포함해서 체크)
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await supa
      .from('trend_keywords')
      .select('keyword, weighted_score, velocity_pct, signal_tier, cross_source_count, collected_date')
      .eq('category', category)
      .eq('collected_date', today)
      .order('weighted_score', { ascending: false })
      .limit(5);
    out.diagnostics.today_v2_rows = { count: (data || []).length, rows: data || [], error: error?.message };
  } catch (e) { out.diagnostics.today_v2_rows = { error: e.message }; }

  return { statusCode: 200, headers: CORS, body: JSON.stringify(out, null, 2) };
};
