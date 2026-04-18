-- =====================================================
-- RLS 보강 마이그레이션 (2026-04-18)
-- 1. ig_accounts DELETE 정책 (본인만 해지 가능)
-- 2. users.plan 컬럼 변경 잠금 (권한 상승 방지)
-- 3. users.trial_start, auto_renew 도 service_role만
-- =====================================================

-- 1. ig_accounts DELETE 정책
DROP POLICY IF EXISTS ig_accounts_delete_own ON public.ig_accounts;
CREATE POLICY ig_accounts_delete_own ON public.ig_accounts
  FOR DELETE
  USING (auth.uid() = user_id);

-- 2. users.plan 잠금 trigger
-- service_role은 auth.role() = 'service_role' 반환 → 잠금 무시
-- 일반 anon/authenticated 유저가 plan/trial_start/auto_renew 변경 시도 시 예외 발생
CREATE OR REPLACE FUNCTION public.users_plan_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- service_role은 잠금 무시
  IF (SELECT auth.role()) = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.plan IS DISTINCT FROM OLD.plan THEN
      RAISE EXCEPTION 'plan column can only be modified by service_role' USING ERRCODE = '42501';
    END IF;
    IF NEW.trial_start IS DISTINCT FROM OLD.trial_start THEN
      RAISE EXCEPTION 'trial_start column can only be modified by service_role' USING ERRCODE = '42501';
    END IF;
    IF NEW.auto_renew IS DISTINCT FROM OLD.auto_renew THEN
      RAISE EXCEPTION 'auto_renew column can only be modified by service_role' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_plan_lock_trigger ON public.users;
CREATE TRIGGER users_plan_lock_trigger
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.users_plan_lock();
