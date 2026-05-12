-- caption_history RLS — 'generated' row 는 사장님 본인에게도 노출 금지.
--
-- 배경:
--   PR #150 (마이그레이션 20260512300000) 으로 caption_history 에
--   caption_type='generated' + validator_scores (gpt-4o-mini 채점 결과,
--   issues 배열 포함) row 가 적재되기 시작. 이는 내부 운영용 통계 표본 —
--   사장님에게 "톤 안 맞음, 클리셰" 같은 코멘트가 보이면 혼란.
--
--   기존 RLS 는 FOR ALL USING (auth.uid() = user_id) 로 본인 모든 row 노출.
--   현재는 caption_history 를 사용자 JWT 로 직접 SELECT 하는 코드 경로가
--   없지만 (모든 server-side 함수는 service_role 로 RLS 우회), 미래에
--   대시보드/Insights 가 직접 fetch 하면 즉시 누출 발생.
--
-- 조치:
--   FOR ALL 정책을 SELECT 분리해 'generated' 제외. INSERT/UPDATE/DELETE 는
--   기존 동작 유지 (사실상 service_role 만 쓰지만 안전망).

DROP POLICY IF EXISTS "caption_history: 본인 이력 모든 작업" ON public.caption_history;

-- SELECT — 'generated' (admin 내부 통계용) 제외
CREATE POLICY "caption_history: 본인 이력 SELECT (generated 제외)"
  ON public.caption_history FOR SELECT
  USING (auth.uid() = user_id AND caption_type <> 'generated');

-- INSERT — 본인 user_id 로만
CREATE POLICY "caption_history: 본인 INSERT"
  ON public.caption_history FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- UPDATE — 본인 row 만 (tone_rated 같은 사용자 평가 갱신용)
CREATE POLICY "caption_history: 본인 UPDATE"
  ON public.caption_history FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- DELETE — 본인 row 만 (현재 사용 경로 없음, 안전망)
CREATE POLICY "caption_history: 본인 DELETE"
  ON public.caption_history FOR DELETE
  USING (auth.uid() = user_id);
