-- =========================================================================
-- Sprint 5: 옵션 대량 편집 — option_change_log + product_options 컬럼 추가
-- 멱등(idempotent)하게 작성 — 중복 실행 안전
-- =========================================================================

-- ── product_options 테이블에 per-option 필드 추가 ──────────────────────────
-- 기존: option_name TEXT, option_values JSONB (["베이지","블랙"])
-- 추가: sku, price, stock, extra_price (옵션별 단가/재고/추가금액)
ALTER TABLE product_options
  ADD COLUMN IF NOT EXISTS sku          TEXT,
  ADD COLUMN IF NOT EXISTS price        INTEGER,        -- 판매가 (NULL = 상품 기본가 상속)
  ADD COLUMN IF NOT EXISTS stock        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extra_price  INTEGER NOT NULL DEFAULT 0,  -- 추가금액
  ADD COLUMN IF NOT EXISTS market_mapping JSONB DEFAULT '{}'::jsonb; -- 마켓별 옵션ID 매핑

COMMENT ON COLUMN product_options.sku          IS '옵션 SKU (셀러 관리 코드)';
COMMENT ON COLUMN product_options.price        IS '옵션 판매가 (NULL이면 products.price_suggested 상속)';
COMMENT ON COLUMN product_options.stock        IS '현재 재고 수량';
COMMENT ON COLUMN product_options.extra_price  IS '기본가 대비 추가 금액 (예: +2000원)';
COMMENT ON COLUMN product_options.market_mapping IS '마켓별 옵션 ID {coupang: "...", naver: "..."}';

-- ── option_change_log 테이블 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS option_change_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id    UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  option_id    UUID,
  product_id   UUID,
  field_name   TEXT NOT NULL,     -- 'price', 'stock', 'extra_price', 'sku' 등
  old_value    TEXT,
  new_value    TEXT,
  changed_by   TEXT,              -- 'bulk_import', 'inline_edit'
  excel_filename TEXT,            -- 일괄 수정 시 파일명
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_option_log_seller
  ON option_change_log(seller_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_option_log_option
  ON option_change_log(option_id);

ALTER TABLE option_change_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "option_log_seller_own" ON option_change_log;
CREATE POLICY "option_log_seller_own"
  ON option_change_log FOR SELECT
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE option_change_log IS 'Sprint 5: 옵션 변경 이력 (일괄 수정 + 인라인 편집)';
