-- beta_signups — 루미 베타 사용자 모집 (정식 오픈 전).
-- 사장님 결정 2026-05-17: 현재 lumi 는 정식 오픈 안 함. 베타 사용자 모집 페이지 /beta 에서 폼.
-- 모집 종료 후 카카오톡 / 휴대폰 으로 사장님이 직접 연락.

BEGIN;

CREATE TABLE IF NOT EXISTS public.beta_signups (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_name        text NOT NULL,
  owner_name        text NOT NULL,
  category          text NOT NULL,           -- categories.js 의 대분류 (예: food/cafe, beauty/nail 등)
  phone             text NOT NULL,           -- 010-xxxx-xxxx 형식 (인증 X, 단순 텍스트)
  instagram_handle  text,                    -- 옵션 (@ 없이 username)
  terms_agreed_at   timestamptz NOT NULL,
  user_agent        text,
  ip_address        inet,
  created_at        timestamptz NOT NULL DEFAULT now(),
  contacted_at      timestamptz,             -- 사장님이 연락한 시점
  status            text NOT NULL DEFAULT 'pending'  -- pending / contacted / accepted / rejected
);

-- 같은 휴대폰 1번만 (중복 신청 방지)
CREATE UNIQUE INDEX IF NOT EXISTS uq_beta_signups_phone ON public.beta_signups(phone);
CREATE INDEX        IF NOT EXISTS idx_beta_signups_status_created ON public.beta_signups(status, created_at DESC);

COMMENT ON TABLE public.beta_signups IS
  '루미 베타 모집 페이지 /beta 신청자. 정식 출시 후 사용자 → sellers 로 마이그레이션 또는 그대로 보관.';

ALTER TABLE public.beta_signups ENABLE ROW LEVEL SECURITY;
-- 정책 없음 — service role 만 (anon spam 차단)

COMMIT;
