-- handle_auth_user_sync 트리거 함수 — 옛 public.users → 현 public.sellers redirect.
--
-- 배경:
--   초기 스키마 (20260418000000) 는 public.users + public.sellers 분리 구조였음.
--   이후 public.users 가 drop 되고 sellers 가 유일한 사용자 프로필 테이블이 됨.
--   그런데 트리거 함수는 옛 public.users insert 그대로 → 새 가입자 발생 시
--   트리거 fail → auth.users INSERT 자체 롤백 가능.
--
--   카카오 가입자는 edge function (auth-kakao-callback) 이 sellers INSERT 를
--   별도 처리해서 영향 없음. 본 fix 는 Supabase auth.signUp (구글/이메일)
--   경로 사용 시 안전.
--
-- 변경:
--   INSERT 대상을 public.sellers 로 redirect. NOT NULL 컬럼은 모두 default
--   값 있으므로 id + email + display_name + signup_method 만 명시.
--   ON CONFLICT (id) DO UPDATE 로 멱등성 보장.
--   EXCEPTION 핸들러로 트리거 실패가 auth.users 가입을 막지 않도록 graceful.
--
-- 동시에:
--   직전 마이그레이션 (20260512400000) 으로 caption_history RLS 가 generated
--   row 제외하도록 fix됨. 이 마이그레이션은 트리거 함수 본문만 교체.

CREATE OR REPLACE FUNCTION public.handle_auth_user_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.sellers (id, email, display_name, signup_method)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name',
      split_part(COALESCE(NEW.email, ''), '@', 1)
    ),
    COALESCE(NEW.raw_user_meta_data->>'provider', 'supabase_auth')
  )
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- 트리거 실패가 auth.users INSERT 자체를 막지 않도록 graceful.
  -- 실패해도 로그만 남기고 새 사용자 가입은 진행됨. 후속 sellers row 부재는
  -- 다음 로그인/요청 시 명시적 INSERT 흐름이 보완.
  RAISE WARNING '[handle_auth_user_sync] sellers INSERT 실패 (graceful skip): %', SQLERRM;
  RETURN NEW;
END;
$$;
