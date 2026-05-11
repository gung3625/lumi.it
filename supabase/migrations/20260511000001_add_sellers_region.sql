-- sellers.region 컬럼 복구
--
-- 배경: initial_schema (2026-04-18) 에는 region 컬럼이 정의돼있었으나,
-- 20260510025423_sellers_drop_business_columns 마이그레이션에서 (옛 매장 정보
-- 섹션 정리할 때) 함께 drop 된 것으로 보임. signup 의 매장 정보 입력 단계에
-- 지역 카테고리 (시·도 + 구·군) 를 다시 받기로 하면서 컬럼이 다시 필요해짐.
--
-- 형식: "서울특별시 용산구" 같은 시·도 + 구·군 한 줄 문자열. 상세 주소는
-- 받지 않음. signup-complete / update-profile 가 저장, get-best-time 등이
-- 트렌드·지역 노출 분석에 사용.
ALTER TABLE public.sellers ADD COLUMN IF NOT EXISTS region text;
COMMENT ON COLUMN public.sellers.region IS '매장 지역 — "시·도 구·군" 형태 (예: "서울특별시 용산구")';
