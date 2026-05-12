-- ============================================================
-- channel_posts — 멀티 채널 게시 상태 정규화 테이블
-- 2026-05-12 | Threads M1.1 (HANDOFF §12-A 결정사항 #6)
--
-- 변경 내용:
--   1. channel_posts 테이블 신설 — reservations 1:N 관계로
--      채널(IG / Threads / 향후 TikTok·YouTube)별 게시 상태·
--      post_id·credit 차감 여부를 분리 저장.
--
-- 의도:
--   현재 reservations row 에 ig_post_id 단일 컬럼만 존재. Threads
--   추가 시 threads_post_id / threads_status / threads_error… 식으로
--   확장하면 채널이 늘 때마다 row 가 부풀고 join 도 어렵다. 정규화로
--   1 reservation × N 채널 패턴 정착.
--
--   결정사항 §12-A #7 (성공 채널만 차감) 구현은 channel_posts.
--   credit_consumed 컬럼이 단일 source of truth. status='posted' 인
--   row 만 credit_consumed=true 로 마킹 → 향후 결제 시스템에서
--   SUM(credit_consumed) 으로 사장님 사용량 집계.
--
-- 이 마이그레이션 범위 (M1.1):
--   - 테이블 + PK + FK + CHECK + 인덱스 + RLS 만 생성
--   - 기존 IG 게시 이력 backfill 안 함 (M2 에서 post-channels 파이프
--     라인 도입 후 새 게시만 channel_posts 사용)
--
-- RLS: service_role 전용 (seller_post_history 패턴 준수)
-- 멱등성: CREATE TABLE IF NOT EXISTS / DROP POLICY IF EXISTS
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.channel_posts (
  reservation_id    BIGINT       NOT NULL,
  channel           TEXT         NOT NULL,                  -- 'ig' | 'threads' (향후 'tiktok' / 'youtube')
  status            TEXT         NOT NULL DEFAULT 'pending', -- pending | posting | posted | failed
  post_id           TEXT,                                    -- 채널 측 게시 ID (IG media_id / Threads thread_id)
  posted_at         TIMESTAMPTZ,
  error_message     TEXT,
  credit_consumed   BOOLEAN      NOT NULL DEFAULT false,     -- 결정사항 §12-A #7 — status='posted' 시점에 true
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT channel_posts_pk           PRIMARY KEY (reservation_id, channel),
  CONSTRAINT channel_posts_reservation  FOREIGN KEY (reservation_id) REFERENCES public.reservations(id) ON DELETE CASCADE,
  CONSTRAINT channel_posts_channel_chk  CHECK (channel IN ('ig', 'threads')),
  CONSTRAINT channel_posts_status_chk   CHECK (status  IN ('pending', 'posting', 'posted', 'failed'))
);

COMMENT ON TABLE  public.channel_posts                  IS '멀티 채널 게시 상태 정규화. 1 reservation × N 채널.';
COMMENT ON COLUMN public.channel_posts.channel          IS '''ig'' | ''threads''. 향후 TikTok/YouTube 추가 시 CHECK 제약 확장.';
COMMENT ON COLUMN public.channel_posts.status           IS 'pending → posting → posted | failed. atomic CAS 로 race 차단.';
COMMENT ON COLUMN public.channel_posts.post_id          IS '채널 플랫폼 측 게시 ID (IG media_id / Threads thread_id). 댓글·인사이트 조회 시 사용.';
COMMENT ON COLUMN public.channel_posts.credit_consumed  IS '사장님 횟수 차감 여부. status=''posted'' 시점에 true 로 마킹. 결제 시스템 SUM 의 source of truth.';

-- cron 폴링용 (status='pending' 채널별 픽업)
CREATE INDEX IF NOT EXISTS channel_posts_channel_status_idx
  ON public.channel_posts (channel, status)
  WHERE status IN ('pending', 'posting');

-- 사장님 횟수 집계용 (reservation FK 로 user_id 조회 후 SUM)
CREATE INDEX IF NOT EXISTS channel_posts_credit_consumed_idx
  ON public.channel_posts (credit_consumed, created_at DESC)
  WHERE credit_consumed = true;

-- updated_at 자동 갱신 트리거
CREATE OR REPLACE FUNCTION public.channel_posts_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS channel_posts_updated_at ON public.channel_posts;
CREATE TRIGGER channel_posts_updated_at
  BEFORE UPDATE ON public.channel_posts
  FOR EACH ROW
  EXECUTE FUNCTION public.channel_posts_set_updated_at();

-- ============================================================
-- RLS — service_role 전용
-- ============================================================

ALTER TABLE public.channel_posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "channel_posts_service_role_all" ON public.channel_posts;

CREATE POLICY "channel_posts_service_role_all"
  ON public.channel_posts
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- PostgREST 스키마 리로드
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================
-- DOWN (롤백) — 필요 시 수동 실행
-- ============================================================
-- DROP TRIGGER  IF EXISTS channel_posts_updated_at ON public.channel_posts;
-- DROP FUNCTION IF EXISTS public.channel_posts_set_updated_at();
-- DROP TABLE    IF EXISTS public.channel_posts;
