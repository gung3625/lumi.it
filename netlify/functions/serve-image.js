// Instagram/Meta crawler용 이미지 프록시.
// 목적: Supabase Storage 도메인이 IG에서 fetch 차단됨 → lumi.it.kr (Meta 승인 도메인)으로 우회.
// 라우트: /ig-img/<bucket>/<path...>  (netlify.toml redirect 매핑)
// 응답: Supabase storage에서 바이너리 스트림 → Content-Type 그대로 전달.
const SUPA_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

// 허용된 버킷 목록 (실제 사용 버킷만)
const ALLOWED_BUCKETS = new Set(['link-assets', 'reservation-images', 'ig-media']);

const BASE_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=3600',
};

exports.handler = async (event) => {
  try {
    // path 예: /ig-img/link-assets/promo/1776887626000-raw-flower-v2.jpg
    const raw = (event.path || '').replace(/^\/ig-img\//, '').replace(/^\//, '');
    if (!raw) return { statusCode: 400, headers: BASE_HEADERS, body: 'missing path' };

    const firstSlash = raw.indexOf('/');
    if (firstSlash < 0) return { statusCode: 400, headers: BASE_HEADERS, body: 'bad path' };
    const bucket = raw.slice(0, firstSlash);
    const objectPath = raw.slice(firstSlash + 1);

    // path traversal / double-slash 방어
    if (!objectPath || objectPath.includes('..') || objectPath.includes('//')) {
      return { statusCode: 400, headers: BASE_HEADERS, body: 'bad path' };
    }

    // 안전: 버킷 이름은 소문자/숫자/하이픈만 허용
    if (!/^[a-z0-9-]+$/.test(bucket)) {
      return { statusCode: 400, headers: BASE_HEADERS, body: 'bad bucket' };
    }

    // 버킷 화이트리스트 검사
    if (!ALLOWED_BUCKETS.has(bucket)) {
      return { statusCode: 403, headers: BASE_HEADERS, body: 'forbidden bucket' };
    }

    const sourceUrl = `${SUPA_URL}/storage/v1/object/public/${bucket}/${objectPath}`;
    const res = await fetch(sourceUrl, {
      headers: { 'apikey': ANON_KEY },
    });

    if (!res.ok) {
      return { statusCode: res.status, headers: BASE_HEADERS, body: 'not found' };
    }

    const arrayBuffer = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    const contentType = res.headers.get('content-type') || 'application/octet-stream';

    return {
      statusCode: 200,
      headers: { ...BASE_HEADERS, 'Content-Type': contentType },
      body: buf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error('[serve-image] 예외:', err.message);
    return { statusCode: 500, headers: BASE_HEADERS, body: 'error' };
  }
};
