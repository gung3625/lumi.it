-- 2026-04-29-atomic-rate-limit-rpc.sql
-- M3 / M4 race-condition 방지: atomic upsert RPC
-- 기존 SELECT-then-UPDATE 패턴은 동시 호출 시 한도 초과를 허용함.
-- INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 로 원자성 보장.

-- ──────────────────────────────────────────────────────────
-- M3: rate_limit_counters (Tier 한도 카운터)
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bump_rate_limit_atomic(
  p_seller_id UUID,
  p_tier_key TEXT,
  p_bucket_date DATE
)
RETURNS TABLE (call_count INT) AS $$
BEGIN
  RETURN QUERY
  INSERT INTO public.rate_limit_counters (seller_id, tier_key, bucket_date, call_count, updated_at)
  VALUES (p_seller_id, p_tier_key, p_bucket_date, 1, now())
  ON CONFLICT (seller_id, tier_key, bucket_date)
  DO UPDATE SET
    call_count = public.rate_limit_counters.call_count + 1,
    updated_at = now()
  RETURNING public.rate_limit_counters.call_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.bump_rate_limit_atomic(UUID, TEXT, DATE) TO authenticated, service_role, anon;

-- 인덱스 (UNIQUE 제약 보장 — 이미 PK 또는 UNIQUE라면 SKIP)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'rate_limit_counters_seller_tier_bucket_uniq'
  ) THEN
    BEGIN
      CREATE UNIQUE INDEX rate_limit_counters_seller_tier_bucket_uniq
        ON public.rate_limit_counters (seller_id, tier_key, bucket_date);
    EXCEPTION WHEN OTHERS THEN
      -- 이미 다른 이름의 UNIQUE가 있으면 무시
      NULL;
    END;
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────
-- M4: alimtalk_rate_limit (알림톡 일·30분 카운터)
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bump_alimtalk_rate_limit_atomic(
  p_seller_id UUID,
  p_window_kind TEXT,
  p_window_key TEXT
)
RETURNS TABLE (count INT) AS $$
BEGIN
  RETURN QUERY
  INSERT INTO public.alimtalk_rate_limit (seller_id, window_kind, window_key, count, last_at)
  VALUES (p_seller_id, p_window_kind, p_window_key, 1, now())
  ON CONFLICT (seller_id, window_kind, window_key)
  DO UPDATE SET
    count = public.alimtalk_rate_limit.count + 1,
    last_at = now()
  RETURNING public.alimtalk_rate_limit.count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.bump_alimtalk_rate_limit_atomic(UUID, TEXT, TEXT) TO authenticated, service_role, anon;

-- 인덱스 멱등 생성
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'alimtalk_rate_limit_window_uniq'
  ) THEN
    BEGIN
      CREATE UNIQUE INDEX alimtalk_rate_limit_window_uniq
        ON public.alimtalk_rate_limit (seller_id, window_kind, window_key);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────
-- M6: insight_cost_ledger atomic (월별 비용 누적)
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bump_insight_cost_atomic(
  p_seller_id UUID,
  p_bucket_month DATE,
  p_cost_krw NUMERIC
)
RETURNS TABLE (total_cost_krw NUMERIC, call_count INT) AS $$
BEGIN
  RETURN QUERY
  INSERT INTO public.insight_cost_ledger (seller_id, bucket_month, total_cost_krw, call_count, updated_at)
  VALUES (p_seller_id, p_bucket_month, p_cost_krw, 1, now())
  ON CONFLICT (seller_id, bucket_month)
  DO UPDATE SET
    total_cost_krw = public.insight_cost_ledger.total_cost_krw + p_cost_krw,
    call_count = public.insight_cost_ledger.call_count + 1,
    updated_at = now()
  RETURNING public.insight_cost_ledger.total_cost_krw, public.insight_cost_ledger.call_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.bump_insight_cost_atomic(UUID, DATE, NUMERIC) TO authenticated, service_role, anon;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'insight_cost_ledger_seller_month_uniq'
  ) THEN
    BEGIN
      CREATE UNIQUE INDEX insight_cost_ledger_seller_month_uniq
        ON public.insight_cost_ledger (seller_id, bucket_month);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
