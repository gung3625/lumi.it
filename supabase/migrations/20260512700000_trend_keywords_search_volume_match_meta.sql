-- trend_keywords 에 검색량 매칭 메타 컬럼 2개 추가.
--
-- 배경:
--   PR #173 의 monthly_search_total 만으론 사장님이 "이 검색량이 정확한지 / 추정인지"
--   판단 불가. multi-layer fallback (exact / normalized / root_morpheme / datalab_estimate)
--   결과를 명시 라벨링해서 UI 에 신뢰도 등급 노출.

ALTER TABLE public.trend_keywords
  ADD COLUMN IF NOT EXISTS search_volume_match_type TEXT,
  ADD COLUMN IF NOT EXISTS search_volume_root_keyword TEXT;

COMMENT ON COLUMN public.trend_keywords.search_volume_match_type IS
  'monthly_search_total 매칭 방식.
   exact: 키워드 정확 매칭 (신뢰 ✅✅✅)
   normalized: 공백/대소문자 무관 매칭 (신뢰 ✅✅✅)
   root_morpheme: 한국어 합성어 분해 → root 키워드 매칭 (신뢰 ✅✅, 근사값)
   datalab_estimate: DataLab ratio cross-reference 환산 (신뢰 ✅, 추정값)
   NULL: 매칭 실패 (검색량 미수집)';

COMMENT ON COLUMN public.trend_keywords.search_volume_root_keyword IS
  'root_morpheme 일 때 실제 매칭된 root 키워드. UI 라벨에 "(드라이플라워 기준)" 형태로 노출.
   datalab_estimate 일 때 anchor 키워드 정보.';
