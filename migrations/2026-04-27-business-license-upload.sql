-- =========================================================================
-- Sprint 1: 사업자등록증 파일 업로드 + 백그라운드 검토
-- 적용: 2026-04-27 (사용자 결정 — 국세청 API + 사진 업로드 이중 검증)
-- 자동 검증 즉시 가입 + 사진 백그라운드 검수 (셀러 차단 X)
-- =========================================================================

-- sellers 테이블 컬럼 추가 (idempotent)
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS business_license_file_url TEXT;

ALTER TABLE sellers ADD COLUMN IF NOT EXISTS business_license_review_status TEXT DEFAULT 'pending';

-- 기존 데이터에 default 적용 후 CHECK 제약 추가
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sellers_business_license_review_status_check'
  ) THEN
    ALTER TABLE sellers
      ADD CONSTRAINT sellers_business_license_review_status_check
      CHECK (business_license_review_status IN ('pending', 'approved', 'rejected', 'expired'));
  END IF;
END$$;

ALTER TABLE sellers ADD COLUMN IF NOT EXISTS business_license_uploaded_at TIMESTAMPTZ;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS business_license_review_note TEXT;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS business_license_reviewed_at TIMESTAMPTZ;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS business_license_reviewed_by UUID;

-- 검토 대기 row 빠르게 조회용 인덱스 (Phase 1.1 admin 페이지)
CREATE INDEX IF NOT EXISTS idx_sellers_license_review_pending
  ON sellers(business_license_uploaded_at DESC)
  WHERE business_license_review_status = 'pending'
    AND business_license_file_url IS NOT NULL;

COMMENT ON COLUMN sellers.business_license_file_url IS '사업자등록증 사진/PDF Storage URL (supabase://business-licenses/{seller_id}/...)';
COMMENT ON COLUMN sellers.business_license_review_status IS 'pending: 대기 / approved: 승인 / rejected: 거절 / expired: 만료';
COMMENT ON COLUMN sellers.business_license_uploaded_at IS '셀러가 업로드한 시각';
COMMENT ON COLUMN sellers.business_license_review_note IS '관리자 검토 메모 — 거절 사유, 자동 승인 등';
COMMENT ON COLUMN sellers.business_license_reviewed_at IS '관리자 검토 완료 시각';
COMMENT ON COLUMN sellers.business_license_reviewed_by IS '검토한 관리자 UUID (Phase 1.1 admin 테이블 연결)';

-- =========================================================================
-- Storage 버킷 (Supabase 콘솔에서 수동 생성 가능 — 권한 부족 시 콘솔 사용)
-- =========================================================================
-- Supabase Storage에 'business-licenses' 비공개 버킷이 필요합니다.
-- 콘솔 권장 절차 (가장 안전):
--   1) Supabase Dashboard → Storage → New Bucket
--   2) Name: business-licenses
--   3) Public bucket 체크 해제 (비공개)
--   4) File size limit: 10MB
--   5) Allowed MIME types: image/jpeg, image/png, image/heic, image/heif, image/webp, application/pdf
--
-- SQL로도 동일 작업 가능 (service_role 권한):
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'business-licenses',
  'business-licenses',
  FALSE,
  10485760,  -- 10MB
  ARRAY[
    'image/jpeg', 'image/jpg', 'image/png',
    'image/heic', 'image/heif', 'image/webp',
    'application/pdf'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  public = FALSE,
  file_size_limit = 10485760,
  allowed_mime_types = ARRAY[
    'image/jpeg', 'image/jpg', 'image/png',
    'image/heic', 'image/heif', 'image/webp',
    'application/pdf'
  ];

-- =========================================================================
-- Storage RLS 정책 — 셀러는 자기 폴더만 INSERT/SELECT, admin은 service_role 우회
-- 폴더 컨벤션: {seller_id}/{timestamp}-{hash}.{ext}
-- =========================================================================

-- 셀러는 자기 seller_id 폴더에만 업로드 (서비스 키로 우회 시 자동 통과)
DROP POLICY IF EXISTS "Sellers upload own license" ON storage.objects;
CREATE POLICY "Sellers upload own license" ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'business-licenses'
    AND (storage.foldername(name))[1] = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id')
  );

-- 셀러는 자기 파일만 조회
DROP POLICY IF EXISTS "Sellers read own license" ON storage.objects;
CREATE POLICY "Sellers read own license" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'business-licenses'
    AND (storage.foldername(name))[1] = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id')
  );

-- 셀러는 자기 파일 삭제 가능 (계정 삭제 시 동시 정리)
DROP POLICY IF EXISTS "Sellers delete own license" ON storage.objects;
CREATE POLICY "Sellers delete own license" ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'business-licenses'
    AND (storage.foldername(name))[1] = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id')
  );

-- =========================================================================
-- 검증
-- =========================================================================
-- 셀러 row 확인:
--   SELECT business_license_review_status, business_license_uploaded_at
--   FROM sellers WHERE id = '<seller_uuid>';
--
-- 검토 대기 큐 확인 (Phase 1.1 admin 페이지에서 사용):
--   SELECT id, owner_name, business_license_uploaded_at
--   FROM sellers
--   WHERE business_license_review_status = 'pending'
--     AND business_license_file_url IS NOT NULL
--   ORDER BY business_license_uploaded_at DESC;
