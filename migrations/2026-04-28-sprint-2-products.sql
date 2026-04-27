-- =========================================================================
-- Sprint 2: 첫 상품 등록 풀 흐름 — products + retry_queue + policy_words
-- 적용 방법: Supabase SQL Editor에서 직접 실행
-- 멱등(idempotent)하게 작성 — 중복 실행 안전
-- =========================================================================

-- =========================================================================
-- 1. products — Lumi 표준 스키마 (정규화)
-- =========================================================================
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,

  -- Lumi 표준 (Normalization 결과)
  title TEXT NOT NULL,
  description TEXT,
  price_suggested INTEGER NOT NULL DEFAULT 0,
  ai_confidence DECIMAL(4,3),

  -- Storage 경로 (Ingestion)
  image_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  primary_image_url TEXT,

  -- 카테고리·키워드 (Transformation 입력)
  category_suggestions JSONB NOT NULL DEFAULT '{}'::jsonb,
  keywords JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- 마켓별 커스터마이즈 (Transformation 결과)
  market_overrides JSONB DEFAULT '{}'::jsonb,

  -- 정책 검사 결과
  policy_warnings JSONB DEFAULT '[]'::jsonb,

  -- AI 원본 (디버깅 / 재분석용)
  raw_ai JSONB,

  -- 상태
  status TEXT NOT NULL DEFAULT 'draft',  -- draft / approved / registering / live / failed

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_seller ON products(seller_id);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(seller_id, status);
CREATE INDEX IF NOT EXISTS idx_products_created ON products(created_at DESC);

CREATE OR REPLACE FUNCTION update_products_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS products_updated_at_trigger ON products;
CREATE TRIGGER products_updated_at_trigger
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_products_updated_at();

ALTER TABLE products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers manage own products" ON products;
CREATE POLICY "Sellers manage own products" ON products
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE products IS 'Sprint 2 Lumi 표준 상품 (Normalization 결과). market_overrides JSONB로 마켓 차이 격리';
COMMENT ON COLUMN products.status IS 'draft: AI 분석 후 셀러 미검수, approved: 검수 완료, registering: 마켓 전송 중, live: 1개 이상 등록 성공, failed: 모든 마켓 실패';

-- =========================================================================
-- 2. product_options — 정규화된 옵션 (조회 빠름)
-- =========================================================================
CREATE TABLE IF NOT EXISTS product_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  option_name TEXT NOT NULL,    -- '색상', '사이즈'
  option_values JSONB NOT NULL, -- ["베이지","블랙"]
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_options_product ON product_options(product_id);

ALTER TABLE product_options ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers read own product options" ON product_options;
CREATE POLICY "Sellers read own product options" ON product_options
  USING (
    EXISTS (
      SELECT 1 FROM products p
      WHERE p.id = product_options.product_id
        AND p.seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id')
    )
  );

-- =========================================================================
-- 3. product_market_registrations — 마켓별 등록 상태 (Distribution 결과)
-- =========================================================================
CREATE TABLE IF NOT EXISTS product_market_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  market TEXT NOT NULL CHECK (market IN ('coupang', 'naver', 'toss')),

  -- 마켓 응답
  market_product_id TEXT,           -- 쿠팡 productId / 네이버 smartstoreProductId
  seller_product_id TEXT,           -- 쿠팡 sellerProductId
  origin_product_no TEXT,           -- 네이버 originProductNo

  direct_link TEXT,                 -- 직링크 (Lumi templating으로 생성)

  status TEXT NOT NULL DEFAULT 'pending',  -- pending / processing / live / failed / mocked

  -- 에러 정보
  last_error JSONB,
  retry_queue_id UUID,

  -- 메타
  registered_at TIMESTAMPTZ,
  raw_response JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (product_id, market)
);

CREATE INDEX IF NOT EXISTS idx_pmr_seller ON product_market_registrations(seller_id);
CREATE INDEX IF NOT EXISTS idx_pmr_product ON product_market_registrations(product_id);
CREATE INDEX IF NOT EXISTS idx_pmr_status ON product_market_registrations(status);

CREATE OR REPLACE FUNCTION update_pmr_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pmr_updated_at_trigger ON product_market_registrations;
CREATE TRIGGER pmr_updated_at_trigger
  BEFORE UPDATE ON product_market_registrations
  FOR EACH ROW EXECUTE FUNCTION update_pmr_updated_at();

ALTER TABLE product_market_registrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Sellers manage own registrations" ON product_market_registrations;
CREATE POLICY "Sellers manage own registrations" ON product_market_registrations
  USING (seller_id::text = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id'));

COMMENT ON TABLE product_market_registrations IS 'Sprint 2 Distribution 결과 — 마켓별 등록 상태 + 직링크';

-- =========================================================================
-- 4. retry_queue — 자동 재시도 엔진 (Sprint 2 핵심)
-- =========================================================================
CREATE TABLE IF NOT EXISTS retry_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL,          -- 'register_product' / 'update_stock' / 'send_invoice'
  market TEXT NOT NULL,
  payload JSONB NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ NOT NULL,
  last_error JSONB,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending / processing / done / abandoned
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_retry_queue_due ON retry_queue(next_retry_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_retry_queue_seller ON retry_queue(seller_id, status);

CREATE OR REPLACE FUNCTION update_retry_queue_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS retry_queue_updated_at_trigger ON retry_queue;
CREATE TRIGGER retry_queue_updated_at_trigger
  BEFORE UPDATE ON retry_queue
  FOR EACH ROW EXECUTE FUNCTION update_retry_queue_updated_at();

ALTER TABLE retry_queue ENABLE ROW LEVEL SECURITY;

-- 일반 사용자 SELECT 차단 (서비스 키만)
COMMENT ON TABLE retry_queue IS 'Sprint 2 Retry Engine — exponential backoff 1m→5m→30m→2h→24h, 최대 5회';

-- =========================================================================
-- 5. policy_words — 마켓별 정책 위반 단어 사전 (관리자 갱신)
-- =========================================================================
CREATE TABLE IF NOT EXISTS policy_words (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market TEXT NOT NULL,             -- 'common' / 'coupang' / 'naver'
  word TEXT NOT NULL,
  cause TEXT NOT NULL,
  suggestion TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  source TEXT,                      -- 'manual' / 'crawl' / 'cs_feedback'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (market, word)
);

CREATE INDEX IF NOT EXISTS idx_policy_words_active ON policy_words(market, active) WHERE active = TRUE;

ALTER TABLE policy_words ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone read active policy words" ON policy_words;
CREATE POLICY "Anyone read active policy words" ON policy_words
  FOR SELECT USING (active = TRUE);

-- 초기 시드 (코드 _shared/policy-words.js와 일치, 갱신 시 한쪽 동기화)
INSERT INTO policy_words (market, word, cause, suggestion, source) VALUES
  ('common', '최고급', '과대광고 우려', '프리미엄', 'manual'),
  ('common', '최저가', '비교 광고 제한', '합리적 가격', 'manual'),
  ('common', '국내 1위', '근거 자료 필수', '많이 찾는', 'manual'),
  ('common', '100% 정품', '인증 자료 필요', '정품 인증', 'manual'),
  ('common', '완치', '의료 효능 표현 금지', '도움', 'manual'),
  ('common', '치료', '의료 효능 표현 금지', '관리', 'manual'),
  ('common', '의약품', '식품에서 의약 표현 금지', '건강기능식품', 'manual'),
  ('coupang', '쿠팡 직배송', '쿠팡 로켓·자체배송 혼동', '빠른 배송', 'manual'),
  ('coupang', '쿠팡 추천', '쿠팡 인증 표현 금지', '인기 상품', 'manual'),
  ('coupang', '로켓배송', '쿠팡 직매입에서만 사용 가능', '익일 배송', 'manual'),
  ('coupang', '특가', '근거 자료 필요', '할인가', 'manual'),
  ('naver', '네이버 인증', '네이버 자체 인증 외 사용 불가', '품질 인증', 'manual'),
  ('naver', '네이버 1위', '근거 자료 필요', '인기', 'manual'),
  ('naver', '스마트스토어 1위', '근거 자료 필요', '인기', 'manual'),
  ('naver', '오늘 마감', '소비자 압박 광고', '한정 수량', 'manual')
ON CONFLICT (market, word) DO UPDATE SET
  cause = EXCLUDED.cause,
  suggestion = EXCLUDED.suggestion,
  updated_at = NOW();

COMMENT ON TABLE policy_words IS 'Sprint 2 정책 위반 단어 사전 — 관리자가 cron 또는 수동 갱신';

-- =========================================================================
-- 6. Storage 버킷 — product-images
-- =========================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-images',
  'product-images',
  TRUE,  -- public read (마켓 API에서 fetch 필요)
  10 * 1024 * 1024,  -- 10MB (쿠팡 한도)
  ARRAY['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Storage RLS — 셀러 본인 폴더 (sellerId/...)에만 업로드 가능
DROP POLICY IF EXISTS "Sellers upload to own folder" ON storage.objects;
CREATE POLICY "Sellers upload to own folder" ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'product-images'
    AND (
      -- service_role bypass (Netlify Functions)
      auth.role() = 'service_role'
      OR (storage.foldername(name))[1] = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id')
    )
  );

DROP POLICY IF EXISTS "Public read product images" ON storage.objects;
CREATE POLICY "Public read product images" ON storage.objects
  FOR SELECT
  USING (bucket_id = 'product-images');

DROP POLICY IF EXISTS "Sellers delete own images" ON storage.objects;
CREATE POLICY "Sellers delete own images" ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'product-images'
    AND (
      auth.role() = 'service_role'
      OR (storage.foldername(name))[1] = (current_setting('request.jwt.claims', true)::jsonb ->> 'seller_id')
    )
  );

-- =========================================================================
-- 마이그레이션 완료 검증 쿼리 (실행 후 수동 점검)
-- =========================================================================
-- SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('products','product_options','product_market_registrations','retry_queue','policy_words');
-- → 5
-- SELECT count(*) FROM policy_words WHERE active = TRUE;
-- → 15
-- SELECT id FROM storage.buckets WHERE id = 'product-images';
-- → 'product-images'
