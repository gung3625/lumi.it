-- Sprint 5 실패 통합 추적 테이블
-- 상품 등록/수정, 주문 수집, 송장 송신, 클레임 처리, 매핑 실패를 한 곳에서 추적

CREATE TABLE IF NOT EXISTS failure_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('product_register', 'product_update', 'order_collect', 'tracking_send', 'claim_process', 'mapping')),
  market TEXT,                             -- coupang/naver/toss
  target_type TEXT,                        -- product/order/claim
  target_id TEXT,                          -- 대상 객체 ID
  target_summary TEXT,                     -- "[상품명 X] 등록 실패"
  error_code TEXT,                         -- 마켓 응답 코드
  error_message TEXT,                      -- 마켓 응답 메시지 (한글 변환됨)
  raw_response JSONB,                      -- 원본 디버깅용
  retry_count INT DEFAULT 0,
  last_retry_at TIMESTAMPTZ,
  resolved BOOLEAN DEFAULT false,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_failures_seller_category ON failure_log(seller_id, category) WHERE resolved = false;
CREATE INDEX IF NOT EXISTS idx_failures_recent ON failure_log(seller_id, created_at DESC);

ALTER TABLE failure_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "failures_seller_own"
  ON failure_log FOR ALL
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb->>'seller_id'));
