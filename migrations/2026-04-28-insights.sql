-- =========================================================================
-- AI 인사이트 자동 보고서 (주간/월간/온디맨드)
-- 메모리 근거:
--   - project_intelligence_strategy_doctrine_0428.md (Tier 라우팅, Cost Tier 0~3)
--   - project_phase1_strategic_differentiation.md (Profit Analytics)
--   - project_proactive_ux_paradigm.md (선제 제안)
-- 멱등(idempotent) — 중복 실행 안전
-- =========================================================================

-- =========================================================================
-- 1. insight_reports — 주간/월간/온디맨드 보고서 본문 (JSON 구조)
-- =========================================================================
CREATE TABLE IF NOT EXISTS insight_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,

  -- 보고 종류
  report_type TEXT NOT NULL CHECK (report_type IN ('weekly', 'monthly', 'on_demand')),

  -- 보고 기간
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,

  -- 4o 생성 본문 (JSON 스키마 — summary / top_performers / bottom_performers / trend_match / predictions / actions)
  report_json JSONB NOT NULL,

  -- 한 줄 요약 (대시보드 카드용)
  summary TEXT,

  -- 발송 추적
  delivered_at TIMESTAMPTZ,
  delivery_channel TEXT,                    -- 'alimtalk' / 'email' / 'dashboard_only'
  delivery_status TEXT,                     -- 'sent' / 'failed' / 'pending'

  -- 비용 추적 (Cost Tier 가시화)
  llm_cost_krw INTEGER NOT NULL DEFAULT 0,
  llm_cached BOOLEAN NOT NULL DEFAULT FALSE,

  -- 캐시 키 (TTL: weekly 7일 / monthly 30일)
  cache_key TEXT,
  expires_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (seller_id, report_type, period_start)
);

CREATE INDEX IF NOT EXISTS idx_insight_reports_seller
  ON insight_reports(seller_id, report_type, period_end DESC);

CREATE INDEX IF NOT EXISTS idx_insight_reports_cache
  ON insight_reports(cache_key) WHERE cache_key IS NOT NULL;

ALTER TABLE insight_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers read own insight reports" ON insight_reports;
CREATE POLICY "Sellers read own insight reports" ON insight_reports
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE insight_reports IS 'AI 인사이트 주간/월간/온디맨드 보고서 — Tier 2 (gpt-4o) 생성, JSON 본문 보존';

-- =========================================================================
-- 2. insight_predictions — 예측 (next_week_revenue / risks)
-- =========================================================================
CREATE TABLE IF NOT EXISTS insight_predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  report_id UUID REFERENCES insight_reports(id) ON DELETE CASCADE,

  prediction_type TEXT NOT NULL CHECK (prediction_type IN (
    'next_week_revenue', 'next_month_revenue',
    'stock_shortage', 'season_alert',
    'price_adjustment', 'churn_risk'
  )),

  predicted_value JSONB NOT NULL,           -- { value, currency, confidence }
  confidence DECIMAL(4,3) NOT NULL DEFAULT 0.5,    -- 0.000 ~ 1.000

  -- 검증 (실제 값과 비교 — 모델 평가용)
  actual_value JSONB,
  verified_at TIMESTAMPTZ,
  accuracy_score DECIMAL(5,2),

  message TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_insight_predictions_seller
  ON insight_predictions(seller_id, prediction_type, created_at DESC);

ALTER TABLE insight_predictions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers read own predictions" ON insight_predictions;
CREATE POLICY "Sellers read own predictions" ON insight_predictions
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE insight_predictions IS 'AI 인사이트 예측 — 다음 주 매출, 재고 부족 위험 등';

-- =========================================================================
-- 3. insight_actions — 보고서 액션 제안 (Action Agent 연계)
-- =========================================================================
CREATE TABLE IF NOT EXISTS insight_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  report_id UUID REFERENCES insight_reports(id) ON DELETE CASCADE,

  action_type TEXT NOT NULL,                -- 'price_adjust' / 'restock' / 'register_trend' / 'pause_ad' 등
  title TEXT NOT NULL,
  description TEXT,

  -- 대상 리소스
  target_type TEXT,                          -- 'product' / 'market' / 'trend'
  target_id UUID,
  target_metadata JSONB DEFAULT '{}'::jsonb,

  -- 우선순위
  priority INTEGER NOT NULL DEFAULT 50,     -- 0~100, 높을수록 우선

  -- 셀러 응답
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'dismissed', 'completed')),
  responded_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_insight_actions_seller_open
  ON insight_actions(seller_id, priority DESC, created_at DESC) WHERE status = 'proposed';

ALTER TABLE insight_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers manage own insight actions" ON insight_actions;
CREATE POLICY "Sellers manage own insight actions" ON insight_actions
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE insight_actions IS 'AI 인사이트 액션 제안 — 셀러 1탭 수락, Action Agent 연계';

-- =========================================================================
-- 4. insight_cost_ledger — 셀러별 월간 LLM 비용 추적 (₩200/월 한도)
-- =========================================================================
CREATE TABLE IF NOT EXISTS insight_cost_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,

  bucket_month DATE NOT NULL,               -- YYYY-MM-01 형식 (월별 집계)
  total_cost_krw INTEGER NOT NULL DEFAULT 0,
  call_count INTEGER NOT NULL DEFAULT 0,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (seller_id, bucket_month)
);

CREATE INDEX IF NOT EXISTS idx_insight_cost_ledger_seller
  ON insight_cost_ledger(seller_id, bucket_month DESC);

ALTER TABLE insight_cost_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers read own insight cost" ON insight_cost_ledger;
CREATE POLICY "Sellers read own insight cost" ON insight_cost_ledger
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE insight_cost_ledger IS 'AI 인사이트 LLM 비용 원장 — 셀러당 월 ₩200 한도 방어';

-- =========================================================================
-- 마이그레이션 검증
--   SELECT count(*) FROM information_schema.tables WHERE table_schema='public'
--     AND table_name IN ('insight_reports','insight_predictions','insight_actions','insight_cost_ledger');
--   → 4
-- =========================================================================
