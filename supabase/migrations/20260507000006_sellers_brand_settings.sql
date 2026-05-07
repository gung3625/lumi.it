-- sellers 테이블에 brand 설정(jsonb) + 갱신 시각 컬럼 추가.
-- /api/brand-settings 가 brand-admin.html 폼(tone/tone_custom/samples/ban_words/must_words/hashtags)
-- 을 영속화하기 위함. 셀러별 1행, jsonb로 단순화.

ALTER TABLE public.sellers
  ADD COLUMN IF NOT EXISTS brand_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS brand_settings_updated_at timestamptz;

COMMENT ON COLUMN public.sellers.brand_settings IS 'brand-admin 페이지 설정(JSON: tone, tone_custom, samples, ban_words, must_words, hashtags). whitelist 키만 저장.';
COMMENT ON COLUMN public.sellers.brand_settings_updated_at IS '마지막 brand_settings 저장 시각';
