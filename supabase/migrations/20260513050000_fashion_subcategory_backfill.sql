-- fashion 카테고리의 trend_keywords 옛 row 들 sub_category 마킹.
-- 사장님 요청 (2026-05-13): fashion 탭을 옷·신발 sub 로 분리.
-- frontend categories.js + scheduled-trends-v2-background.js 의 classifyFashionSubcat 보강.
-- 새 cron 부터 자동 마킹되지만 옛 row 도 즉시 sub 분기되도록 1회 backfill.

UPDATE trend_keywords
SET sub_category = 'footwear'
WHERE category = 'fashion'
  AND (sub_category = '' OR sub_category IS NULL)
  AND (
    keyword ~ '(운동화|스니커즈|러닝화|구두|샌들|부츠|로퍼|플랫|힐|신발|슬리퍼|슬리포츠|워커|슬립온|뮬|크록스|나이키|아디다스|호카|온러닝|뉴발란스|뉴발|반스|컨버스|푸마|아식스|살로몬|휠라|언더아머|리복)'
  );

UPDATE trend_keywords
SET sub_category = 'clothing'
WHERE category = 'fashion'
  AND (sub_category = '' OR sub_category IS NULL);
