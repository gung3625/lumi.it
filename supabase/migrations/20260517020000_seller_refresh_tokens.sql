-- seller refresh token 저장 — audit #2 (HANDOFF D 추천)
-- 사장님 결정 2026-05-17: 14일 access JWT 만료 시 사장님 매번 재로그인 불편.
-- refresh token 도입 → access 만료 시 자동 갱신.
--
-- 보안:
-- - refresh token = 32바이트 random hex (sha256 hash 저장)
-- - 평문은 클라이언트에만 전달 (DB 에는 hash)
-- - rotation: 사용 시마다 새 토큰 발급 + 옛 토큰 무효화 (revoked_at set)
-- - TTL: 30일 (access 14일보다 길게 — 사장님 1달 이내 사용 시 재로그인 없음)
-- - 한 사장님 다중 device 지원 (배열 row, device_label 옵션)

BEGIN;

CREATE TABLE IF NOT EXISTS public.seller_refresh_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id       uuid NOT NULL REFERENCES public.sellers(id) ON DELETE CASCADE,
  token_hash      text NOT NULL UNIQUE,                  -- sha256(refresh_token) — 평문 저장 X
  device_label    text,                                  -- "Chrome on Mac" 등 (선택)
  user_agent      text,
  ip_address      inet,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  last_used_at    timestamptz,                           -- rotation 추적
  revoked_at      timestamptz,                           -- 명시적 무효화 시 (로그아웃·rotation)
  replaced_by_id  uuid REFERENCES public.seller_refresh_tokens(id)  -- rotation chain (forensic 추적용)
);

CREATE INDEX IF NOT EXISTS idx_seller_refresh_tokens_seller_id   ON public.seller_refresh_tokens(seller_id);
CREATE INDEX IF NOT EXISTS idx_seller_refresh_tokens_token_hash  ON public.seller_refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_seller_refresh_tokens_expires_at  ON public.seller_refresh_tokens(expires_at) WHERE revoked_at IS NULL;

COMMENT ON TABLE public.seller_refresh_tokens IS
  'seller JWT (HS256, 14일) refresh token 저장. token_hash = sha256(refresh_token). rotation: 사용 시마다 새 row + 옛 revoked. (audit #2)';

-- RLS: 서비스 role 만 접근 (cron + auth-refresh endpoint)
ALTER TABLE public.seller_refresh_tokens ENABLE ROW LEVEL SECURITY;

-- (정책 없음 = service role 만 접근. anon/authenticated 차단)

COMMIT;
