-- =========================================================================
-- 정산·세무 연동: 월별 정산 집계 + 부가세 신고 + 세무사 CSV
--   settlement_summary + settlement_transactions + vat_records
-- 적용 방법: Supabase SQL Editor에서 직접 실행
-- 멱등(idempotent)하게 작성 — 중복 실행 안전
--
-- 메모리 근거:
--   - _shared/profit-calculator.js (이미 수익 계산 모듈 존재 — 6항목 차감)
--   - project_lumi_business_info.md (사업자 정보)
--   - project_phase1_strategic_differentiation.md 11단계 (Profit Analytics)
--
-- 한국 세법 준수:
--   - 부가세 10% (VAT) 매출세액·매입세액 분리
--   - 분기별 신고 (1·4·7·10월)
--   - 홈택스 부가가치세 일반과세 양식 호환
-- =========================================================================

-- =========================================================================
-- 1. settlement_summary — 월별 정산 집계 (캐시 + 마감용)
-- =========================================================================
CREATE TABLE IF NOT EXISTS settlement_summary (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  period TEXT NOT NULL,                   -- 'YYYY-MM' (예: '2026-04')

  -- 집계 결과 (₩ 정수)
  gross_revenue BIGINT NOT NULL DEFAULT 0,           -- 총 매출
  marketplace_fees BIGINT NOT NULL DEFAULT 0,        -- 마켓 수수료 합계
  ad_fees BIGINT NOT NULL DEFAULT 0,                 -- 광고비
  packaging_fees BIGINT NOT NULL DEFAULT 0,          -- 포장재 비용
  shipping_fees BIGINT NOT NULL DEFAULT 0,           -- 송장 비용
  payment_fees BIGINT NOT NULL DEFAULT 0,            -- 결제 수수료
  vat_payable BIGINT NOT NULL DEFAULT 0,             -- 매출세액 (사업자가 낼 부가세)
  vat_refundable BIGINT NOT NULL DEFAULT 0,          -- 매입세액 (환급)
  net_profit BIGINT NOT NULL DEFAULT 0,              -- 통장 남는 돈

  -- 마켓별 세부
  by_marketplace JSONB DEFAULT '{}'::jsonb,          -- { coupang: {...}, naver: {...}, toss: {...} }
  order_count INTEGER NOT NULL DEFAULT 0,
  units_sold INTEGER NOT NULL DEFAULT 0,

  -- 상태 (open=재계산 가능, closed=마감)
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (seller_id, period)
);

CREATE INDEX IF NOT EXISTS idx_settlement_summary_seller_period ON settlement_summary(seller_id, period DESC);

CREATE OR REPLACE FUNCTION update_settlement_summary_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS settlement_summary_updated_at_trigger ON settlement_summary;
CREATE TRIGGER settlement_summary_updated_at_trigger
  BEFORE UPDATE ON settlement_summary
  FOR EACH ROW EXECUTE FUNCTION update_settlement_summary_updated_at();

ALTER TABLE settlement_summary ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers read own settlement summary" ON settlement_summary;
CREATE POLICY "Sellers read own settlement summary" ON settlement_summary
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE settlement_summary IS '월별 정산 집계 — 매출·수수료·VAT·순이익 (한국 세법: 부가세 10%)';

-- =========================================================================
-- 2. settlement_transactions — 거래 단위 정산 라인 (세무사 CSV용)
-- =========================================================================
CREATE TABLE IF NOT EXISTS settlement_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  period TEXT NOT NULL,                   -- 'YYYY-MM'

  -- 원거래 (marketplace_orders 1:1 또는 ad/packaging 등 계산식)
  source_type TEXT NOT NULL CHECK (source_type IN ('order', 'ad_spend', 'packaging', 'shipping', 'misc')),
  source_id UUID,                         -- marketplace_orders.id 등
  occurred_at TIMESTAMPTZ NOT NULL,

  market TEXT,                             -- 'coupang' | 'naver' | 'toss' | NULL (광고·포장 등)
  market_order_id TEXT,
  product_title TEXT,

  -- 금액 (₩ 정수)
  gross_amount BIGINT NOT NULL DEFAULT 0,
  fee_amount BIGINT NOT NULL DEFAULT 0,
  vat_amount BIGINT NOT NULL DEFAULT 0,
  net_amount BIGINT NOT NULL DEFAULT 0,

  -- 거래 분류 (홈택스 부가세 신고 분류)
  -- sales=매출, purchase=매입, expense=경비
  tax_category TEXT NOT NULL DEFAULT 'sales' CHECK (tax_category IN ('sales', 'purchase', 'expense')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settlement_tx_seller_period ON settlement_transactions(seller_id, period, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_settlement_tx_source ON settlement_transactions(source_type, source_id);

ALTER TABLE settlement_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers read own settlement tx" ON settlement_transactions;
CREATE POLICY "Sellers read own settlement tx" ON settlement_transactions
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE settlement_transactions IS '거래 단위 정산 라인 — 세무사 CSV·부가세 신고 명세용';

-- =========================================================================
-- 3. vat_records — 부가가치세 분기별 신고 기록 (홈택스)
-- =========================================================================
CREATE TABLE IF NOT EXISTS vat_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,

  -- 분기 (2026Q1 = 2026-01~03, 2026Q2 = 2026-04~06)
  quarter TEXT NOT NULL,                  -- 'YYYY-Q[1-4]' (예: '2026-Q2')

  -- 신고 자료 (₩ 정수)
  total_sales BIGINT NOT NULL DEFAULT 0,           -- 매출 (공급가액 + VAT)
  sales_supply BIGINT NOT NULL DEFAULT 0,          -- 공급가액 (VAT 제외)
  sales_vat BIGINT NOT NULL DEFAULT 0,             -- 매출세액 (10%)
  total_purchase BIGINT NOT NULL DEFAULT 0,        -- 매입 합계
  purchase_supply BIGINT NOT NULL DEFAULT 0,       -- 매입 공급가액
  purchase_vat BIGINT NOT NULL DEFAULT 0,          -- 매입세액 (환급)
  vat_due BIGINT NOT NULL DEFAULT 0,               -- 납부세액 = sales_vat - purchase_vat

  -- 신고 상태
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'filed', 'paid')),
  filed_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  hometax_receipt_no TEXT,                -- 홈택스 신고 접수번호

  -- 기간
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (seller_id, quarter)
);

CREATE INDEX IF NOT EXISTS idx_vat_records_seller_quarter ON vat_records(seller_id, quarter DESC);

DROP TRIGGER IF EXISTS vat_records_updated_at_trigger ON vat_records;
CREATE TRIGGER vat_records_updated_at_trigger
  BEFORE UPDATE ON vat_records
  FOR EACH ROW EXECUTE FUNCTION update_settlement_summary_updated_at();

ALTER TABLE vat_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers manage own vat records" ON vat_records;
CREATE POLICY "Sellers manage own vat records" ON vat_records
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE vat_records IS '분기별 부가가치세 신고 기록 — 홈택스 일반과세 양식 호환';
