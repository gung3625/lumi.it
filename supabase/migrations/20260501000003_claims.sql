-- 클레임 처리 분리 — Sprint 5
-- 취소 / 반품 / 교환 / 일반 문의 4개 타입 관리

CREATE TABLE IF NOT EXISTS marketplace_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  marketplace_order_id UUID REFERENCES marketplace_orders(id),
  market TEXT NOT NULL CHECK (market IN ('coupang', 'naver', 'toss')),
  market_claim_id TEXT NOT NULL,
  claim_type TEXT NOT NULL CHECK (claim_type IN ('cancel', 'return', 'exchange', 'inquiry')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'approved', 'rejected', 'completed')),
  reason TEXT,
  buyer_message TEXT,
  seller_response TEXT,
  refund_amount NUMERIC,
  return_tracking_number TEXT,
  exchange_tracking_number TEXT,
  collected_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (market, market_claim_id)
);

CREATE INDEX IF NOT EXISTS idx_claims_seller_status ON marketplace_claims(seller_id, status);
CREATE INDEX IF NOT EXISTS idx_claims_seller_type ON marketplace_claims(seller_id, claim_type);

ALTER TABLE marketplace_claims ENABLE ROW LEVEL SECURITY;

-- 셀러 본인 데이터만 접근 (JWT claim 기반)
CREATE POLICY "claims_seller_own"
  ON marketplace_claims FOR ALL
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb->>'seller_id'));

-- anon role에는 권한 없음 (RLS만으로 제어, GRANT 없음)
