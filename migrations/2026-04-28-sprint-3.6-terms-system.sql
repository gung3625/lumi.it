-- =========================================================================
-- Sprint 3.6: 약관 시스템 + 30일 해지 유예 + OpenAI 동의
-- 적용 방법: Supabase SQL Editor 직접 실행 또는 admin-apply-migration 함수
-- 메모리: project_phase1_decisions_0426 (해지·보관 정책)
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1) sellers 보강 — 해지 유예 + 약관 동의 + OpenAI 국외이전 동의
-- -------------------------------------------------------------------------
ALTER TABLE sellers
  ADD COLUMN IF NOT EXISTS refund_consent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS openai_consent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS openai_consent_revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_grace_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_restored_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_warned_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sellers_cancellation_grace
  ON sellers(cancellation_grace_until)
  WHERE cancellation_grace_until IS NOT NULL AND cancellation_completed_at IS NULL;

COMMENT ON COLUMN sellers.refund_consent_at IS '환불약관 동의 시점';
COMMENT ON COLUMN sellers.openai_consent_at IS 'OpenAI 국외이전 동의 시점 (선택). NULL이면 AI 보조 기능 일부 제한';
COMMENT ON COLUMN sellers.openai_consent_revoked_at IS 'OpenAI 동의 철회 시점';
COMMENT ON COLUMN sellers.cancellation_requested_at IS '해지 신청일 — 30일 유예 시작';
COMMENT ON COLUMN sellers.cancellation_grace_until IS '유예 만료일 (cancellation_requested_at + 30일)';
COMMENT ON COLUMN sellers.cancellation_completed_at IS '실제 해지 완료일 (자동 파기 실행 시점)';
COMMENT ON COLUMN sellers.cancellation_restored_at IS '유예 중 복원 시점';
COMMENT ON COLUMN sellers.cancellation_reason IS '해지 사유 (사장님 자유 입력)';
COMMENT ON COLUMN sellers.cancellation_warned_at IS '만료 1주일 전 알림톡 발송 시점';


-- -------------------------------------------------------------------------
-- 2) audit_logs 보강 — Sprint 1에서 이미 생성됐으나 Sprint 3.6 컬럼 추가
-- -------------------------------------------------------------------------
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS integrity_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_logs_resource
  ON audit_logs(resource_type, resource_id, created_at DESC);

COMMENT ON COLUMN audit_logs.integrity_hash IS 'sha256(prev_hash + row_payload) — append-only 무결성 체인';


-- -------------------------------------------------------------------------
-- 3) audit_logs RLS — 셀러 본인 행위만 SELECT 가능
-- -------------------------------------------------------------------------
DROP POLICY IF EXISTS "Sellers read own audit logs" ON audit_logs;
CREATE POLICY "Sellers read own audit logs" ON audit_logs
  FOR SELECT
  USING (
    actor_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id')
    OR (resource_type = 'seller' AND resource_id = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'))
  );


-- -------------------------------------------------------------------------
-- 4) 동의 이력 테이블 (감사·법무 대응) — append-only
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seller_consents (
  id BIGSERIAL PRIMARY KEY,
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  consent_type TEXT NOT NULL CHECK (consent_type IN (
    'terms', 'privacy', 'refund', 'openai_intl_transfer', 'marketing'
  )),
  consent_version TEXT NOT NULL DEFAULT 'v1',
  granted BOOLEAN NOT NULL,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_seller_consents_seller
  ON seller_consents(seller_id, consent_type, created_at DESC);

ALTER TABLE seller_consents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers read own consents" ON seller_consents;
CREATE POLICY "Sellers read own consents" ON seller_consents
  FOR SELECT
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE seller_consents IS '약관 동의 이력 — append-only (수정/삭제 금지)';
COMMENT ON COLUMN seller_consents.consent_type IS 'terms/privacy/refund/openai_intl_transfer/marketing';
COMMENT ON COLUMN seller_consents.granted IS 'true=동의, false=철회';


-- -------------------------------------------------------------------------
-- 5) 마스킹 해제 이력 (개인정보보호법 §29 — 접근 통제)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pii_unmask_events (
  id BIGSERIAL PRIMARY KEY,
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL,            -- 'order' / 'cs_thread' / 'customer'
  resource_id TEXT NOT NULL,
  field TEXT NOT NULL,                    -- 'name' / 'phone' / 'address' / 'all'
  reason TEXT,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pii_unmask_seller
  ON pii_unmask_events(seller_id, created_at DESC);

ALTER TABLE pii_unmask_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers read own unmask events" ON pii_unmask_events;
CREATE POLICY "Sellers read own unmask events" ON pii_unmask_events
  FOR SELECT
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE pii_unmask_events IS '셀러가 마스킹 해제(전체 보기)를 누른 이력 — append-only';
