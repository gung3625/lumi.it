// cron-health.js — cron 건강 상태 조회 API
// GET /api/cron-health
// → {
//     "cron-heartbeat:scheduled-trends": { lastStartedAt, lastCompletedAt, lastSuccess, minutesSinceLastRun },
//     "cron-last-error:scheduled-trends": { errorAt, message, stack }
//   }

const { getAdminClient } = require('./_shared/supabase-admin');

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const CRON_NAMES = [
  'scheduled-trends',
  'scheduled-trends-longtail',
  'scheduled-trends-embeddings',
  'cron-watchdog',
];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  let supa;
  try {
    supa = getAdminClient();
  } catch (e) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Supabase 초기화 실패' }),
    };
  }

  const health = {};
  const now = Date.now();

  try {
    // heartbeat, error, stage 행 일괄 조회
    const keys = [
      ...CRON_NAMES.map(n => `cron-heartbeat:${n}`),
      ...CRON_NAMES.map(n => `cron-last-error:${n}`),
      ...CRON_NAMES.map(n => `cron-stage:${n}`),
    ];

    const { data: rows, error } = await supa
      .from('trends')
      .select('category, keywords, collected_at')
      .in('category', keys);

    if (error) throw error;

    const rowMap = {};
    for (const row of (rows || [])) {
      rowMap[row.category] = row;
    }

    for (const name of CRON_NAMES) {
      const hbRow = rowMap[`cron-heartbeat:${name}`];
      const errRow = rowMap[`cron-last-error:${name}`];
      const stageRow = rowMap[`cron-stage:${name}`];

      if (hbRow && hbRow.keywords) {
        const kw = hbRow.keywords;
        const lastStartedAt = kw.startedAt || null;
        const lastCompletedAt = kw.completedAt || null;
        const minutesSinceLastRun = lastStartedAt
          ? Math.floor((now - new Date(lastStartedAt).getTime()) / 60000)
          : null;

        health[`cron-heartbeat:${name}`] = {
          lastStartedAt,
          lastCompletedAt,
          lastSuccess: kw.success !== undefined ? kw.success : null,
          minutesSinceLastRun,
          version: kw.version || null,
          nodeVersion: kw.nodeVersion || null,
        };
      } else {
        health[`cron-heartbeat:${name}`] = null;
      }

      if (errRow && errRow.keywords) {
        const kw = errRow.keywords;
        health[`cron-last-error:${name}`] = {
          errorAt: kw.errorAt || null,
          message: kw.message || null,
          stack: kw.stack || null,
        };
      } else {
        health[`cron-last-error:${name}`] = null;
      }

      // stage 트래킹 — 없으면 null (옵셔널)
      if (stageRow && stageRow.keywords) {
        const kw = stageRow.keywords;
        health[`cron-stage:${name}`] = {
          current: kw.current || null,
          history: kw.history || [],
        };
      } else {
        health[`cron-stage:${name}`] = null;
      }
    }

    // 트렌드 카테고리별 staleness 체크 (24시간 이상 미갱신 감지)
    const TREND_CATS = ['cafe', 'food', 'beauty', 'hair', 'nail', 'flower', 'fashion', 'fitness'];
    try {
      const { data: trendRows } = await supa
        .from('trends')
        .select('category, collected_at')
        .in('category', TREND_CATS);
      const trendMap = {};
      for (const row of (trendRows || [])) trendMap[row.category] = row.collected_at;
      const trendHealth = {};
      for (const cat of TREND_CATS) {
        const collectedAt = trendMap[cat] || null;
        const hoursStale = collectedAt
          ? Math.floor((now - new Date(collectedAt).getTime()) / 3600000)
          : null;
        trendHealth[cat] = { collectedAt, hoursStale, stale: hoursStale === null || hoursStale > 24 };
      }
      health['trend-categories'] = trendHealth;
    } catch (trendErr) {
      health['trend-categories'] = { error: trendErr.message };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(health, null, 2),
    };
  } catch (e) {
    console.error('[cron-health] 조회 실패:', e.message);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: e.message }),
    };
  }
};
