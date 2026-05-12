-- caption_history 에 validator 결과 컬럼 추가 — 2026-05-12
--
-- 캡션 v2 (PR #71/#72) 의 Validator (gpt-4o-mini 5축 채점) 결과를 누적 저장해
-- 임계값(tone_match≥4 등) 튜닝 데이터 확보 + 자동 재생성 빈도 관찰.
--
-- 컬럼:
--   validator_scores  jsonb     — {photo_match, tone_appropriate, tone_match, cliche_free, brand_safe, length_ok, overall, issues[]}
--   validator_pass    boolean   — pass 판정 (overall≥3 AND brand_safe==5 AND tone_appropriate≥3 AND tone_match≥4)
--   regenerated       boolean   — 재생성 발생 여부 (validator 실패 시 1회 재생성)
--
-- caption_type 에 'generated' 추가:
--   기존: 'posted' / 'selected' / 'saved' — 모두 게시·확정 단계
--   추가: 'generated' — 생성 직후 (게시 전), validator 결과와 함께 적재

BEGIN;

ALTER TABLE public.caption_history
  ADD COLUMN IF NOT EXISTS validator_scores jsonb,
  ADD COLUMN IF NOT EXISTS validator_pass   boolean,
  ADD COLUMN IF NOT EXISTS regenerated      boolean;

-- caption_type 의 CHECK constraint 갱신 — 'generated' 추가
ALTER TABLE public.caption_history
  DROP CONSTRAINT IF EXISTS caption_history_caption_type_check;

ALTER TABLE public.caption_history
  ADD CONSTRAINT caption_history_caption_type_check
  CHECK (caption_type IN ('posted', 'selected', 'saved', 'generated'));

-- 분석 쿼리용 인덱스 (caption_type + created_at) — admin stats 가 generated 만 필터
CREATE INDEX IF NOT EXISTS caption_history_type_created_idx
  ON public.caption_history (caption_type, created_at DESC);

COMMENT ON COLUMN public.caption_history.validator_scores IS
  '캡션 v2 Validator(gpt-4o-mini) 5축 채점 결과. {photo_match, tone_appropriate, tone_match, cliche_free, brand_safe, length_ok, overall, issues[]}';

COMMENT ON COLUMN public.caption_history.validator_pass IS
  'Validator pass 판정. overall≥3 AND brand_safe==5 AND tone_appropriate≥3 AND tone_match≥4';

COMMENT ON COLUMN public.caption_history.regenerated IS
  '재생성 발생 여부. validator 실패 시 1회 재생성됨.';

NOTIFY pgrst, 'reload schema';

COMMIT;
