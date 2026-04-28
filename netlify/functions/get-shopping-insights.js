// get-shopping-insights.js — 쇼핑인사이트 통합 조회 API
//
// 셀러 셀렉트 → 카테고리 1개 + 선택적 키워드 1개 입력
// → B 그룹 4종 + (있으면) C 그룹 4종 통합 응답
//
// B 그룹은 cron(scheduled-shopping-insight)이 매일 채우므로 DB 조회만
// C 그룹은 lazy 호출 (셀러가 키워드 지정 시 즉석 호출 + 24시간 캐시)
//
// 응답:
// {
//   category: { code, name, lumiKey },
//   keyword: string|null,
//   period: { start, end },
//   category_overall: [...],
//   device_split: { pc: 30, mobile: 70 },
//   gender_split: { male: 15, female: 85 },
//   age_split: { '10s': 5, '20s': 35, ... },
//   keyword_metrics: { device, gender, age } | null
// }

const { getAdminClient } = require('./_shared/supabase-admin');
const {
  LUMI_TO_NAVER_CATEGORY,
  fetchCategoryKeywordByDevice,
  fetchCategoryKeywordByGender,
  fetchCategoryKeywordByAge,
  ensureCategoryCode,
  ensureKeyword,
  summarizeDistribution,
} = require('./_shared/naver-shopping-insight');

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

// C 그룹 lazy 캐시 유효기간
const KEYWORD_CACHE_HOURS = 24;

function resolveCategory(input) {
  if (!input) return null;
  // lumiKey (예: 'fashion') 또는 8자리 코드 모두 허용
  if (LUMI_TO_NAVER_CATEGORY[input]) {
    return { lumiKey: input, ...LUMI_TO_NAVER_CATEGORY[input] };
  }
  for (const [k, v] of Object.entries(LUMI_TO_NAVER_CATEGORY)) {
    if (v.code === input) return { lumiKey: k, ...v };
  }
  return null;
}

async function loadBGroup(supa, code) {
  const { data, error } = await supa
    .from('shopping_insights')
    .select('metric_type, period_start, period_end, data, summary, collected_at')
    .eq('category_code', code)
    .eq('keyword', '')
    .in('metric_type', ['category_overall', 'category_device', 'category_gender', 'category_age'])
    .order('period_end', { ascending: false })
    .limit(40);  // 4 메트릭 × 최근 10 period 안전 마진

  if (error) {
    console.error('[get-shopping-insights] B group load 실패:', error.message);
    return null;
  }

  // metric_type별 최신 1개 추출
  const latest = {};
  for (const row of (data || [])) {
    if (!latest[row.metric_type] || row.period_end > latest[row.metric_type].period_end) {
      latest[row.metric_type] = row;
    }
  }
  return latest;
}

async function fetchKeywordMetricsLive(code, keyword, categoryName) {
  // 3개 동시 호출 (rate-limit 큐가 직렬화 처리)
  const [deviceRes, genderRes, ageRes] = await Promise.all([
    fetchCategoryKeywordByDevice({ categoryCode: code, keyword, categoryName }).catch(e => ({ error: e })),
    fetchCategoryKeywordByGender({ categoryCode: code, keyword, categoryName }).catch(e => ({ error: e })),
    fetchCategoryKeywordByAge({ categoryCode: code, keyword, categoryName }).catch(e => ({ error: e })),
  ]);

  return {
    device: deviceRes.error ? null : {
      results: deviceRes.results,
      summary: summarizeDistribution(deviceRes.results, 'device'),
    },
    gender: genderRes.error ? null : {
      results: genderRes.results,
      summary: summarizeDistribution(genderRes.results, 'gender'),
    },
    age: ageRes.error ? null : {
      results: ageRes.results,
      summary: summarizeDistribution(ageRes.results, 'age'),
    },
  };
}

async function loadKeywordCache(supa, code, keyword) {
  const cutoff = new Date(Date.now() - KEYWORD_CACHE_HOURS * 60 * 60 * 1000).toISOString();
  const { data, error } = await supa
    .from('shopping_insights')
    .select('metric_type, period_end, data, summary, collected_at')
    .eq('category_code', code)
    .eq('keyword', keyword)
    .gte('collected_at', cutoff)
    .in('metric_type', ['category_keyword_device', 'category_keyword_gender', 'category_keyword_age']);

  if (error || !data || data.length === 0) return null;
  // 3개 모두 있어야 캐시 hit
  const map = {};
  for (const row of data) map[row.metric_type] = row;
  if (!map.category_keyword_device || !map.category_keyword_gender || !map.category_keyword_age) {
    return null;
  }
  return {
    device: { results: map.category_keyword_device.data?.results || [], summary: map.category_keyword_device.summary },
    gender: { results: map.category_keyword_gender.data?.results || [], summary: map.category_keyword_gender.summary },
    age: { results: map.category_keyword_age.data?.results || [], summary: map.category_keyword_age.summary },
  };
}

async function saveKeywordCache(supa, code, name, keyword, kw) {
  const periodStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const periodEnd = new Date().toISOString().slice(0, 10);
  const rows = [];
  if (kw.device) rows.push({ mt: 'category_keyword_device', payload: kw.device });
  if (kw.gender) rows.push({ mt: 'category_keyword_gender', payload: kw.gender });
  if (kw.age) rows.push({ mt: 'category_keyword_age', payload: kw.age });

  for (const r of rows) {
    await supa.from('shopping_insights').upsert(
      {
        category_code: code,
        category_name: name,
        metric_type: r.mt,
        keyword,
        period_start: periodStart,
        period_end: periodEnd,
        data: { results: r.payload.results || [] },
        summary: r.payload.summary || null,
        collected_at: new Date().toISOString(),
        source: 'naver_datalab_shopping',
      },
      { onConflict: 'category_code,metric_type,keyword,period_end' }
    );
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: HEADERS, body: '' };
  }

  const params = new URLSearchParams(event.rawQuery || '');
  const categoryParam = (params.get('category') || '').trim();
  const keywordParam = (params.get('keyword') || '').trim();

  const category = resolveCategory(categoryParam);
  if (!category) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({
        error: `유효하지 않은 카테고리: ${categoryParam}`,
        supported: Object.keys(LUMI_TO_NAVER_CATEGORY),
      }),
    };
  }

  let supa;
  try {
    supa = getAdminClient();
  } catch (e) {
    console.error('[get-shopping-insights] Supabase 초기화 실패:', e.message);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: '서비스 초기화 실패' }),
    };
  }

  try {
    const bGroup = await loadBGroup(supa, category.code);

    const overall = bGroup?.category_overall;
    const device = bGroup?.category_device;
    const gender = bGroup?.category_gender;
    const age = bGroup?.category_age;

    const response = {
      category: { code: category.code, name: category.name, lumiKey: category.lumiKey },
      keyword: keywordParam || null,
      period: {
        start: overall?.period_start || null,
        end: overall?.period_end || null,
      },
      category_overall: overall?.data?.results || [],
      device_split: device?.summary?.split || null,
      gender_split: gender?.summary?.split || null,
      age_split: age?.summary?.split || null,
      keyword_metrics: null,
      cached: !overall ? false : true,
      updatedAt: overall?.collected_at || null,
    };

    // C 그룹 lazy
    if (keywordParam) {
      try {
        ensureKeyword(keywordParam);
      } catch (e) {
        return {
          statusCode: 400,
          headers: HEADERS,
          body: JSON.stringify({ error: e.message }),
        };
      }

      // 캐시 hit?
      let kwData = await loadKeywordCache(supa, category.code, keywordParam);
      let liveCalled = false;
      if (!kwData) {
        kwData = await fetchKeywordMetricsLive(category.code, keywordParam, category.name);
        liveCalled = true;
        // 캐시에 저장 (best effort, 실패해도 응답은 진행)
        try {
          await saveKeywordCache(supa, category.code, category.name, keywordParam, kwData);
        } catch (cacheErr) {
          console.error('[get-shopping-insights] 캐시 저장 실패:', cacheErr.message);
        }
      }

      response.keyword_metrics = {
        device_split: kwData.device?.summary?.split || null,
        gender_split: kwData.gender?.summary?.split || null,
        age_split: kwData.age?.summary?.split || null,
        cached: !liveCalled,
      };
    }

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify(response),
    };
  } catch (e) {
    const friendly = e.friendly?.title || '쇼핑인사이트 조회 중 일시 오류';
    console.error('[get-shopping-insights] 핸들러 에러:', e.message);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: friendly }),
    };
  }
};
