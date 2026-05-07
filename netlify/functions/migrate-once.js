// 일회성 마이그레이션 실행 함수 (이번 세션 추가된 4개 SQL 임베드)
// LUMI_SECRET Bearer 토큰으로만 호출 가능. 사용 후 파일째로 삭제 예정.

const { Client } = require('pg');

const MIGRATIONS = [
  {
    name: '20260507000003_account_deletion_grace.sql',
    sql: `
ALTER TABLE public.sellers
  ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS deletion_scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS deletion_cancelled_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_sellers_deletion_pending
  ON public.sellers(deletion_scheduled_at)
  WHERE deletion_requested_at IS NOT NULL AND deletion_cancelled_at IS NULL;

COMMENT ON COLUMN public.sellers.deletion_requested_at IS '회원 탈퇴 요청 시각 (NULL 이면 정상 회원)';
COMMENT ON COLUMN public.sellers.deletion_scheduled_at IS '실제 영구 삭제 예정 시각 (요청 + 30일)';
COMMENT ON COLUMN public.sellers.deletion_cancelled_at IS '복구 처리 시각 (NOT NULL 이면 탈퇴 취소된 상태)';
`,
  },
  {
    name: '20260507000004_sellers_store_profile_columns.sql',
    sql: `
ALTER TABLE public.sellers
  ADD COLUMN IF NOT EXISTS store_desc text,
  ADD COLUMN IF NOT EXISTS tone_sample_1 text,
  ADD COLUMN IF NOT EXISTS tone_sample_2 text,
  ADD COLUMN IF NOT EXISTS tone_sample_3 text;
`,
  },
  {
    name: '20260507000005_sellers_tone_profile.sql',
    sql: `
ALTER TABLE public.sellers
  ADD COLUMN IF NOT EXISTS tone_profile jsonb,
  ADD COLUMN IF NOT EXISTS tone_retrained_at timestamptz;

COMMENT ON COLUMN public.sellers.tone_profile IS '말투 프로파일 (brand-retrain 결과 JSON: tone, avgLength, emojiUsage, preferredKeywords, notes 등)';
COMMENT ON COLUMN public.sellers.tone_retrained_at IS '마지막 말투 재학습 시각';
`,
  },
  {
    name: '20260507000006_sellers_brand_settings.sql',
    sql: `
ALTER TABLE public.sellers
  ADD COLUMN IF NOT EXISTS brand_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS brand_settings_updated_at timestamptz;

COMMENT ON COLUMN public.sellers.brand_settings IS 'brand-admin 페이지 설정(JSON: tone, tone_custom, samples, ban_words, must_words, hashtags). whitelist 키만 저장.';
COMMENT ON COLUMN public.sellers.brand_settings_updated_at IS '마지막 brand_settings 저장 시각';
`,
  },
];

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors };

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!process.env.LUMI_SECRET || token !== process.env.LUMI_SECRET) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'unauthorized' }) };
  }

  if (!process.env.SUPABASE_DB_URL) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'SUPABASE_DB_URL missing' }) };
  }

  const client = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  const results = [];
  try {
    await client.connect();
    for (const m of MIGRATIONS) {
      try {
        await client.query(m.sql);
        results.push({ file: m.name, status: 'ok' });
      } catch (e) {
        results.push({ file: m.name, status: 'error', error: e.message });
      }
    }
  } catch (e) {
    return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'connect_failed', detail: e.message, results }) };
  } finally {
    try { await client.end(); } catch {}
  }

  return {
    statusCode: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, results }, null, 2),
  };
};
