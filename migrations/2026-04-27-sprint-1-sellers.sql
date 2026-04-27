-- =========================================================================
-- Sprint 1: Phase 1 멀티마켓 셀러 가입 — sellers + audit_logs
-- 적용 방법: Supabase SQL Editor에서 직접 실행 또는
--           NETLIFY_PG_DSN 환경변수로 admin-apply-migration 함수 사용
-- =========================================================================

-- 신규 sellers 테이블 (Phase 1 멀티마켓 셀러)
CREATE TABLE IF NOT EXISTS sellers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_number TEXT UNIQUE NOT NULL,
  owner_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  birth_date DATE,
  store_name TEXT,

  -- 가입 단계 진행도 (1: 사업자인증 / 2: 마켓연결 / 3: 말투학습 / 4: 첫등록 / 5: 완료)
  signup_step INTEGER NOT NULL DEFAULT 1,
  signup_completed_at TIMESTAMPTZ,

  -- 인증 상태
  business_verified BOOLEAN NOT NULL DEFAULT FALSE,
  business_verified_at TIMESTAMPTZ,
  business_verify_method TEXT,  -- 'pg_toss' / 'manual' / 'mock'

  -- 동의
  marketing_consent BOOLEAN NOT NULL DEFAULT FALSE,
  privacy_consent_at TIMESTAMPTZ,
  terms_consent_at TIMESTAMPTZ,

  -- 메타
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 기본 plan
  plan TEXT NOT NULL DEFAULT 'trial',  -- trial / starter / standard / pro
  trial_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 추천
  referral_code TEXT UNIQUE,
  referred_by UUID REFERENCES sellers(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sellers_phone ON sellers(phone);
CREATE INDEX IF NOT EXISTS idx_sellers_referral_code ON sellers(referral_code);
CREATE INDEX IF NOT EXISTS idx_sellers_business_number ON sellers(business_number);

-- updated_at 자동 갱신 트리거
CREATE OR REPLACE FUNCTION update_sellers_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sellers_updated_at_trigger ON sellers;
CREATE TRIGGER sellers_updated_at_trigger
  BEFORE UPDATE ON sellers
  FOR EACH ROW EXECUTE FUNCTION update_sellers_updated_at();

-- RLS — 셀러는 자기 row만 SELECT 가능 (서비스 키 우회는 자동)
ALTER TABLE sellers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers can read own row" ON sellers;
CREATE POLICY "Sellers can read own row" ON sellers
  FOR SELECT
  USING (id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

-- =========================================================================
-- Audit Log (Privacy-by-Design)
-- =========================================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_id UUID,
  actor_type TEXT,                  -- 'seller' / 'system' / 'admin'
  action TEXT NOT NULL,             -- 'signup_start' / 'business_verify' / 'signup_complete'
  resource_type TEXT,
  resource_id TEXT,
  metadata JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action, created_at DESC);

-- audit_logs RLS — 일반 사용자는 읽을 수 없음 (서비스 키만)
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- =========================================================================
-- market_credentials — 쿠팡/네이버/토스 자격증명 (암호화 저장)
-- =========================================================================
CREATE TABLE IF NOT EXISTS market_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  market TEXT NOT NULL CHECK (market IN ('coupang', 'naver', 'toss')),

  -- 암호화 자격증명 (AES-256-GCM via _shared/encryption.js)
  -- 형식: { ciphertext, iv, tag } base64
  credentials_encrypted JSONB NOT NULL,

  -- OAuth 토큰 관리 (네이버용)
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expires_at TIMESTAMPTZ,

  -- 검증 상태
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at TIMESTAMPTZ,
  last_verified_at TIMESTAMPTZ,
  verification_error TEXT,

  -- 마켓 메타 (셀러에게 보여주기 위한 비민감 정보)
  market_seller_id TEXT,        -- 쿠팡 Vendor ID, 네이버 채널 ID 등
  market_store_name TEXT,        -- 매장명

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (seller_id, market)
);

CREATE INDEX IF NOT EXISTS idx_market_credentials_seller ON market_credentials(seller_id);
CREATE INDEX IF NOT EXISTS idx_market_credentials_market ON market_credentials(market);

-- updated_at 자동 갱신
CREATE OR REPLACE FUNCTION update_market_credentials_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS market_credentials_updated_at_trigger ON market_credentials;
CREATE TRIGGER market_credentials_updated_at_trigger
  BEFORE UPDATE ON market_credentials
  FOR EACH ROW EXECUTE FUNCTION update_market_credentials_updated_at();

ALTER TABLE market_credentials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers manage own credentials" ON market_credentials;
CREATE POLICY "Sellers manage own credentials" ON market_credentials
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

-- =========================================================================
-- 검증용 코멘트
-- =========================================================================
COMMENT ON TABLE sellers IS 'Phase 1 멀티마켓 셀러 — 5단계 가입 진행도 포함';
COMMENT ON COLUMN sellers.signup_step IS '1: 사업자인증, 2: 마켓연결, 3: 말투학습, 4: 첫등록, 5: 완료';
COMMENT ON COLUMN sellers.business_verify_method IS 'pg_toss: 토스 PG 통합인증, manual: 수기, mock: 모킹(베타)';
COMMENT ON TABLE audit_logs IS 'Privacy-by-Design 감사 로그 — 개인정보 평문 금지';
COMMENT ON TABLE market_credentials IS '쿠팡/네이버/토스 자격증명 — AES-256-GCM 암호화 저장 필수';
COMMENT ON COLUMN market_credentials.credentials_encrypted IS 'JSON { ciphertext, iv, tag } — 평문 절대 금지';

-- =========================================================================
-- market_guide_links — 정책 변경 대응 deep link (관리자 수정)
-- =========================================================================
CREATE TABLE IF NOT EXISTS market_guide_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market TEXT NOT NULL,                       -- 'coupang' / 'naver' / 'toss'
  step_key TEXT NOT NULL,                     -- 'api_key_issue' / 'permission_check' 등
  title TEXT NOT NULL,
  external_url TEXT NOT NULL,
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (market, step_key)
);

CREATE INDEX IF NOT EXISTS idx_market_guide_active ON market_guide_links(market, active) WHERE active = TRUE;

ALTER TABLE market_guide_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read active guides" ON market_guide_links;
CREATE POLICY "Anyone can read active guides" ON market_guide_links
  FOR SELECT
  USING (active = TRUE);

-- 초기 시드
INSERT INTO market_guide_links (market, step_key, title, external_url, description, display_order) VALUES
  ('coupang', 'api_key_issue', '쿠팡 OPEN API 키 발급', 'https://wing.coupang.com/tenants/seller-help/page-help/keyword?keyword=OPEN+API', '쿠팡 Wing 우상단 [판매자명] → [추가판매정보] → [OPEN API 키 발급] → 약관 동의 후 [발급] 클릭. 사용 목적은 OPEN API를 선택하세요.', 10),
  ('coupang', 'permission_check', '쿠팡 판매 권한 활성화 확인', 'https://wing.coupang.com/', '쿠팡 Wing 설정에서 [API 연동] 항목의 체크박스가 활성화되어 있는지 확인하세요. (5초 정도 소요)', 20),
  ('naver', 'app_register', '네이버 커머스 API 애플리케이션 등록', 'https://apicenter.commerce.naver.com', '네이버 커머스 API 센터에 로그인 → [애플리케이션 등록] → 사용자 직접 사용 (SELF) 선택 → 발급된 Application ID와 Secret을 입력하세요.', 10),
  ('naver', 'scope_setup', '네이버 권한 스코프 설정', 'https://apicenter.commerce.naver.com', '애플리케이션 상세에서 상품/주문/배송 등 필요한 스코프를 활성화하세요.', 20)
ON CONFLICT (market, step_key) DO UPDATE SET
  title = EXCLUDED.title,
  external_url = EXCLUDED.external_url,
  description = EXCLUDED.description,
  display_order = EXCLUDED.display_order,
  updated_at = NOW();

COMMENT ON TABLE market_guide_links IS '셀러용 마켓 가이드 deep link — 정책 변경 시 관리자 페이지에서 URL/텍스트만 갱신';
COMMENT ON COLUMN market_guide_links.step_key IS 'api_key_issue: 키 발급, permission_check: 판매 권한 확인, app_register: 앱 등록, scope_setup: 스코프 설정';
