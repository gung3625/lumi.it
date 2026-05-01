// scheduled-trends-embeddings-background.js — Phase 4 임베딩 + 클러스터 cron
// 매주 화요일 KST 03:00 (= UTC 월요일 18:00) 실행
// 최근 7일 trend_keywords 중 embedding 없는 항목에 text-embedding-3-small 벡터 생성 후
// 카테고리 내 코사인 유사도 ≥ 0.75 키워드 top-5를 related_keywords에 저장

const { runGuarded } = require('./_shared/cron-guard');
const { getAdminClient } = require('./_shared/supabase-admin');
const https = require('https');
const { checkAndIncrementQuota, QuotaExceededError } = require('./_shared/openai-quota');

// OpenAI text-embedding-3-small 호출 (silent fallback)
async function getEmbedding(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'text-embedding-3-small',
      input: text,
    });
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/embeddings',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          resolve(data?.data?.[0]?.embedding || null);
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

exports.handler = runGuarded({
  name: 'scheduled-trends-embeddings',
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

    // 1. 최근 7일 embedding 없는 trend_keywords 조회 (최대 500개)
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: rows, error: fetchErr } = await supa
      .from('trend_keywords')
      .select('id, keyword')
      .gte('collected_date', cutoff)
      .is('embedding', null)
      .limit(500);

    if (fetchErr) {
      console.error('[scheduled-trends-embeddings] 조회 실패:', fetchErr.message);
    }

    await ctx.stage('loaded', { count: rows?.length || 0 });

    if (!rows || rows.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ success: true, embedded: 0, clusters: 0 }) };
    }

    // 서비스 전체 예산 체크 (cron — text-embedding-3-small ₩1 × 키워드 수 추정)
    try {
      await checkAndIncrementQuota(null, 'text-embedding-3-small', rows.length);
    } catch (e) {
      if (e instanceof QuotaExceededError) {
        console.warn('[scheduled-trends-embeddings] 서비스 전체 OpenAI 예산 초과 — cron 중단:', e.message);
        return { statusCode: 429, body: JSON.stringify({ error: e.message, skipped: true }) };
      }
      throw e;
    }

    // 2. 각 키워드 임베딩 생성 (배치 20개씩 병렬)
    let embedded = 0;
    for (let i = 0; i < rows.length; i += 20) {
      const chunk = rows.slice(i, i + 20);
      await Promise.all(chunk.map(async (row) => {
        try {
          const vec = await getEmbedding(row.keyword);
          if (!vec) return;
          // pgvector 형식: '[0.1,0.2,...]' 문자열
          const vecStr = `[${vec.join(',')}]`;
          await supa.from('trend_keywords')
            .update({ embedding: vecStr })
            .eq('id', row.id);
          embedded++;
        } catch (e) {
          console.error(`[scheduled-trends-embeddings] 임베딩 업데이트 실패 (id=${row.id}):`, e.message);
        }
      }));
    }

    await ctx.stage('embedded', { count: embedded });

    // 3. related_keywords 계산 — embedding 있는 최근 7일 키워드 대상
    const { data: embeddedRows, error: embErr } = await supa
      .from('trend_keywords')
      .select('id, keyword, category')
      .gte('collected_date', cutoff)
      .not('embedding', 'is', null)
      .limit(500);

    if (embErr) {
      console.error('[scheduled-trends-embeddings] 임베딩 행 조회 실패:', embErr.message);
    }

    await ctx.stage('clustering', { count: embeddedRows?.length || 0 });

    // 4. RPC find_similar_keywords로 top-5 관련 키워드 계산 후 저장
    let clusters = 0;
    for (const row of (embeddedRows || [])) {
      try {
        const { data: similar, error: rpcErr } = await supa.rpc('find_similar_keywords', {
          row_id: row.id,
          cat: row.category,
          match_threshold: 0.75,
          match_count: 5,
        });

        if (rpcErr) {
          // RPC 오류 시 해당 행만 건너뜀 — 기존 파이프라인 영향 없음
          console.error(`[scheduled-trends-embeddings] RPC 실패 (id=${row.id}):`, rpcErr.message);
          continue;
        }

        const relatedKws = (similar || []).map(s => s.keyword).filter(Boolean);
        if (relatedKws.length === 0) continue;

        await supa.from('trend_keywords')
          .update({ related_keywords: relatedKws })
          .eq('id', row.id);
        clusters++;
      } catch (e) {
        console.error(`[scheduled-trends-embeddings] 클러스터 저장 실패 (id=${row.id}):`, e.message);
      }
    }

    await ctx.stage('complete', { embedded, clusters });
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, embedded, clusters }),
    };
  },
});

module.exports.config = { schedule: '0 18 * * 1' };  // 매주 화요일 KST 03:00 (= UTC 월요일 18:00)
