-- trends 테이블 category prefix LIKE 성능 보강
-- scheduled-trends.js 가 'l30d-domestic:cafe:%' 같은 날짜 히스토리 조회에 LIKE 사용
-- 기본 btree (en_US.utf8 locale) 는 prefix LIKE 최적화 불가 → text_pattern_ops 인덱스 추가

create index if not exists trends_category_pattern_idx
  on public.trends (category text_pattern_ops);
