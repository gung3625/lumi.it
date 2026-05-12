// TikTok for Business (Marketing API) OAuth 콜백 — **현재 비활성** (안전한 noop).
//
// 배경:
//   2026-05 보안 리뷰에서 본 콜백이 ① state == sellerId 가정만으로 토큰을 임의 사장님 row 에
//   바인딩 가능 (계정 탈취) ② access_token 평문 저장 (Vault 미사용) 두 가지 CRITICAL 결함 발견.
//   동시에 코드 확인 결과 ① 호출하는 UI / start 함수 페어 없음 ② 저장 대상 테이블
//   seller_tiktok_tokens 도 마이그레이션에 존재하지 않음 → 사실상 dead code 였음.
//
//   실제 TikTok 연동은 auth-tiktok-login-callback.js (Login Kit / Content Posting, oauth_nonces
//   일회용 nonce + Vault RPC set_tiktok_access_token) 로 안전하게 처리됨.
//
//   라우트를 즉시 삭제하지 않은 이유: TikTok 개발자 대시보드에 본 URL 이 callback 으로
//   등록돼 있을 가능성이 있고, 404 응답은 앱 심사 / TikTok 측 헬스체크에 영향을 줄 수 있어
//   라우트는 유지하되 동작은 안전한 noop 으로 축소.
//
// 추후 Marketing API 정식 도입 시:
//   1) auth-tiktok-login-callback.js 의 oauth_nonces ('tiktok_marketing:' prefix) 패턴 복제
//   2) Vault RPC (예: set_tiktok_marketing_access_token) 신설 후 평문 저장 금지
//   3) seller_tiktok_tokens 또는 동등 테이블 마이그레이션 + RLS 정책 추가
//   4) start 엔드포인트 신설 (nonce 발급 + state 로 전달)

const SETTINGS_URL = 'https://lumi.it.kr/settings';

function redirect(location, headers = {}) {
  return {
    statusCode: 302,
    headers: { Location: location, 'Cache-Control': 'no-store', ...headers },
    body: '',
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*' } };
  }

  // 호출 사실만 로깅 — 어디서 트리거되는지 추적 (정상 운영에선 0건 기대).
  // code / state / 토큰 값 등은 절대 로그에 출력 금지.
  console.warn('[tiktok-oauth-callback] 비활성 콜백 호출됨 — 토큰 교환·저장 모두 skip');

  return redirect(`${SETTINGS_URL}?tiktok_marketing=disabled`);
};
