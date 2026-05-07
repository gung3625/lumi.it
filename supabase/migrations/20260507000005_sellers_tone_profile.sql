-- sellers 테이블에 말투 프로파일 + 재학습 시각 컬럼 추가
-- /api/brand-retrain 이 학습 결과를 영속화하기 위함.
-- 별도 테이블 없이 1:1 컬럼으로 단순화 — 히스토리 필요 시 후속 마이그에서 분리.

ALTER TABLE public.sellers
  ADD COLUMN IF NOT EXISTS tone_profile jsonb,
  ADD COLUMN IF NOT EXISTS tone_retrained_at timestamptz;

COMMENT ON COLUMN public.sellers.tone_profile IS '말투 프로파일 (brand-retrain 결과 JSON: tone, avgLength, emojiUsage, preferredKeywords, notes 등)';
COMMENT ON COLUMN public.sellers.tone_retrained_at IS '마지막 말투 재학습 시각';
