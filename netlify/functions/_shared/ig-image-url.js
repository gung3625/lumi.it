// Supabase Storage public URL → lumi.it.kr 프록시 URL 변환.
// Instagram Graph API가 Supabase 도메인을 fetch 못하는 문제(2026-04-22 발생) 우회용.
const PROXY_BASE = 'https://lumi.it.kr/ig-img';

function toProxyUrl(supabaseUrl) {
  if (!supabaseUrl || typeof supabaseUrl !== 'string') return supabaseUrl;
  // 이미 프록시 URL이면 그대로
  if (supabaseUrl.startsWith(PROXY_BASE)) return supabaseUrl;
  // Supabase public URL 패턴만 변환: /storage/v1/object/public/<bucket>/<path...>
  const m = supabaseUrl.match(/\/storage\/v1\/object\/public\/([^?]+)/);
  if (!m) return supabaseUrl;
  return `${PROXY_BASE}/${m[1]}`;
}

module.exports = { toProxyUrl };
