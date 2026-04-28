-- =========================================================================
-- Sprint 1.5: 마켓 OAuth 위자드 — Deep Link 강화 (estimated_seconds + step 추가)
-- 적용 방법: Supabase SQL Editor에서 직접 실행 (멱등)
--
-- 전제: 2026-04-27-sprint-1-sellers.sql 가 먼저 적용되어 있어야 함
--       (market_guide_links 테이블 + 4개 시드는 그 마이그레이션에서 생성)
-- 이 마이그레이션은 다음만 추가:
--   1) estimated_seconds 컬럼 추가 (시간 안내용)
--   2) 위자드 5단계 시드 보강 (api_key_issue / permission_check / oauth_authorize 등)
-- =========================================================================

-- =========================================================================
-- 1. estimated_seconds 컬럼 (없으면 추가)
-- =========================================================================
ALTER TABLE market_guide_links
  ADD COLUMN IF NOT EXISTS estimated_seconds INTEGER;

COMMENT ON COLUMN market_guide_links.estimated_seconds IS 'Sprint 1.5: 단계 예상 소요 초 (UI에 "앞으로 30초" 형식 표시)';

-- =========================================================================
-- 2. 위자드 단계별 시드 보강
--    UNIQUE (market, step_key) 제약으로 ON CONFLICT 갱신
-- =========================================================================
INSERT INTO market_guide_links (market, step_key, title, external_url, description, estimated_seconds, display_order) VALUES
  -- 쿠팡 위자드 5단계
  ('coupang', 'api_key_issue',
   '쿠팡 OPEN API 키 발급',
   'https://wing.coupang.com/tenants/seller-help/page-help/keyword?keyword=OPEN+API',
   '쿠팡 Wing 우상단 [판매자명] → [추가판매정보] → [OPEN API 키 발급] → 약관 동의 후 [발급] 클릭. 사용 목적은 OPEN API를 선택하세요.',
   30, 10),

  ('coupang', 'permission_check',
   '쿠팡 판매 권한 활성화 확인',
   'https://wing.coupang.com/',
   '쿠팡 Wing 설정에서 [API 연동] 항목의 체크박스가 활성화되어 있는지 확인하세요. 5초 정도면 끝나요.',
   5, 20),

  ('coupang', 'wizard_start',
   '쿠팡 연결 시작 안내',
   'https://wing.coupang.com/tenants/seller-help/page-help/keyword?keyword=OPEN+API',
   '루미가 옆에서 안내해 드릴게요. 쿠팡 Wing 페이지에서 발급 → 복사 → 자동 입력 → 검증 → 완료 순으로 진행됩니다.',
   90, 5),

  -- 네이버 위자드 5단계
  ('naver', 'app_register',
   '네이버 커머스 API 애플리케이션 등록',
   'https://apicenter.commerce.naver.com',
   '네이버 커머스 API 센터에 로그인 → [애플리케이션 등록] → 사용자 직접 사용 (SELF) 선택 → 발급된 Application ID와 Secret을 입력하세요.',
   60, 10),

  ('naver', 'oauth_authorize',
   '네이버 OAuth 권한 동의',
   'https://apicenter.commerce.naver.com',
   '루미가 네이버 권한을 받습니다. 동의 화면이 뜨면 [허용]을 눌러주세요.',
   10, 15),

  ('naver', 'scope_setup',
   '네이버 권한 스코프 설정',
   'https://apicenter.commerce.naver.com',
   '애플리케이션 상세에서 상품/주문/배송 등 필요한 스코프를 활성화하세요.',
   30, 20),

  ('naver', 'wizard_start',
   '네이버 연결 시작 안내',
   'https://apicenter.commerce.naver.com',
   '쿠팡과 동일한 5단계 흐름이에요. 발급 → 복사 → 자동 입력 → 검증 → 완료. 이미 한 번 해보셨으니 더 빨라요.',
   120, 5)
ON CONFLICT (market, step_key) DO UPDATE SET
  title = EXCLUDED.title,
  external_url = EXCLUDED.external_url,
  description = EXCLUDED.description,
  estimated_seconds = EXCLUDED.estimated_seconds,
  display_order = EXCLUDED.display_order,
  updated_at = NOW();

-- =========================================================================
-- 3. 검증 쿼리 (수동)
-- =========================================================================
-- SELECT count(*) FROM market_guide_links WHERE active = TRUE;
-- → 7+ (쿠팡 3 + 네이버 4)
--
-- SELECT market, step_key, estimated_seconds, display_order
-- FROM market_guide_links
-- WHERE active = TRUE
-- ORDER BY market, display_order;
