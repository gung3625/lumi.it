-- =========================================================================
-- Sprint 1.1: 사업자등록증 OCR 대조 (GPT-4o Vision)
-- 적용: 2026-04-28
-- 정책:
--   - 업로드 시점에 GPT-4o Vision으로 OCR 추출
--   - 셀러 입력값(사업자번호·대표자명) 자동 대조
--   - confidence ≥ 90% 일치 시 즉시 'approved'
--   - 미만 또는 불일치 시 'pending' (사람 검토)
--   - 추출 결과는 감사 + 사람 검토용으로 보관 (PII 포함 — RLS 강제)
-- =========================================================================

-- OCR 추출 결과 (JSONB) — 감사용 보관, 셀러에게 직접 노출 X
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS business_license_ocr_extracted JSONB;

-- AI 신뢰도 (0~100). 임계치 미만 시 사람 검토 큐로 들어감.
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS business_license_ocr_confidence SMALLINT;

-- 자동 대조 결과 — true: 일치 / false: 불일치 / NULL: 미수행 (모킹 또는 OCR 실패)
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS business_license_ocr_match BOOLEAN;

-- 인덱스: confidence 낮은 row를 사람 검토 큐로 빠르게 조회 (admin 페이지)
CREATE INDEX IF NOT EXISTS idx_sellers_ocr_review_pending
  ON sellers(business_license_uploaded_at DESC)
  WHERE business_license_review_status = 'pending'
    AND business_license_ocr_match IS NOT NULL
    AND business_license_ocr_match = FALSE;

COMMENT ON COLUMN sellers.business_license_ocr_extracted IS 'GPT-4o Vision OCR 추출 결과 (사업자번호·상호·대표자명·주소·개업일·업종). PII 포함 — service_role만 SELECT.';
COMMENT ON COLUMN sellers.business_license_ocr_confidence IS 'GPT-4o Vision OCR confidence 점수 (0~100). 90 이상 + 일치 = 자동 승인.';
COMMENT ON COLUMN sellers.business_license_ocr_match IS '셀러 입력값 vs OCR 결과 자동 대조 — true: 일치, false: 불일치, NULL: 미수행.';

-- =========================================================================
-- 검증
-- =========================================================================
-- 자동 승인된 row 확인:
--   SELECT id, business_license_review_status, business_license_ocr_confidence,
--          business_license_ocr_match
--   FROM sellers
--   WHERE business_license_review_status = 'approved'
--     AND business_license_ocr_match = TRUE;
--
-- 사람 검토 큐 (불일치 또는 confidence 낮음):
--   SELECT id, owner_name, business_license_uploaded_at,
--          business_license_ocr_confidence, business_license_ocr_match
--   FROM sellers
--   WHERE business_license_review_status = 'pending'
--     AND business_license_file_url IS NOT NULL
--   ORDER BY business_license_uploaded_at DESC;
