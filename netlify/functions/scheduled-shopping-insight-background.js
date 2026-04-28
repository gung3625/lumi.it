// scheduled-shopping-insight-background.js — 네이버 데이터랩 쇼핑인사이트 수집 cron
//
// 스케줄: 매일 KST 04:30 (= UTC 19:30)
// 호출량: 10업종 × B 그룹 4종 = 40 호출/주기 (일 한도 25,000 대비 ~0.16%)
//          C 그룹은 셀러 lazy 호출(get-shopping-insights 캐시) 또는 별도 주간 cron 활용
//
// 인증: x-lumi-secret 헤더 검증 (메모리 reference_cron_manual_trigger.md)
// 가드: runGuarded — heartbeat / stage / error 자동 기록
//
// ⚠️ 시크릿 평문 로그 금지

const { runGuarded } = require('./_shared/cron-guard');
const { getAdminClient } = require('./_shared/supabase-admin');
const {
  LUMI_TO_NAVER_CATEGORY,
  fetchCategoryTrend,
  fetchCategoryByDevice,
  fetchCategoryByGender,
  fetchCategoryByAge,
  summarizeDistribution,
} = require('./_shared/naver-shopping-insight');

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

// B 그룹 4종 메트릭 — 호출 함수 + 분포 요약 종류
const B_GROUP_METRICS = [
  { fn: fetchCategoryTrend,    kind: 'overall', metricType: 'category_overall' },
  { fn: fetchCategoryByDevice, kind: 'device',  metricType: 'category_device' },
  { fn: fetchCategoryByGender, kind: 'gender',  metricType: 'category_gender' },
  { fn: fetchCategoryByAge,    kind: 'age',     metricType: 'category_age' },
];

async function collectCategoryMetrics(supa, lumiKey, mapping, ctx) {
  const { code, name } = mapping;
  const periodStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const periodEnd = new Date().toISOString().slice(0, 10);

  const inserted = [];
  for (const metric of B_GROUP_METRICS) {
    try {
      const result = await metric.fn({
        categoryCode: code,
        categoryName: name,
        startDate: periodStart,
        endDate: periodEnd,
        timeUnit: 'date',
      });

      const summary = (metric.kind === 'overall')
        ? null
        : summarizeDistribution(result.results, metric.kind);

      const { error } = await supa.from('shopping_insights').upsert(
        {
          category_code: code,
          category_name: name,
          metric_type: metric.metricType,
          keyword: '',
          period_start: periodStart,
          period_end: periodEnd,
          data: { results: result.results, timeUnit: result.timeUnit },
          summary,
          collected_at: new Date().toISOString(),
          source: 'naver_datalab_shopping',
        },
        { onConflict: 'category_code,metric_type,keyword,period_end' }
      );

      if (error) {
        console.error(`[shopping-insight] upsert 실패 ${lumiKey}/${metric.metricType}:`, error.message);
      } else {
        inserted.push(metric.metricType);
      }
    } catch (e) {
      // friendly 에러 메시지만 노출, 시크릿/스택 노출 방지
      const friendly = e.friendly?.title || e.message || 'unknown';
      console.error(`[shopping-insight] ${lumiKey}/${metric.metricType} 실패: ${friendly}`);
    }
  }
  return inserted;
}

async function mainHandler(event, ctx) {
  // 인증
  const secret = (event.headers && (event.headers['x-lumi-secret'] || event.headers['X-Lumi-Secret'])) || '';
  if (!process.env.LUMI_SECRET || secret !== process.env.LUMI_SECRET) {
    return {
      statusCode: 401,
      headers: HEADERS,
      body: JSON.stringify({ error: '인증 실패' }),
    };
  }

  await ctx.stage('init', { totalCategories: Object.keys(LUMI_TO_NAVER_CATEGORY).length });

  const supa = getAdminClient();

  const summary = {};
  let totalUpserts = 0;

  for (const [lumiKey, mapping] of Object.entries(LUMI_TO_NAVER_CATEGORY)) {
    await ctx.stage(`collect:${lumiKey}`, { code: mapping.code });
    const inserted = await collectCategoryMetrics(supa, lumiKey, mapping, ctx);
    summary[lumiKey] = { code: mapping.code, name: mapping.name, metrics: inserted };
    totalUpserts += inserted.length;
  }

  await ctx.stage('done', { totalUpserts });

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      success: true,
      totalUpserts,
      categories: summary,
      completedAt: new Date().toISOString(),
    }),
  };
}

exports.handler = runGuarded({
  name: 'scheduled-shopping-insight',
  handler: mainHandler,
});
