-- ============================================================
-- 베스트 시간 개인화 — 데이터 인프라
-- 2026-05-12 | PR #105 (시리즈 1/6)
--
-- 변경 내용:
--   1. seller_post_history       — 사장님 IG 게시 이력 통합
--                                  (가입 전 + Lumi 게시 + 게시별 insights)
--   2. follower_activity_snapshots — Meta online_followers 누적
--                                  (Tier 2 — 팔로워 활동 시간 매트릭스)
--
-- 의도:
--   현 베스트 시간 추천은 응답 1점(`bestTime`)만 개인화되고
--   사장님이 화면에서 보는 `weekday[]`/`weekend[]` 슬롯 3개는
--   업종 시드 fallback. 4-tier 가중 하이브리드로 교체하려면
--   ① 본인 게시 이력 (가입 전 포함) ② 팔로워 활동 누적 데이터가
--   필요. 이 마이그레이션은 둘을 담을 그릇만 만든다.
--   백필/cron/응답 변경은 후속 PR.
--
-- RLS: service_role 전용 (openai_quota 패턴 준수)
-- 멱등성: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
-- ============================================================

BEGIN;

-- ============================================================
-- Part 1. seller_post_history
--
-- 한 사장님이 IG 비즈니스 계정에 평생 올린 게시물 이력을 통합.
-- - source='pre-lumi'  : 가입 전 직접 IG 에 올린 것 (백필 함수가 채움)
-- - source='lumi'      : 루미가 게시한 것 (select-and-post-background 가 append)
-- insights (reach/impressions/saved/engagement) 는 후속 PR 의
-- 일별 cron 이 게시 시각 + 24~72h 사이에 채움 → Tier 1 가중치 근거.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.seller_post_history (
  user_id              UUID         NOT NULL,
  ig_media_id          TEXT         NOT NULL,
  posted_at            TIMESTAMPTZ  NOT NULL,
  media_type           TEXT,                                  -- IMAGE / VIDEO / CAROUSEL_ALBUM / REELS
  source               TEXT         NOT NULL,                 -- 'pre-lumi' | 'lumi'
  reach                INTEGER,
  impressions          INTEGER,
  saved                INTEGER,
  engagement           INTEGER,                                -- like + comment + save (insights cron 이 산출)
  insights_fetched_at  TIMESTAMPTZ,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT seller_post_history_pk     PRIMARY KEY (user_id, ig_media_id),
  CONSTRAINT seller_post_history_seller FOREIGN KEY (user_id) REFERENCES public.sellers(id) ON DELETE CASCADE,
  CONSTRAINT seller_post_history_source CHECK (source IN ('pre-lumi', 'lumi'))
);

COMMENT ON TABLE  public.seller_post_history     IS '사장님 IG 게시 이력 통합 (가입 전 + Lumi 게시). 베스트 시간 개인화 데이터 소스.';
COMMENT ON COLUMN public.seller_post_history.source              IS '''pre-lumi'' = 가입 전 본인이 직접 게시 (백필) / ''lumi'' = 루미 게시.';
COMMENT ON COLUMN public.seller_post_history.posted_at           IS 'IG 측 timestamp (UTC). 베스트 시간 계산 시 KST 변환 후 요일/시간 버킷.';
COMMENT ON COLUMN public.seller_post_history.engagement          IS 'like + comment + save. Tier 1 (performance-weighted) 의 가중치 근거.';
COMMENT ON COLUMN public.seller_post_history.insights_fetched_at IS 'insights cron 이 reach/impressions/saved 채운 시각. 72h 지나면 더 안 갱신.';

-- 베스트 시간 계산 — 최근 90일 데이터 조회용
CREATE INDEX IF NOT EXISTS seller_post_history_user_posted_idx
  ON public.seller_post_history (user_id, posted_at DESC);

-- insights 채울 후보 색출용 (insights_fetched_at IS NULL AND posted_at > now()-90d)
CREATE INDEX IF NOT EXISTS seller_post_history_insights_todo_idx
  ON public.seller_post_history (insights_fetched_at, posted_at DESC)
  WHERE insights_fetched_at IS NULL;

-- ============================================================
-- Part 2. follower_activity_snapshots
--
-- Meta online_followers 메트릭의 7일치 row 를 매일 cron 으로
-- 누적 저장. 28일 누적되면 요일×시간 매트릭스 산출 가능.
-- (현 코드는 7일치를 시간 축으로 합산해 peak 1점만 산출 — 정보 손실)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.follower_activity_snapshots (
  user_id         UUID         NOT NULL,
  snapshot_date   DATE         NOT NULL,                  -- KST 기준 일자
  hour            SMALLINT     NOT NULL,                  -- 0~23 (KST)
  day_of_week     SMALLINT     NOT NULL,                  -- 0=일 ~ 6=토 (snapshot_date 의 요일)
  follower_count  INTEGER      NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT follower_activity_snapshots_pk     PRIMARY KEY (user_id, snapshot_date, hour),
  CONSTRAINT follower_activity_snapshots_seller FOREIGN KEY (user_id) REFERENCES public.sellers(id) ON DELETE CASCADE,
  CONSTRAINT follower_activity_snapshots_hour   CHECK (hour BETWEEN 0 AND 23),
  CONSTRAINT follower_activity_snapshots_dow    CHECK (day_of_week BETWEEN 0 AND 6)
);

COMMENT ON TABLE  public.follower_activity_snapshots IS
  'Meta online_followers 메트릭의 시간×요일 누적. Tier 2 (팔로워 활동) 데이터 소스. 28일 누적 후 신뢰성 확보.';

COMMENT ON COLUMN public.follower_activity_snapshots.snapshot_date IS
  'KST 기준 일자. cron 이 매일 04:00 KST 에 어제 분 1행씩 insert.';

CREATE INDEX IF NOT EXISTS follower_activity_snapshots_user_date_idx
  ON public.follower_activity_snapshots (user_id, snapshot_date DESC);

-- ============================================================
-- Part 3. RLS — service_role 전용 (anon/authenticated GRANT 없음)
-- ============================================================

ALTER TABLE public.seller_post_history          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follower_activity_snapshots  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "seller_post_history_service_role_all"         ON public.seller_post_history;
DROP POLICY IF EXISTS "follower_activity_snapshots_service_role_all" ON public.follower_activity_snapshots;

CREATE POLICY "seller_post_history_service_role_all"
  ON public.seller_post_history
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "follower_activity_snapshots_service_role_all"
  ON public.follower_activity_snapshots
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- PostgREST 스키마 리로드
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ============================================================
-- DOWN (롤백) — 필요 시 수동 실행
-- ============================================================
-- DROP TABLE IF EXISTS public.follower_activity_snapshots;
-- DROP TABLE IF EXISTS public.seller_post_history;
