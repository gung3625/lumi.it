-- migrations/005-trend-subcategories-seed.sql
-- Long-tail 세부 카테고리 시드 (Phase 3)
-- 9업종 × 평균 5개 서브카테고리 = 45 row
-- idempotent: ON CONFLICT DO UPDATE

INSERT INTO public.trend_subcategories (category, sub_category, label_ko, seed_queries, active) VALUES
  -- cafe (5)
  ('cafe', 'cafe-specialty', '스페셜티',    '["핸드드립","싱글오리진","로스팅 원두"]',                   true),
  ('cafe', 'cafe-bakery',    '베이커리',    '["소금빵","크로플","비건 베이커리"]',                        true),
  ('cafe', 'cafe-dessert',   '디저트카페',  '["말차디저트","케이크","마카롱"]',                           true),
  ('cafe', 'cafe-drink',     '음료',        '["시그니처 음료","한정 음료","계절 음료"]',                  true),
  ('cafe', 'cafe-concept',   '컨셉',        '["컨셉카페","감성카페","루프탑카페"]',                       true),

  -- food (5)
  ('food', 'food-korean',   '한식',        '["한정식","한식주점","분식"]',                               true),
  ('food', 'food-japanese', '일식',        '["오마카세","이자카야","라멘"]',                              true),
  ('food', 'food-western',  '양식',        '["파스타","스테이크","브런치"]',                             true),
  ('food', 'food-chinese',  '중식',        '["마라탕","딤섬","훠궈"]',                                   true),
  ('food', 'food-street',   '길거리/간식', '["붕어빵","떡볶이","간식거리"]',                             true),

  -- beauty (5)
  ('beauty', 'beauty-skincare',  '스킨케어',   '["피부장벽","토너","에센스"]',                           true),
  ('beauty', 'beauty-makeup',    '메이크업',   '["쿠션","파운데이션","립"]',                             true),
  ('beauty', 'beauty-suncare',   '선케어',     '["선크림","선스틱","자외선차단"]',                       true),
  ('beauty', 'beauty-mens',      '남성',       '["남자스킨케어","남자기초","남자 피부관리"]',             true),
  ('beauty', 'beauty-antiaging', '안티에이징', '["안티에이징","주름개선","탄력크림"]',                   true),

  -- hair (5)
  ('hair', 'hair-cut',   '커트',     '["레이어드컷","단발","장발"]',                                    true),
  ('hair', 'hair-perm',  '펌',       '["볼륨펌","매직스트레이트","디지털펌"]',                          true),
  ('hair', 'hair-color', '염색',     '["뿌리염색","하이라이트","발레아쥬"]',                            true),
  ('hair', 'hair-scalp', '두피케어', '["두피스케일링","탈모","헤어클리닉"]',                            true),
  ('hair', 'hair-mens',  '남성',     '["남자머리","남자커트","남자펌"]',                                 true),

  -- nail (4)
  ('nail', 'nail-gel',    '젤네일',       '["젤네일","오프젤","젤컬러"]',                               true),
  ('nail', 'nail-art',    '네일아트',     '["네일아트","플라워네일","큐빅네일"]',                       true),
  ('nail', 'nail-care',   '네일케어',     '["페디큐어","큐티클","매니큐어"]',                           true),
  ('nail', 'nail-season', '계절/이벤트', '["웨딩네일","봄네일","파티네일"]',                            true),

  -- flower (4)
  ('flower', 'flower-bouquet', '꽃다발/부케', '["꽃다발","웨딩부케","프로포즈부케"]',                   true),
  ('flower', 'flower-dried',   '드라이플라워','["드라이플라워","리스","포푸리"]',                        true),
  ('flower', 'flower-event',   '이벤트',      '["어버이날","생일꽃","기념일꽃"]',                       true),
  ('flower', 'flower-plant',   '화분/식물',   '["공기정화식물","행운식물","반려식물"]',                  true),

  -- fashion (5)
  ('fashion', 'fashion-women',  '여성복',        '["원피스","블라우스","니트"]',                        true),
  ('fashion', 'fashion-men',    '남성복',        '["남자 코디","슈트","남자 니트"]',                    true),
  ('fashion', 'fashion-acc',    '악세서리',      '["귀걸이","목걸이","반지"]',                          true),
  ('fashion', 'fashion-casual', '캐주얼/스트릿', '["오버핏","빈티지","스트릿"]',                        true),
  ('fashion', 'fashion-office', '오피스/비즈',   '["오피스룩","비즈니스룩","정장"]',                   true),

  -- fitness (5)
  ('fitness', 'fitness-pilates',  '필라테스',   '["필라테스","리포머","기구 필라테스"]',                true),
  ('fitness', 'fitness-yoga',     '요가',       '["하타요가","빈야사","요가플로우"]',                   true),
  ('fitness', 'fitness-gym',      '헬스',       '["헬스장","웨이트","PT"]',                            true),
  ('fitness', 'fitness-home',     '홈트',       '["홈트","맨몸운동","덤벨"]',                          true),
  ('fitness', 'fitness-crossfit', '크로스핏/복합','["크로스핏","케틀벨","복합운동"]',                  true),

  -- pet (4)
  ('pet', 'pet-dog',     '강아지',    '["강아지간식","강아지사료","강아지용품"]',                       true),
  ('pet', 'pet-cat',     '고양이',    '["고양이모래","캣타워","고양이 사료"]',                          true),
  ('pet', 'pet-service', '서비스',    '["반려견미용","펫호텔","펫시터"]',                               true),
  ('pet', 'pet-health',  '건강/용품', '["반려동물보험","유산균","영양제"]',                             true)

ON CONFLICT (category, sub_category)
  DO UPDATE SET
    seed_queries = EXCLUDED.seed_queries,
    active       = true;
