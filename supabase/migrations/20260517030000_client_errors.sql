-- client_errors 테이블 — production 에러 모니터링 (audit 후속)
-- 사장님 결정 2026-05-17: 사장님 device 의 JS 에러 / unhandled rejection 자동 수집.
-- 기존: 사장님이 신고해야만 알 수 있음. 새: 자동 POST + 사장님 dashboard 에서 최근 에러 조회 (후속).
--
-- 저장:
-- - message, stack (truncated 4KB), url, line, col, user_agent
-- - seller_id 있으면 binding, 없으면 anon
-- - created_at
--
-- 보안:
-- - service role 만 write (anon spam 방어)
-- - sellerId 는 jwt 검증 시 자동 채움 (위조 차단)

BEGIN;

CREATE TABLE IF NOT EXISTS public.client_errors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id    uuid REFERENCES public.sellers(id) ON DELETE SET NULL,
  message      text NOT NULL,
  stack        text,
  url          text,
  line         integer,
  col          integer,
  user_agent   text,
  ip_address   inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_errors_created_at  ON public.client_errors(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_errors_seller_id   ON public.client_errors(seller_id) WHERE seller_id IS NOT NULL;

COMMENT ON TABLE public.client_errors IS
  '사장님 device 의 JS 에러 / unhandled rejection 자동 수집. /api/error-log endpoint 가 insert.';

ALTER TABLE public.client_errors ENABLE ROW LEVEL SECURITY;
-- (정책 없음 — service role 만 접근)

COMMIT;
