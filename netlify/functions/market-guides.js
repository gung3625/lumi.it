// 마켓 가이드 deep link 조회 — Sprint 1
// GET /api/market-guides?market=coupang
// 응답: { success: true, guides: [{ step_key, title, external_url, description }] }
//
// Principle 3: 정책 변경 대응 — 관리자가 DB만 수정하면 모든 셀러에게 즉시 반영
// 인증 불필요 (공개 가이드)
const { getAdminClient } = require('./_shared/supabase-admin');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const ALLOWED_MARKETS = ['coupang', 'naver', 'toss'];

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const market = (event.queryStringParameters?.market || '').toLowerCase();
  if (market && !ALLOWED_MARKETS.includes(market)) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: '지원하지 않는 마켓입니다.' }),
    };
  }

  // DB 미설정 시 정적 fallback 가이드 (UI deep link 작동 보장)
  const FALLBACK_GUIDES = [
    { market: 'coupang', step_key: 'api_key_issue', title: '쿠팡 OPEN API 키 발급', external_url: 'https://wing.coupang.com/tenants/seller-help/page-help/keyword?keyword=OPEN+API', description: '쿠팡 Wing 우상단 [판매자명] → [추가판매정보] → [OPEN API 키 발급] → 약관 동의 후 [발급] 클릭. 사용 목적은 OPEN API를 선택하세요.', display_order: 10 },
    { market: 'coupang', step_key: 'permission_check', title: '쿠팡 판매 권한 활성화 확인', external_url: 'https://wing.coupang.com/', description: '쿠팡 Wing 설정에서 [API 연동] 항목의 체크박스가 활성화되어 있는지 확인하세요. (5초 정도 소요)', display_order: 20 },
    { market: 'naver', step_key: 'app_register', title: '네이버 커머스 API 애플리케이션 등록', external_url: 'https://apicenter.commerce.naver.com', description: '네이버 커머스 API 센터에 로그인 → [애플리케이션 등록] → 사용자 직접 사용 (SELF) 선택 → 발급된 Application ID와 Secret을 입력하세요.', display_order: 10 },
    { market: 'naver', step_key: 'scope_setup', title: '네이버 권한 스코프 설정', external_url: 'https://apicenter.commerce.naver.com', description: '애플리케이션 상세에서 상품/주문/배송 등 필요한 스코프를 활성화하세요.', display_order: 20 },
  ];

  let admin;
  try { admin = getAdminClient(); } catch (e) {
    const filtered = market ? FALLBACK_GUIDES.filter((g) => g.market === market) : FALLBACK_GUIDES;
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, guides: filtered, unavailable: true, fallback: true }),
    };
  }

  let q = admin
    .from('market_guide_links')
    .select('market, step_key, title, external_url, description, display_order')
    .eq('active', true)
    .order('display_order', { ascending: true });
  if (market) q = q.eq('market', market);

  const { data, error } = await q;
  if (error) {
    console.error('[market-guides] select 오류:', error.message);
    const filtered = market ? FALLBACK_GUIDES.filter((g) => g.market === market) : FALLBACK_GUIDES;
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, guides: filtered, unavailable: true, fallback: true }),
    };
  }

  // 결과가 비어있으면 fallback (테이블은 있지만 아직 시드 안 됨)
  if (!data || data.length === 0) {
    const filtered = market ? FALLBACK_GUIDES.filter((g) => g.market === market) : FALLBACK_GUIDES;
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, guides: filtered, fallback: true }),
    };
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ success: true, guides: data }),
  };
};
