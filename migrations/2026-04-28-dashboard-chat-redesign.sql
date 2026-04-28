-- =========================================================================
-- 2026-04-28 Dashboard Chat Redesign
--   command_history + command_favorites + llm_cache + rate_limit
--
-- 적용 방법: Supabase SQL Editor에서 직접 실행
-- 멱등(idempotent)하게 작성 — 중복 실행 안전
--
-- 메모리 근거:
--   - project_linear_canvas_ui_doctrine_0428.md (채팅형 3영역)
--   - project_intelligence_strategy_doctrine_0428.md (Orchestrator)
--   - project_agent_architecture_0428.md (Cost Tier 0~3 + 캐싱 80%)
--   - project_ai_capability_boundary.md (Level 1~4)
-- =========================================================================

-- =========================================================================
-- 1. command_history — 셀러별 명령 기록 (좌측 사이드바 = ChatGPT 대화 목록)
-- =========================================================================
CREATE TABLE IF NOT EXISTS command_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,

  -- 명령 입력 원문
  input TEXT NOT NULL,
  -- 분류 결과: shop / greeting / non_related / abuse / weather / currency / calendar / calc
  intent TEXT NOT NULL DEFAULT 'shop',
  -- AI 능력 단계: 1=auto / 2=suggest / 3=assist / 4=human_only
  ability_level SMALLINT NOT NULL DEFAULT 2,
  -- Cost tier: 0(shell) / 1(mini) / 2(4o) / 3(vision)
  cost_tier SMALLINT NOT NULL DEFAULT 0,

  -- 처리 결과 요약 (간단 텍스트, 길면 result_payload 참조)
  summary TEXT,
  -- 원본 결과 JSON (캔버스 재현용)
  result_payload JSONB DEFAULT '{}'::jsonb,
  -- 처리 상태: pending / done / blocked / failed
  status TEXT NOT NULL DEFAULT 'done',
  -- 거부 사유 (blocked인 경우)
  blocked_reason TEXT,

  -- 핀 즐겨찾기 여부
  is_pinned BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS command_history_seller_created_idx
  ON command_history (seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS command_history_seller_pinned_idx
  ON command_history (seller_id, is_pinned)
  WHERE is_pinned = TRUE;

ALTER TABLE command_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers manage own command history" ON command_history;
CREATE POLICY "Sellers manage own command history" ON command_history
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE command_history IS 'Dashboard 채팅 명령 히스토리 — 좌측 사이드바 ChatGPT 스타일 대화 목록';

-- =========================================================================
-- 2. command_favorites — 즐겨찾기 명령 (재사용 빈도 높은 명령)
-- =========================================================================
CREATE TABLE IF NOT EXISTS command_favorites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,

  label TEXT NOT NULL,            -- "오늘 뜨는 상품"
  command_text TEXT NOT NULL,     -- 실행 시 보낼 input
  icon TEXT,                      -- 표시용 (단일 글자 또는 lucide name)
  sort_order INT NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (seller_id, label)
);

CREATE INDEX IF NOT EXISTS command_favorites_seller_idx
  ON command_favorites (seller_id, sort_order);

ALTER TABLE command_favorites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers manage own command favorites" ON command_favorites;
CREATE POLICY "Sellers manage own command favorites" ON command_favorites
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE command_favorites IS 'Dashboard 즐겨찾기 명령 — 사이드바 핀 영역';

-- =========================================================================
-- 3. llm_cache — LLM 응답 캐싱 (80% 절감 목표)
--   key = sha256(tier + input_normalized + context_hash)
-- =========================================================================
CREATE TABLE IF NOT EXISTS llm_cache (
  cache_key TEXT PRIMARY KEY,
  tier SMALLINT NOT NULL DEFAULT 1,        -- 0/1/2/3
  result_json JSONB NOT NULL,
  hit_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS llm_cache_expires_idx
  ON llm_cache (expires_at);

-- 시스템 캐싱이라 RLS 필요 없음 (service_role만 접근)
ALTER TABLE llm_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only llm cache" ON llm_cache;
CREATE POLICY "Service role only llm cache" ON llm_cache
  USING (FALSE);  -- 서비스 롤만 (auth.role() = 'service_role')

COMMENT ON TABLE llm_cache IS '명령 처리 결과 캐싱 — Tier별 TTL 다름';

-- =========================================================================
-- 4. rate_limit_counters — Tier별 일일 호출 카운터 (최악 시나리오 방어)
-- =========================================================================
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  tier_key TEXT NOT NULL,                  -- 'tier3_vision' / 'tier2_4o' / 'tier1_mini' / 'total'
  bucket_date DATE NOT NULL DEFAULT CURRENT_DATE,
  call_count INT NOT NULL DEFAULT 0,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (seller_id, tier_key, bucket_date)
);

CREATE INDEX IF NOT EXISTS rate_limit_counters_lookup_idx
  ON rate_limit_counters (seller_id, tier_key, bucket_date);

ALTER TABLE rate_limit_counters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers read own rate limit" ON rate_limit_counters;
CREATE POLICY "Sellers read own rate limit" ON rate_limit_counters
  FOR SELECT USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE rate_limit_counters IS '셀러별 LLM 호출 카운터 — 최악 시나리오 방어';

-- =========================================================================
-- 5. command_abuse_log — 차단된 명령 로그 (욕설·비관련 등)
-- =========================================================================
CREATE TABLE IF NOT EXISTS command_abuse_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID REFERENCES sellers(id) ON DELETE CASCADE,
  input TEXT NOT NULL,
  reason TEXT NOT NULL,             -- 'abuse' / 'too_short' / 'rate_limit'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS command_abuse_log_created_idx
  ON command_abuse_log (created_at DESC);

ALTER TABLE command_abuse_log ENABLE ROW LEVEL SECURITY;
-- 셀러 본인은 자기 로그 못 봄 (관리자만)
DROP POLICY IF EXISTS "Service role only abuse log" ON command_abuse_log;
CREATE POLICY "Service role only abuse log" ON command_abuse_log
  USING (FALSE);

COMMENT ON TABLE command_abuse_log IS '차단된 명령 로그 — 학습용 (욕설·비관련)';

-- =========================================================================
-- pgrst_reload
-- =========================================================================
NOTIFY pgrst, 'reload schema';
