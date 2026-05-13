-- ============================================================
-- data_deletion_requests — Meta 데이터 삭제 콜백 추적 테이블
-- 2026-05-13 | Meta App Review 대비
--
-- 변경 내용:
--   1. data_deletion_requests 테이블 신설
--
-- 의도:
--   Meta 가 사장님이 facebook.com / threads.net 에서 우리 앱 권한 회수 시
--   POST /api/data-deletion-callback 호출. 본 테이블이:
--     · confirmation_code (Meta 에 반환) → user 가 status URL 로 조회
--     · 매칭된 seller_id + 처리 status (pending/completed/not_found/failed)
--     · 감사 추적 (created_at, completed_at, error_message)
--   를 보관해 Meta 측 검증 + 우리 운영 측 분쟁 시 증빙 자료.
--
--   삭제 자체는 즉시 처리 (Meta 권장) — ig_accounts row delete + Vault
--   secret 폐기 + Threads token 폐기. sellers 계정은 보존 (사용자가
--   Meta 권한만 회수한 것, lumi 자체 탈퇴 X).
--
-- 보안: service_role 전용 (anon/authenticated GRANT 0).
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.data_deletion_requests (
  id                  BIGSERIAL    PRIMARY KEY,
  confirmation_code   TEXT         NOT NULL UNIQUE,
  meta_user_id        TEXT,                                  -- signed_request.data.user_id
  channel             TEXT,                                  -- 'ig' | 'threads' | 'unknown' (매칭된 컬럼 기준)
  seller_id           UUID,                                  -- 매칭된 sellers.id (못 찾으면 NULL)
  status              TEXT         NOT NULL DEFAULT 'pending',
  error_message       TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ,
  CONSTRAINT data_deletion_requests_status_chk CHECK (status IN ('pending', 'completed', 'not_found', 'failed'))
);

COMMENT ON TABLE  public.data_deletion_requests                   IS 'Meta 데이터 삭제 콜백 추적. 사장님이 Meta 측 권한 회수 시 1 row.';
COMMENT ON COLUMN public.data_deletion_requests.confirmation_code IS 'Meta 에 반환되는 처리 식별자. status URL 의 ?code= 쿼리.';
COMMENT ON COLUMN public.data_deletion_requests.meta_user_id      IS 'Meta signed_request.data.user_id (Facebook/Threads 측 식별자).';
COMMENT ON COLUMN public.data_deletion_requests.channel           IS '매칭 성공 시 어느 컬럼으로 매칭됐는지 — ''ig'' (ig_user_id) / ''threads'' (threads_user_id) / ''unknown''.';
COMMENT ON COLUMN public.data_deletion_requests.seller_id         IS '매칭된 sellers.id. 매칭 실패 시 NULL — 사장님이 직접 lumi@lumi.it.kr 로 문의 유도.';

-- 조회 인덱스 (status URL 의 ?code= 조회)
CREATE INDEX IF NOT EXISTS data_deletion_requests_code_idx
  ON public.data_deletion_requests (confirmation_code);

-- RLS: service_role 전용
ALTER TABLE public.data_deletion_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "data_deletion_requests_service_role_all" ON public.data_deletion_requests;

CREATE POLICY "data_deletion_requests_service_role_all"
  ON public.data_deletion_requests
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================
-- DOWN (롤백) — 필요 시 수동 실행
-- ============================================================
-- DROP TABLE IF EXISTS public.data_deletion_requests;
