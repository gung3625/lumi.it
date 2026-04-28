-- =========================================================================
-- Sprint 4: 셀러 대시보드 + 시장 중심 피벗 (트렌드 메인 카드)
--   profit_calculator + sync_status + live_events + trend_recommendations + seller_categories
-- 적용 방법: Supabase SQL Editor에서 직접 실행
-- 멱등(idempotent)하게 작성 — 중복 실행 안전
--
-- 메모리 근거:
--   - project_market_centric_pivot_0428.md (시장 중심 피벗 = 메인 가치 축)
--   - project_phase1_strategic_differentiation.md (Profit Analytics 11단계)
--   - project_data_pipeline_architecture.md (역방향 + 라이브 스트림)
--   - project_proactive_ux_paradigm.md (선제 제안)
-- =========================================================================

-- =========================================================================
-- 1. seller_cost_settings — 셀러별 비용 설정 (Profit 계산용)
-- =========================================================================
CREATE TABLE IF NOT EXISTS seller_cost_settings (
  seller_id UUID PRIMARY KEY REFERENCES sellers(id) ON DELETE CASCADE,

  -- 평균 포장재 비용 (건당)
  packaging_cost_per_unit INTEGER NOT NULL DEFAULT 500,
  -- 평균 송장비 (건당)
  shipping_cost_per_unit INTEGER NOT NULL DEFAULT 3000,
  -- 광고비 비율 (% — 매출 대비)
  ad_spend_ratio DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  -- 결제 수수료 비율 (% — 마켓별 default 외 셀러 추가)
  payment_fee_ratio DECIMAL(5,2) NOT NULL DEFAULT 3.30,
  -- 부가세 적용 여부
  vat_applicable BOOLEAN NOT NULL DEFAULT TRUE,

  -- 마켓별 수수료 override (JSONB — 카테고리별 default 외 셀러가 별도로 입력)
  market_fee_overrides JSONB DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION update_seller_cost_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS seller_cost_settings_updated_at_trigger ON seller_cost_settings;
CREATE TRIGGER seller_cost_settings_updated_at_trigger
  BEFORE UPDATE ON seller_cost_settings
  FOR EACH ROW EXECUTE FUNCTION update_seller_cost_settings_updated_at();

ALTER TABLE seller_cost_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers manage own cost settings" ON seller_cost_settings;
CREATE POLICY "Sellers manage own cost settings" ON seller_cost_settings
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE seller_cost_settings IS 'Sprint 4 셀러별 비용 설정 — 통장 남는 돈 (Profit) 계산 입력값';

-- =========================================================================
-- 2. market_fee_table — 마켓별 카테고리별 수수료 룩업 (시스템 default)
-- =========================================================================
CREATE TABLE IF NOT EXISTS market_fee_table (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market TEXT NOT NULL CHECK (market IN ('coupang', 'naver', 'toss')),
  category_key TEXT NOT NULL,           -- 'default', 'fashion', 'food', 'beauty' 등
  fee_ratio DECIMAL(5,2) NOT NULL,       -- % 단위 (예: 10.80)
  display_label TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (market, category_key)
);

ALTER TABLE market_fee_table ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone read market fees" ON market_fee_table;
CREATE POLICY "Anyone read market fees" ON market_fee_table
  FOR SELECT USING (active = TRUE);

INSERT INTO market_fee_table (market, category_key, fee_ratio, display_label) VALUES
  ('coupang', 'default', 10.80, '쿠팡 일반 카테고리'),
  ('coupang', 'fashion', 10.80, '쿠팡 패션·의류'),
  ('coupang', 'food',    10.80, '쿠팡 식품'),
  ('coupang', 'beauty',  10.80, '쿠팡 뷰티'),
  ('naver',   'default',  5.50, '네이버 일반 카테고리'),
  ('naver',   'fashion',  5.50, '네이버 패션'),
  ('naver',   'food',     5.50, '네이버 식품'),
  ('naver',   'beauty',   5.50, '네이버 뷰티'),
  ('toss',    'default',  8.00, '토스쇼핑 표준')
ON CONFLICT (market, category_key) DO UPDATE SET
  fee_ratio = EXCLUDED.fee_ratio,
  display_label = EXCLUDED.display_label,
  updated_at = NOW();

COMMENT ON TABLE market_fee_table IS 'Sprint 4 마켓 수수료 룩업 — Profit 계산 자동 차감용';

-- =========================================================================
-- 3. live_events — 실시간 이벤트 피드 (Realtime Channel)
-- =========================================================================
CREATE TABLE IF NOT EXISTS live_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,

  event_type TEXT NOT NULL CHECK (event_type IN (
    'new_order', 'order_paid', 'order_shipped', 'order_delivered',
    'stock_low', 'stock_zero',
    'cs_received', 'cs_responded',
    'return_requested', 'return_completed',
    'kill_switch_activated', 'kill_switch_resumed',
    'sync_failed', 'sync_recovered',
    'profit_milestone', 'trend_alert'
  )),

  -- 표시용
  title TEXT NOT NULL,
  message TEXT,
  icon TEXT,                              -- lucide icon name
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'success', 'warning', 'critical')),

  -- 관련 리소스
  reference_type TEXT,                    -- 'order' / 'product' / 'cs_thread'
  reference_id UUID,
  market TEXT,

  metadata JSONB DEFAULT '{}'::jsonb,

  -- Read 추적
  read_at TIMESTAMPTZ,
  archived BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_live_events_seller ON live_events(seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_live_events_unread ON live_events(seller_id, read_at) WHERE read_at IS NULL AND archived = FALSE;
CREATE INDEX IF NOT EXISTS idx_live_events_severity ON live_events(seller_id, severity, created_at DESC);

ALTER TABLE live_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers read own events" ON live_events;
CREATE POLICY "Sellers read own events" ON live_events
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE live_events IS 'Sprint 4 실시간 이벤트 피드 — Supabase Realtime 채널로 셀러에게 push';

-- =========================================================================
-- 4. market_sync_status — 마켓별 동기화 헬스 (대시보드 Sync Status Card)
-- =========================================================================
CREATE TABLE IF NOT EXISTS market_sync_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  market TEXT NOT NULL CHECK (market IN ('coupang', 'naver', 'toss')),

  -- 마지막 동기화
  last_synced_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_error_message TEXT,

  -- 상태
  health_status TEXT NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('healthy', 'degraded', 'failing', 'unknown')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,

  -- 동기화 통계 (24h)
  orders_synced_24h INTEGER NOT NULL DEFAULT 0,
  cs_synced_24h INTEGER NOT NULL DEFAULT 0,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (seller_id, market)
);

CREATE INDEX IF NOT EXISTS idx_market_sync_status_seller ON market_sync_status(seller_id);
CREATE INDEX IF NOT EXISTS idx_market_sync_status_failing ON market_sync_status(health_status) WHERE health_status IN ('degraded', 'failing');

CREATE OR REPLACE FUNCTION update_market_sync_status_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_sync_status_updated_at_trigger ON market_sync_status;
CREATE TRIGGER market_sync_status_updated_at_trigger
  BEFORE UPDATE ON market_sync_status
  FOR EACH ROW EXECUTE FUNCTION update_market_sync_status_updated_at();

ALTER TABLE market_sync_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers read own sync status" ON market_sync_status;
CREATE POLICY "Sellers read own sync status" ON market_sync_status
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE market_sync_status IS 'Sprint 4 마켓 동기화 헬스 — 대시보드 Sync Status Card 표시';

-- =========================================================================
-- 5. seller_trend_matches — 셀러 카테고리 + 트렌드 매칭 (Sprint 4 시장 중심)
-- =========================================================================
CREATE TABLE IF NOT EXISTS seller_trend_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,

  trend_keyword TEXT NOT NULL,
  trend_category TEXT NOT NULL,           -- cafe / food / beauty / etc.
  match_score DECIMAL(5,2) NOT NULL,      -- 0.00 ~ 100.00
  match_reason TEXT,                      -- "사장님 매장 카테고리=fashion + 키워드 트렌드 +342%"

  -- 트렌드 신호
  velocity_pct INTEGER,                   -- 전주 대비 %
  signal_tier TEXT,                        -- 'rising' / 'peaking' / 'season'
  estimated_revenue_min INTEGER,
  estimated_revenue_max INTEGER,

  -- 셀러 액션 추적
  viewed_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  registered_at TIMESTAMPTZ,              -- 트렌드 → 등록까지 이동했는가
  registered_product_id UUID REFERENCES products(id) ON DELETE SET NULL,

  -- 시즌 임박 표시
  season_event TEXT,                      -- '어버이날', '크리스마스' 등
  season_peak_at DATE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ                   -- 일정 시간 후 자동 만료
);

CREATE INDEX IF NOT EXISTS idx_seller_trend_matches_seller ON seller_trend_matches(seller_id, match_score DESC);
-- 부분 인덱스 WHERE에는 IMMUTABLE 함수만 허용 — NOW() 제거, expires_at 필터는 쿼리에서 적용
CREATE INDEX IF NOT EXISTS idx_seller_trend_matches_active ON seller_trend_matches(seller_id, created_at DESC) WHERE dismissed_at IS NULL;

ALTER TABLE seller_trend_matches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers manage own trend matches" ON seller_trend_matches;
CREATE POLICY "Sellers manage own trend matches" ON seller_trend_matches
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE seller_trend_matches IS 'Sprint 4 시장 중심 — 셀러 카테고리 + 트렌드 매칭 추천';

-- =========================================================================
-- 6. profit_snapshots — 주간/월간 Profit 스냅샷 (시계열)
-- =========================================================================
CREATE TABLE IF NOT EXISTS profit_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,

  period_type TEXT NOT NULL CHECK (period_type IN ('daily', 'weekly', 'monthly')),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,

  gross_revenue INTEGER NOT NULL DEFAULT 0,        -- 총 매출
  market_fees INTEGER NOT NULL DEFAULT 0,           -- 마켓 수수료
  ad_spend INTEGER NOT NULL DEFAULT 0,              -- 광고비
  packaging_cost INTEGER NOT NULL DEFAULT 0,        -- 포장재
  shipping_cost INTEGER NOT NULL DEFAULT 0,         -- 송장비
  payment_fees INTEGER NOT NULL DEFAULT 0,          -- 결제 수수료
  vat INTEGER NOT NULL DEFAULT 0,                    -- 부가세
  cogs INTEGER NOT NULL DEFAULT 0,                   -- 원가 (셀러 입력 시)

  net_profit INTEGER NOT NULL DEFAULT 0,            -- 통장에 남는 돈
  profit_margin DECIMAL(5,2),                        -- %

  order_count INTEGER NOT NULL DEFAULT 0,
  units_sold INTEGER NOT NULL DEFAULT 0,

  -- 비교용 (전 기간 vs 현재)
  prev_net_profit INTEGER,
  delta_pct DECIMAL(6,2),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (seller_id, period_type, period_start)
);

CREATE INDEX IF NOT EXISTS idx_profit_snapshots_seller ON profit_snapshots(seller_id, period_type, period_start DESC);

ALTER TABLE profit_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers read own profit snapshots" ON profit_snapshots;
CREATE POLICY "Sellers read own profit snapshots" ON profit_snapshots
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE profit_snapshots IS 'Sprint 4 Profit 시계열 스냅샷 — 통장 남는 돈 시각화';

-- =========================================================================
-- 7. trend_dismissals — 트렌드 카드 거절 학습 (선제 제안 패러다임 6번 원칙)
-- =========================================================================
CREATE TABLE IF NOT EXISTS trend_dismissals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  trend_keyword TEXT NOT NULL,
  trend_category TEXT,
  dismissal_reason TEXT,                   -- 'not_interested' / 'wrong_category' / 'price_unsuitable' / 'other'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trend_dismissals_seller ON trend_dismissals(seller_id, trend_keyword);

ALTER TABLE trend_dismissals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers manage own dismissals" ON trend_dismissals;
CREATE POLICY "Sellers manage own dismissals" ON trend_dismissals
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE trend_dismissals IS 'Sprint 4 셀러가 거절한 트렌드 키워드 학습 — 3회 거절 시 추천 비활성';

-- =========================================================================
-- 8. season_events — 시즌 이벤트 캘린더 (어버이날/크리스마스 등)
-- =========================================================================
CREATE TABLE IF NOT EXISTS season_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name TEXT NOT NULL,
  event_date DATE NOT NULL,
  alert_lead_days INTEGER NOT NULL DEFAULT 14,    -- D-N 알림 시작
  related_categories TEXT[] DEFAULT '{}',
  related_keywords TEXT[] DEFAULT '{}',
  message_template TEXT,                          -- "어버이날 D-{days}, {keyword} +{velocity}%"
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (event_name, event_date)
);

ALTER TABLE season_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone read season events" ON season_events;
CREATE POLICY "Anyone read season events" ON season_events
  FOR SELECT USING (active = TRUE);

INSERT INTO season_events (event_name, event_date, alert_lead_days, related_categories, related_keywords, message_template) VALUES
  ('어버이날', '2026-05-08', 14, ARRAY['flower', 'food', 'beauty'], ARRAY['카네이션', '어버이날 선물', '효도선물'], '어버이날 D-{days}, 카네이션 키워드 검색량 +400%'),
  ('스승의날', '2026-05-15', 14, ARRAY['flower', 'food'], ARRAY['스승의날 선물', '꽃다발', '감사선물'], '스승의날 D-{days}, 꽃다발 키워드 +250%'),
  ('어린이날', '2026-05-05', 14, ARRAY['kids', 'shop'], ARRAY['어린이날 선물', '장난감', '아동복'], '어린이날 D-{days}, 키즈 카테고리 +320%'),
  ('크리스마스', '2026-12-25', 30, ARRAY['food', 'shop', 'flower'], ARRAY['크리스마스 트리', '연말 선물', '연말 파티'], '크리스마스 D-{days}, 시즌 카테고리 진입 시점'),
  ('연말', '2026-12-31', 21, ARRAY['food', 'fashion'], ARRAY['연말 모임', '송년 선물'], '연말 D-{days}, 모임용 키워드 활성')
ON CONFLICT (event_name, event_date) DO UPDATE SET
  alert_lead_days = EXCLUDED.alert_lead_days,
  related_categories = EXCLUDED.related_categories,
  related_keywords = EXCLUDED.related_keywords,
  message_template = EXCLUDED.message_template;

COMMENT ON TABLE season_events IS 'Sprint 4 시즌 이벤트 캘린더 — 트렌드 카드에 D-N 노출';

-- =========================================================================
-- 마이그레이션 완료 검증
-- =========================================================================
-- SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN
--   ('seller_cost_settings','market_fee_table','live_events','market_sync_status','seller_trend_matches','profit_snapshots','trend_dismissals','season_events');
-- → 8
-- SELECT count(*) FROM market_fee_table WHERE active=TRUE;  → 9
-- SELECT count(*) FROM season_events WHERE active=TRUE;     → 5
