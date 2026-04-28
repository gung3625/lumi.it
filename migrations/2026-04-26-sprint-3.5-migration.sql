-- Sprint 3.5 — 마이그레이션 마법사 V1
-- migration_history: 셀러별 마이그레이션 시도 추적 (선택적 — audit_logs로도 충분하지만 별도 조회 편의)
--
-- 사용처:
--   /api/migration-upload → INSERT (status='analyzed')
--   /api/migration-execute → UPDATE (status='completed', inserted_count, failed_count)

CREATE TABLE IF NOT EXISTS migration_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id    TEXT NOT NULL UNIQUE,                 -- mig_xxxx (lumi-excel-processor에서 발급)
  seller_id       UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  solution        TEXT NOT NULL,                        -- sabangnet|shoplinker|ezadmin|plto|unknown
  solution_confidence NUMERIC(3,2),                     -- 0.00~1.00
  filename        TEXT,
  file_size_bytes BIGINT,
  total_rows      INTEGER NOT NULL DEFAULT 0,
  valid_rows      INTEGER NOT NULL DEFAULT 0,
  invalid_rows    INTEGER NOT NULL DEFAULT 0,
  policy_violations INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'analyzed',     -- analyzed|reviewing|executing|completed|failed
  inserted_count  INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  header_mapping  JSONB,                                -- 셀러 검수 후 최종 매핑
  error_message   TEXT,
  metadata        JSONB DEFAULT '{}'::jsonb,            -- AI 비용·처리 시간·옵션 모드 등
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_migration_history_seller_id ON migration_history(seller_id);
CREATE INDEX IF NOT EXISTS idx_migration_history_status ON migration_history(status);
CREATE INDEX IF NOT EXISTS idx_migration_history_created_at ON migration_history(created_at DESC);

-- products 테이블에 source/migration_id 컬럼 추가 (이미 있으면 스킵)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='source') THEN
    ALTER TABLE products ADD COLUMN source TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='migration_id') THEN
    ALTER TABLE products ADD COLUMN migration_id TEXT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_products_migration_id ON products(migration_id) WHERE migration_id IS NOT NULL;

-- RLS: 셀러는 자기 마이그레이션만 조회
ALTER TABLE migration_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers see own migrations" ON migration_history;
CREATE POLICY "Sellers see own migrations" ON migration_history
  FOR SELECT USING (auth.uid()::text = seller_id::text);

DROP POLICY IF EXISTS "Service role full access" ON migration_history;
CREATE POLICY "Service role full access" ON migration_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 함수: updated_at 자동 갱신
CREATE OR REPLACE FUNCTION update_migration_history_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS migration_history_updated_at ON migration_history;
CREATE TRIGGER migration_history_updated_at
  BEFORE UPDATE ON migration_history
  FOR EACH ROW EXECUTE FUNCTION update_migration_history_updated_at();

COMMENT ON TABLE migration_history IS 'Sprint 3.5 — 셀러 마이그레이션 시도 이력. /api/migration-upload·-execute에서 갱신.';
