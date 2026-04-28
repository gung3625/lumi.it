-- =========================================================================
-- Sprint 3: 주문 수집·송장·CS·반품 풀 흐름
--   orders + inventory_movements + cs_threads + cs_messages + tracking_events + kill_switch_log
-- 적용 방법: Supabase SQL Editor에서 직접 실행
-- 멱등(idempotent)하게 작성 — 중복 실행 안전
-- =========================================================================

-- =========================================================================
-- 1. orders — 주문 본문 (마켓 → 루미 수집 + 루미 → 마켓 송장 + 역방향 반품)
-- =========================================================================
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  market TEXT NOT NULL CHECK (market IN ('coupang', 'naver', 'toss')),
  market_order_id TEXT NOT NULL,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  market_product_id TEXT,
  product_title TEXT,

  -- 마스킹된 구매자 정보 (Privacy-by-Design)
  -- 평문 저장 절대 금지 (메모리 feedback_market_integration_principles.md)
  buyer_name_masked TEXT,
  buyer_phone_masked TEXT,
  buyer_address_masked TEXT,

  quantity INTEGER NOT NULL DEFAULT 1,
  total_price INTEGER NOT NULL DEFAULT 0,
  option_text TEXT,

  -- 정방향: received → paid → shipping → delivered
  -- 역방향: returned / exchanged / cancelled
  status TEXT NOT NULL CHECK (status IN ('received', 'paid', 'shipping', 'delivered', 'returned', 'exchanged', 'cancelled')),

  -- 송장 (루미 → 마켓)
  tracking_number TEXT,
  courier_code TEXT,
  shipped_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  tracking_last_synced_at TIMESTAMPTZ,
  tracking_status TEXT,

  -- 역방향 (반품·교환·취소)
  return_requested_at TIMESTAMPTZ,
  return_completed_at TIMESTAMPTZ,
  return_reason TEXT,
  exchange_requested_at TIMESTAMPTZ,
  exchange_completed_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  cancelled_at TIMESTAMPTZ,

  -- 재고 가산 트리거 (반품 처리 시)
  stock_restored BOOLEAN NOT NULL DEFAULT FALSE,
  stock_restored_at TIMESTAMPTZ,

  -- 마켓 원본 (디버깅·재처리용)
  raw_payload JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (market, market_order_id)
);

CREATE INDEX IF NOT EXISTS idx_orders_seller_status ON orders(seller_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_tracking ON orders(tracking_number) WHERE tracking_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_market ON orders(market, market_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_returned ON orders(seller_id, return_requested_at DESC) WHERE return_requested_at IS NOT NULL;

CREATE OR REPLACE FUNCTION update_orders_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_updated_at_trigger ON orders;
CREATE TRIGGER orders_updated_at_trigger
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_orders_updated_at();

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers manage own orders" ON orders;
CREATE POLICY "Sellers manage own orders" ON orders
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE orders IS 'Sprint 3 마켓 주문 (정방향 + 역방향). buyer_*_masked 컬럼만 — 평문 개인정보 절대 금지';
COMMENT ON COLUMN orders.status IS 'received(접수)→paid(결제완료)→shipping(배송중)→delivered(배송완료) / returned/exchanged/cancelled(역방향)';

-- =========================================================================
-- 2. inventory_movements — 재고 이동 기록 (역방향 반품 가산 등)
-- =========================================================================
CREATE TABLE IF NOT EXISTS inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  market TEXT,

  movement_type TEXT NOT NULL CHECK (movement_type IN ('sale', 'return', 'exchange', 'manual', 'sync')),
  quantity_delta INTEGER NOT NULL,  -- 음수 차감 / 양수 가산

  reference_type TEXT,    -- 'order' / 'manual' / 'cron'
  reference_id UUID,

  note TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_seller ON inventory_movements(seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_product ON inventory_movements(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_ref ON inventory_movements(reference_type, reference_id);

ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers read own movements" ON inventory_movements;
CREATE POLICY "Sellers read own movements" ON inventory_movements
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE inventory_movements IS 'Sprint 3 재고 이동 로그 — 반품/교환/판매 모든 가감 흔적';

-- =========================================================================
-- 3. cs_threads — CS 문의 스레드
-- =========================================================================
CREATE TABLE IF NOT EXISTS cs_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  market TEXT NOT NULL CHECK (market IN ('coupang', 'naver', 'toss')),
  market_thread_id TEXT NOT NULL,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  market_order_id TEXT,

  buyer_name_masked TEXT,

  category TEXT CHECK (category IN ('shipping', 'exchange', 'refund', 'product', 'other')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'resolved', 'closed')),

  -- AI 답변 자동 생성 (메모리 proactive_ux_paradigm 시나리오 5)
  ai_suggested_response TEXT,
  ai_confidence DECIMAL(4,3),
  ai_generated_at TIMESTAMPTZ,
  ai_model TEXT,

  -- 셀러 응답
  seller_response TEXT,
  responded_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,

  -- 첫 문의 요약 (리스트 빠른 표시용)
  preview_text TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (market, market_thread_id)
);

CREATE INDEX IF NOT EXISTS idx_cs_threads_seller_status ON cs_threads(seller_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cs_threads_pending ON cs_threads(seller_id, created_at DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_cs_threads_category ON cs_threads(seller_id, category);

CREATE OR REPLACE FUNCTION update_cs_threads_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cs_threads_updated_at_trigger ON cs_threads;
CREATE TRIGGER cs_threads_updated_at_trigger
  BEFORE UPDATE ON cs_threads
  FOR EACH ROW EXECUTE FUNCTION update_cs_threads_updated_at();

ALTER TABLE cs_threads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers manage own threads" ON cs_threads;
CREATE POLICY "Sellers manage own threads" ON cs_threads
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE cs_threads IS 'Sprint 3 마켓 CS 문의 — AI 답변 + 셀러 검수 1탭 전송';

-- =========================================================================
-- 4. cs_messages — CS 메시지 (스레드 안의 개별 발화)
-- =========================================================================
CREATE TABLE IF NOT EXISTS cs_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES cs_threads(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('buyer', 'seller', 'system', 'ai')),
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cs_messages_thread ON cs_messages(thread_id, created_at);

ALTER TABLE cs_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers read own messages" ON cs_messages;
CREATE POLICY "Sellers read own messages" ON cs_messages
  USING (
    EXISTS (
      SELECT 1 FROM cs_threads t
      WHERE t.id = cs_messages.thread_id
        AND t.seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id')
    )
  );

-- =========================================================================
-- 5. tracking_events — 배송 추적 이벤트 (스마트택배 모킹 + 추적용)
-- =========================================================================
CREATE TABLE IF NOT EXISTS tracking_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,

  status TEXT NOT NULL,           -- 'shipping' / 'in_transit' / 'out_for_delivery' / 'delivered' / 'exception'
  description TEXT,
  location TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,

  source TEXT,                    -- 'smart_taekbae' / 'public_post' / 'webhook' / 'mock'
  raw JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tracking_events_order ON tracking_events(order_id, occurred_at DESC);

ALTER TABLE tracking_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers read own tracking" ON tracking_events;
CREATE POLICY "Sellers read own tracking" ON tracking_events
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE tracking_events IS 'Sprint 3 배송 추적 이벤트 — 스마트택배 또는 공공API 1시간마다 갱신';

-- =========================================================================
-- 6. kill_switch_log — Kill Switch 작동 이력 (감사용)
-- =========================================================================
CREATE TABLE IF NOT EXISTS kill_switch_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,

  scope TEXT NOT NULL CHECK (scope IN ('market', 'product', 'option')),
  market TEXT,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  option_value TEXT,

  action TEXT NOT NULL CHECK (action IN ('stop', 'resume')),
  reason TEXT,

  -- 마켓 어댑터 결과
  applied_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  results JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kill_switch_log_seller ON kill_switch_log(seller_id, created_at DESC);

ALTER TABLE kill_switch_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers read own kill log" ON kill_switch_log;
CREATE POLICY "Sellers read own kill log" ON kill_switch_log
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE kill_switch_log IS 'Sprint 3 Kill Switch 감사 로그 — 마켓·상품·옵션 단위 차단/재개';

-- =========================================================================
-- 7. courier_codes — 택배사 코드 룩업 (드롭다운용)
-- =========================================================================
CREATE TABLE IF NOT EXISTS courier_codes (
  code TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  smart_tracker_code TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL DEFAULT 999,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE courier_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone read couriers" ON courier_codes;
CREATE POLICY "Anyone read couriers" ON courier_codes
  FOR SELECT USING (active = TRUE);

INSERT INTO courier_codes (code, display_name, smart_tracker_code, display_order) VALUES
  ('CJGLS', 'CJ대한통운', '04', 10),
  ('LOGEN', '로젠택배', '06', 20),
  ('HJT',   '한진택배', '05', 30),
  ('LOTTE', '롯데택배', '08', 40),
  ('EPOST', '우체국택배', '01', 50),
  ('CVSNET','편의점택배', '46', 60)
ON CONFLICT (code) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  smart_tracker_code = EXCLUDED.smart_tracker_code,
  display_order = EXCLUDED.display_order,
  updated_at = NOW();

COMMENT ON TABLE courier_codes IS 'Sprint 3 택배사 룩업 — 모바일 송장 입력 드롭다운 + 추적 API용';

-- =========================================================================
-- 마이그레이션 완료 검증 쿼리
-- =========================================================================
-- SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('orders','inventory_movements','cs_threads','cs_messages','tracking_events','kill_switch_log','courier_codes');
-- → 7
-- SELECT count(*) FROM courier_codes WHERE active = TRUE;
-- → 6
