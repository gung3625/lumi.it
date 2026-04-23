-- 003-user-trend-feedback.sql
-- 트렌드 키워드 사용자 피드백 (👍/👎) 저장 테이블

CREATE TABLE IF NOT EXISTS public.user_trend_feedback (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      text NOT NULL,
  keyword      text NOT NULL,
  category     text NOT NULL,
  rating       smallint NOT NULL CHECK (rating IN (-1, 1)),  -- -1 dislike, 1 like
  rated_at     timestamptz DEFAULT now(),
  UNIQUE (user_id, keyword, category)  -- 한 사용자는 키워드당 1표
);

CREATE INDEX IF NOT EXISTS idx_utf_keyword ON public.user_trend_feedback (keyword, category);
CREATE INDEX IF NOT EXISTS idx_utf_user ON public.user_trend_feedback (user_id, rated_at DESC);

ALTER TABLE public.user_trend_feedback ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Users rate own feedback" ON public.user_trend_feedback
    FOR ALL USING (auth.uid()::text = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
