-- =========================================================================
-- 주문서 메모 기능 — marketplace_orders.seller_memo 컬럼 추가
-- 멱등(idempotent) — 중복 실행 안전
-- =========================================================================
ALTER TABLE marketplace_orders
  ADD COLUMN IF NOT EXISTS seller_memo TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS seller_memo_updated_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN marketplace_orders.seller_memo IS '사장님 내부 메모 (예: 포장 요청, CS 인계 맥락). 평문 저장 가능하나 응답에 포함 시 본인 주문만 노출.';
COMMENT ON COLUMN marketplace_orders.seller_memo_updated_at IS '마지막 메모 수정 시각';

NOTIFY pgrst, 'reload schema';
