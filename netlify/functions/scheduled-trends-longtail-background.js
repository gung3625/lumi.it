// scheduled-trends-longtail-background.js — Phase 3 Long-tail 서브카테고리 주간 분류
// 매주 월요일 KST 04:00 (= UTC 일요일 19:00)
// trend_keywords 기존 키워드에 sub_category 배정

const { getAdminClient } = require('./_shared/supabase-admin');
const { runGuarded } = require('./_shared/cron-guard');
const https = require('https');
const { checkAndIncrementQuota, QuotaExceededError } = require('./_shared/openai-quota');

// ─────────────────────────────────────────────
// httpsPost 헬퍼
// ─────────────────────────────────────────────
function httpsPost(hostname, path, headers, body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname,
      path,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

// ─────────────────────────────────────────────
// GPT-4o-mini 서브카테고리 분류 호출
// ─────────────────────────────────────────────
async function callGPTSubcatClassify({ category, subcatKey, label, seeds, rawKeywords }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return [];

  const keywordList = rawKeywords.slice(0, 60).join(', ');
  const seedList = seeds.join(', ');

  const prompt = `아래는 인스타그램 트렌드 키워드 목록입니다. 이 중에서 "${label}" (${category} 업종의 서브카테고리, 관련 시드: ${seedList}) 에 명확히 해당하는 키워드만 골라서 JSON 배열로 반환하세요.

키워드 목록: ${keywordList}

규칙:
1. 확실히 관련된 것만 포함 (모호하면 제외)
2. 원래 키워드 그대로 반환 (변형 금지)
3. 최대 10개
4. JSON 배열 형식: ["키워드1", "키워드2"]
5. 해당 없으면 빈 배열 []`;

  try {
    const result = await httpsPost(
      'api.openai.com',
      '/v1/responses',
      {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      {
        model: 'gpt-4o-mini',
        input: prompt,
        temperature: 0.1,
        max_output_tokens: 400,
        store: false,
      },
      30000
    );

    if (result.status !== 200) {
      console.error(`[longtail] GPT status ${result.status} for ${subcatKey}`);
      return [];
    }

    const data = JSON.parse(result.body);
    let content = (data.output_text || '').trim();
    if (!content && Array.isArray(data.output)) {
      for (const item of data.output) {
        for (const part of (item?.content || [])) {
          if (part?.text) content += part.text;
        }
      }
      content = content.trim();
    }

    if (!content) return [];

    // JSON 배열 파싱
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed.filter(k => typeof k === 'string' && k.trim()) : [];
  } catch (e) {
    console.error(`[longtail] GPT 호출 실패 (${subcatKey}):`, e.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// 핸들러
// ─────────────────────────────────────────────
const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

exports.handler = runGuarded({
  name: 'scheduled-trends-longtail',
  handler: async (event, ctx) => {
    // Netlify cron 호출은 event.httpMethod가 없음 → 인증 스킵
    // 외부 HTTP 호출만 LUMI_SECRET 검증
    const isScheduled = !event || !event.httpMethod;
    if (!isScheduled) {
      const secret = (event.headers && (event.headers['x-lumi-secret'] || event.headers['X-Lumi-Secret'])) || '';
      if (!process.env.LUMI_SECRET || secret !== process.env.LUMI_SECRET) {
        return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: '인증 실패' }) };
      }
    }

    const supa = getAdminClient();

    // 서비스 전체 예산 체크 (cron — sellerId 없음, 추정 ₩50)
    try {
      await checkAndIncrementQuota(null, 'gpt-4o-mini', 50);
    } catch (e) {
      if (e instanceof QuotaExceededError) {
        console.warn('[longtail] 서비스 전체 OpenAI 예산 초과 — cron 중단:', e.message);
        return { statusCode: 429, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message, skipped: true }) };
      }
      throw e;
    }

    // 1. 활성 서브카테고리 로드
    const { data: subcats, error: subcatErr } = await supa
      .from('trend_subcategories')
      .select('category, sub_category, label_ko, seed_queries')
      .eq('active', true);

    if (subcatErr) throw new Error(`서브카테고리 로드 실패: ${subcatErr.message}`);
    if (!subcats || subcats.length === 0) {
      console.log('[longtail] 활성 서브카테고리 없음');
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, processed: 0 }) };
    }

    await ctx.stage('loaded', { count: subcats.length });
    console.log(`[longtail] 서브카테고리 ${subcats.length}개 로드`);

    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let totalUpdated = 0;

    // 2. 카테고리별로 최근 trend_keywords 로드 (중복 요청 최소화)
    const catKeywordMap = {};
    const uniqueCategories = [...new Set(subcats.map(sc => sc.category))];

    for (const cat of uniqueCategories) {
      // beauty DB에서 hair/nail 공유 — DB key 매핑
      const DB_KEY_MAP = { hair: 'beauty', nail: 'beauty' };
      const dbCat = DB_KEY_MAP[cat] || cat;

      // sub_category 미분류 row 조회 — scheduled-trends-v2 가 빈 문자열('') 로 저장하므로
      // NULL + '' 둘 다 미분류로 취급. 이게 빠지면 longtail 이 영구 0건 처리됨.
      const { data: kws, error: kwErr } = await supa
        .from('trend_keywords')
        .select('id, keyword, category, sub_category')
        .eq('category', dbCat)
        .gte('collected_date', cutoff)
        .or('sub_category.is.null,sub_category.eq.')
        .limit(200);

      if (kwErr) {
        console.error(`[longtail] ${cat} 키워드 로드 실패:`, kwErr.message);
        catKeywordMap[cat] = [];
      } else {
        catKeywordMap[cat] = kws || [];
        console.log(`[longtail] ${cat} 미분류 키워드 ${catKeywordMap[cat].length}개`);
      }
    }

    await ctx.stage('keywords_loaded', { categories: uniqueCategories.length });

    // 3. 서브카테고리별 GPT 분류 + upsert
    for (const sc of subcats) {
      const keywords = catKeywordMap[sc.category] || [];
      if (keywords.length === 0) continue;

      // seed_queries 파싱
      let seeds = [];
      try {
        seeds = typeof sc.seed_queries === 'string'
          ? JSON.parse(sc.seed_queries)
          : (Array.isArray(sc.seed_queries) ? sc.seed_queries : []);
      } catch (_) {
        seeds = [];
      }

      const rawKeywords = keywords.map(k => k.keyword);

      const matched = await callGPTSubcatClassify({
        category: sc.category,
        subcatKey: sc.sub_category,
        label: sc.label_ko,
        seeds,
        rawKeywords,
      });

      if (matched.length === 0) {
        console.log(`[longtail] ${sc.sub_category}: 매칭 없음`);
        continue;
      }

      console.log(`[longtail] ${sc.sub_category}: ${matched.length}개 매칭 → ${matched.join(', ')}`);

      // 매칭된 키워드 ID 추출
      const matchedIds = keywords
        .filter(k => matched.includes(k.keyword))
        .map(k => k.id);

      if (matchedIds.length === 0) continue;

      // sub_category 필드 업데이트
      const { error: updateErr } = await supa
        .from('trend_keywords')
        .update({ sub_category: sc.sub_category })
        .in('id', matchedIds);

      if (updateErr) {
        console.error(`[longtail] ${sc.sub_category} 업데이트 실패:`, updateErr.message);
      } else {
        totalUpdated += matchedIds.length;
      }

      // API rate limit 완화 (gpt-4o-mini: 500 RPM, 충분하지만 안전하게)
      await new Promise(r => setTimeout(r, 200));
    }

    await ctx.stage('complete', { totalUpdated });
    console.log(`[longtail] 완료 — 총 ${totalUpdated}개 키워드 서브카테고리 배정`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: true, processed: subcats.length, totalUpdated }),
    };
  },
});

// 매주 월요일 KST 04:00 (= UTC 일요일 19:00)
exports.config = { schedule: '0 19 * * 0' };
