-- ============================================================
-- 주문서 옵션 매핑 — DB 스키마 마이그레이션
-- 2026-05-01 | 마켓 옵션명 ↔ 마스터 옵션명 매핑 테이블
--
-- 변경 내용:
--   1. order_mappings 테이블 신규 생성
--      (마켓별 옵션명 → 마스터 옵션명 1:1 매핑)
--   2. 인덱스: seller 조회, (seller, market, 옵션명) 룩업
--   3. RLS: 셀러 본인 데이터만 접근 (JWT claims 기반)
--   4. updated_at 자동 갱신 트리거
--
-- 멱등성: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS 사용
-- 실행: Supabase SQL Editor 또는 apply-one.js 로 적용
--   https://supabase.com/dashboard/project/cldsozdocxpvkbuxwqep/sql
-- ============================================================

BEGIN;

-- ============================================================
-- Part 1. order_mappings 테이블
--
-- 컬럼 설명:
--   id                  UUID     — PK, 자동 생성
--   seller_id           UUID     — 셀러 UUID (sellers 테이블 FK)
--   market              TEXT     — 마켓 코드: coupang | naver | toss
--   market_option_name  TEXT     — 마켓에서 받은 옵션명 (예: "L사이즈", "사이즈: L")
--   master_product_id   UUID     — 마스터 상품 UUID (products 테이블 FK, nullable)
--   master_option_name  TEXT     — 마스터 옵션명 (예: "L"), nullable
--   use_count           INT      — 매핑 적용 횟수 (통계/디버깅용)
--   last_applied_at     TIMESTAMPTZ — 마지막 적용 시각
--   created_at          TIMESTAMPTZ — 생성 시각
--   updated_at          TIMESTAMPTZ — 최종 수정 시각
--
-- 유니크 제약: (seller_id, market, market_option_name) — 중복 매핑 방지
-- ============================================================

CREATE TABLE IF NOT EXISTS order_mappings (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id           UUID        NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  market              TEXT        NOT NULL CHECK (market IN ('coupang', 'naver', 'toss')),
  market_option_name  TEXT        NOT NULL,
  master_product_id   UUID        REFERENCES products(id) ON DELETE SET NULL,
  master_option_name  TEXT,
  use_count           INT         NOT NULL DEFAULT 0,
  last_applied_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (seller_id, market, market_option_name)
);

COMMENT ON TABLE order_mappings IS '마켓 옵션명 ↔ 마스터 옵션명 매핑. 셀러가 한 번 설정하면 주문 수집 시 자동 변환에 활용.';
COMMENT ON COLUMN order_mappings.market_option_name IS '마켓에서 수신한 원본 옵션명 (예: "L사이즈", "사이즈:L / 색상:블랙")';
COMMENT ON COLUMN order_mappings.master_option_name IS '루미 내부 마스터 옵션명 (예: "L")';
COMMENT ON COLUMN order_mappings.use_count IS '이 매핑이 주문 변환에 사용된 총 횟수';

-- ============================================================
-- Part 2. 인덱스
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_order_mappings_seller
  ON order_mappings(seller_id);

CREATE INDEX IF NOT EXISTS idx_order_mappings_lookup
  ON order_mappings(seller_id, market, market_option_name);

-- ============================================================
-- Part 3. updated_at 자동 갱신 트리거
-- ============================================================

CREATE OR REPLACE FUNCTION update_order_mappings_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_order_mappings_updated_at ON order_mappings;
CREATE TRIGGER trg_order_mappings_updated_at
  BEFORE UPDATE ON order_mappings
  FOR EACH ROW EXECUTE FUNCTION update_order_mappings_updated_at();

-- ============================================================
-- Part 4. RLS (Row-Level Security)
-- service_role은 RLS 우회 — Netlify Functions 모두 service_role 사용
-- 셀러 본인 데이터만 접근 (anon/authenticated role 직접 접근 시 적용)
-- ============================================================

ALTER TABLE order_mappings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "order_mappings_seller_own" ON order_mappings;
CREATE POLICY "order_mappings_seller_own"
  ON order_mappings FOR ALL
  USING (
    seller_id::text = (current_setting('request.jwt.claims', true)::jsonb->>'seller_id')
  );

COMMIT;
