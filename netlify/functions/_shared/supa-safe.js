// supa-safe.js — supabase-js 빌더 호출을 항상 { data, error } 로 정착시키는 await 헬퍼
//
// 배경: @supabase/postgrest-js 의 PostgrestBuilder 는 PromiseLike(=then 만 정의)으로
// 설계되어 있고 .catch 메소드를 제공하지 않는다. 따라서 호출부에서
//   await admin.rpc(...).catch(...) 같이 메소드 체이닝을 시도하면
//   "TypeError: admin.rpc(...).catch is not a function" 동기 throw 가 발생한다.
// 2026-05-01 이 패턴이 cron 경로에 들어가 매일 자정 트렌드 갱신이 9일째 죽었다.
//
// 사용법:
//   const { data, error } = await safeAwait(admin.rpc('foo', { ... }));
//   const { error } = await safeAwait(supabase.from('t').update({...}).eq('id', x));
//
// 절대 throw 하지 않는다. 네트워크/abort/parse 류 reject 도 error 로 정착시킨다.
// 호출부는 supabase-js 의 일반 await 결과와 동일하게 error 만 분기하면 된다.

'use strict';

async function safeAwait(builder) {
  try {
    const result = await builder;
    if (result && typeof result === 'object' && 'data' in result) return result;
    // builder 가 supabase 응답 모양이 아닌 경우 (예: 잘못 넘어온 값) 도 정착
    return { data: result ?? null, error: null };
  } catch (e) {
    return {
      data: null,
      error: {
        message: (e && e.message) || 'supa_safe_thrown',
        thrown: true,
        code: (e && e.code) || null,
      },
    };
  }
}

module.exports = { safeAwait };
