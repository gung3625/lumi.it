-- =========================================================================
-- Sprint 5 상품 대량 수정 — product_change_log
-- 상품 마스터 필드 변경 이력 (option_change_log 패턴 동일)
-- =========================================================================

CREATE TABLE IF NOT EXISTS product_change_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  product_id UUID,
  field_name TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by TEXT,
  excel_filename TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_log_seller ON product_change_log(seller_id, created_at DESC);

ALTER TABLE product_change_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "product_log_seller_own" ON product_change_log;
CREATE POLICY "product_log_seller_own"
  ON product_change_log FOR SELECT
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb->>'seller_id'));

COMMENT ON TABLE product_change_log IS 'Sprint 5 상품 마스터 대량 수정 이력 — 엑셀 일괄 수정 추적';
