-- =========================================================================
-- 반품·교환 풀 워크플로우 — 사장님 승인 게이트 + Audit
--   return_requests + return_history + return_status_transitions + return_logs + return_notifications
-- 적용 방법: Supabase SQL Editor에서 직접 실행
-- 멱등(idempotent)하게 작성 — 중복 실행 안전
--
-- 메모리 근거:
--   - feedback_market_integration_principles.md (HMAC·OAuth·검증·에러번역·Audit 5원칙)
--   - project_ai_capability_boundary.md (환불·분쟁 = 사장님 최종 결정)
--   - project_phase1_decisions_0426.md (반품·환불 정책)
--
-- 기존 marketplace_orders 테이블의 return_* 필드는 유지. 본 마이그레이션은
-- "셀러 승인 게이트 + 우선순위 큐 + 감사" 보강.
-- =========================================================================

-- =========================================================================
-- 1. return_requests — 반품·교환 요청 (마켓에서 들어오거나 셀러가 등록)
-- =========================================================================
CREATE TABLE IF NOT EXISTS return_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES marketplace_orders(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL CHECK (marketplace IN ('coupang', 'naver', 'toss')),

  -- 요청 종류
  request_type TEXT NOT NULL CHECK (request_type IN ('refund', 'exchange', 'partial_refund')),
  reason TEXT,
  reason_category TEXT CHECK (reason_category IN ('change_of_mind', 'defect', 'damaged', 'wrong_item', 'size_issue', 'shipping_delay', 'other')),

  -- 부분환불·교환 옵션
  partial_amount INTEGER,                   -- 부분환불 금액 (KRW)
  exchange_product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  exchange_option_text TEXT,

  -- 처리 상태
  --   pending      = 셀러 검토 대기 (우선순위 큐 노출)
  --   approved     = 셀러 승인 → 마켓 어댑터 호출 대기
  --   processing   = 마켓 호출 중 (race 가드)
  --   completed    = 마켓 호출 성공 + 재고 복원 완료
  --   rejected     = 셀러 거절
  --   failed       = 마켓 호출 실패 (retry_queue 적재)
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'processing', 'completed', 'rejected', 'failed')),

  -- 위험 임계값 플래그
  is_high_risk BOOLEAN NOT NULL DEFAULT FALSE,
  risk_reason TEXT,

  -- 처리 흔적
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  processed_by UUID REFERENCES sellers(id) ON DELETE SET NULL,

  -- 셀러 메모 (거절·내부 비고)
  seller_note TEXT,

  -- 마켓 응답 원본 (디버깅용)
  market_response JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_return_requests_seller_status
  ON return_requests(seller_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_return_requests_pending
  ON return_requests(seller_id, requested_at DESC)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_return_requests_order
  ON return_requests(order_id);
CREATE INDEX IF NOT EXISTS idx_return_requests_market
  ON return_requests(marketplace, status);

CREATE OR REPLACE FUNCTION update_return_requests_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS return_requests_updated_at_trigger ON return_requests;
CREATE TRIGGER return_requests_updated_at_trigger
  BEFORE UPDATE ON return_requests
  FOR EACH ROW EXECUTE FUNCTION update_return_requests_updated_at();

ALTER TABLE return_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers manage own return requests" ON return_requests;
CREATE POLICY "Sellers manage own return requests" ON return_requests
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE return_requests IS '반품·교환 요청 (사장님 승인 게이트). 환불 자동 X, 사장님 [예/아니오]만.';
COMMENT ON COLUMN return_requests.is_high_risk IS '₩100,000+ 또는 partial_refund 시 TRUE — 더 강한 확인 UI 노출';

-- =========================================================================
-- 2. return_history — 처리 이력 (audit_trail jsonb 누적)
-- =========================================================================
CREATE TABLE IF NOT EXISTS return_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID REFERENCES return_requests(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES marketplace_orders(id) ON DELETE CASCADE,
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL CHECK (marketplace IN ('coupang', 'naver', 'toss')),

  type TEXT NOT NULL CHECK (type IN ('refund', 'exchange', 'partial_refund')),
  reason TEXT,
  status TEXT NOT NULL,    -- 최종 상태 (completed / rejected / failed)
  amount INTEGER,           -- 환불 금액

  requested_at TIMESTAMPTZ NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_by UUID REFERENCES sellers(id) ON DELETE SET NULL,

  notes TEXT,

  -- 모든 상태 전이 기록 (요청·승인·처리·완료·실패)
  audit_trail JSONB NOT NULL DEFAULT '[]'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_return_history_seller
  ON return_history(seller_id, processed_at DESC);
CREATE INDEX IF NOT EXISTS idx_return_history_order
  ON return_history(order_id);
CREATE INDEX IF NOT EXISTS idx_return_history_request
  ON return_history(request_id);

ALTER TABLE return_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers read own return history" ON return_history;
CREATE POLICY "Sellers read own return history" ON return_history
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE return_history IS '반품 처리 완료 이력 (감사용). audit_trail 안에 모든 단계 흔적 누적.';

-- =========================================================================
-- 3. return_status_transitions — 상태 전이 시간순 기록 (요청 → 승인 → 처리 → 완료/실패)
-- =========================================================================
CREATE TABLE IF NOT EXISTS return_status_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES return_requests(id) ON DELETE CASCADE,
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,

  from_status TEXT,
  to_status TEXT NOT NULL,
  transition_reason TEXT,        -- '셀러 승인' / '셀러 거절' / '마켓 호출 성공' / '마켓 호출 실패'

  actor_type TEXT NOT NULL CHECK (actor_type IN ('seller', 'system', 'cron', 'webhook')),
  actor_id UUID,                  -- seller_id 또는 NULL (system)

  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_return_transitions_request
  ON return_status_transitions(request_id, created_at);
CREATE INDEX IF NOT EXISTS idx_return_transitions_seller
  ON return_status_transitions(seller_id, created_at DESC);

ALTER TABLE return_status_transitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers read own transitions" ON return_status_transitions;
CREATE POLICY "Sellers read own transitions" ON return_status_transitions
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE return_status_transitions IS '반품 상태 전이 흔적 — request 별 시간순 흐름 재구성용';

-- =========================================================================
-- 4. return_logs — 마켓 어댑터 호출 로그 (디버깅·재처리)
-- =========================================================================
CREATE TABLE IF NOT EXISTS return_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID REFERENCES return_requests(id) ON DELETE CASCADE,
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,

  operation TEXT NOT NULL,        -- 'process_return' / 'check_status' / 'cancel'
  request_payload JSONB,
  response_status INTEGER,
  response_body JSONB,
  duration_ms INTEGER,

  ok BOOLEAN NOT NULL DEFAULT FALSE,
  error_message TEXT,
  retryable BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_return_logs_request
  ON return_logs(request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_return_logs_seller_failed
  ON return_logs(seller_id, created_at DESC)
  WHERE ok = FALSE;

ALTER TABLE return_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers read own return logs" ON return_logs;
CREATE POLICY "Sellers read own return logs" ON return_logs
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE return_logs IS '마켓 어댑터 처리 호출 로그 — 실패 분석·재처리용';

-- =========================================================================
-- 5. return_notifications — 셀러·구매자 알림 발송 큐 (외부 송신은 send-notifications cron이)
-- =========================================================================
CREATE TABLE IF NOT EXISTS return_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID REFERENCES return_requests(id) ON DELETE CASCADE,
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,

  channel TEXT NOT NULL CHECK (channel IN ('seller_alarm', 'buyer_alarm', 'in_app', 'email')),
  template_key TEXT NOT NULL,     -- 'return_requested' / 'return_approved' / 'return_completed' / 'return_rejected'
  payload JSONB,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  sent_at TIMESTAMPTZ,
  error_message TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_return_notifications_pending
  ON return_notifications(status, created_at)
  WHERE status = 'pending';

ALTER TABLE return_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers read own notifications" ON return_notifications;
CREATE POLICY "Sellers read own notifications" ON return_notifications
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE return_notifications IS '반품 진행 알림 발송 큐 — 셀러 + 구매자 (실 발송은 send-notifications cron)';

-- =========================================================================
-- 마이그레이션 검증 쿼리
-- =========================================================================
-- SELECT count(*) FROM information_schema.tables WHERE table_schema='public'
--   AND table_name IN ('return_requests','return_history','return_status_transitions','return_logs','return_notifications');
-- → 5
