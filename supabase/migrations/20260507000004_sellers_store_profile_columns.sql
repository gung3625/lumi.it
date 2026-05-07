-- sellers 테이블에 매장 소개 + 말투 샘플 컬럼 추가
-- settings.html의 매장 소개·말투 샘플 입력란을 sellers에 직접 저장하기 위함
-- (별도 테이블 분리 대신 단순화 — 1:1 관계 + 길이 제한 작음)

ALTER TABLE public.sellers
  ADD COLUMN IF NOT EXISTS store_desc text,
  ADD COLUMN IF NOT EXISTS tone_sample_1 text,
  ADD COLUMN IF NOT EXISTS tone_sample_2 text,
  ADD COLUMN IF NOT EXISTS tone_sample_3 text;
