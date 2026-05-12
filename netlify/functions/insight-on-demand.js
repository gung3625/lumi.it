// 단건 게시물 IG 인사이트 — dashboard 게시물 카드 클릭 시 상세 패널/모달용
// GET /api/insight-on-demand?mediaId=<ig-media-id>
// 헤더: Authorization: Bearer <jwt> (Supabase JWT 우선, seller-jwt fallback)
//
// 응답:
// {
//   "ok": true,
//   "data": {
//     "mediaId": "...",
//     "mediaType": "IMAGE|VIDEO|REEL|CAROUSEL_ALBUM",
//     "permalink": "https://...",
//     "thumbnail": "...",
//     "caption": "...",
//     "timestamp": "2026-...",
//     "metrics": {
//       "likes": 123,
//       "comments": 4,
//       "reach": 5678,
//       "impressions": 9999,
//       "engagement": 234,
//       "saved": 12,
//       "videoViews": 0   // VIDEO/REEL 만
//     }
//   }
// }
//
// IG 미연동:        { ok: true, data: null, message: 'IG 미연동' }                (200)
// 토큰 만료:        { ok: true, data: null, error: 'token_expired' }              (200)
// mediaId 누락:     { ok: false, error: 'mediaId 누락' }                          (400)
// 잘못된 mediaId:   { ok: false, error: 'media_not_found' }                       (404)
// 인증 실패:        { ok: false, error: '인증이 필요합니다.' }                    (401)
// 그 외 IG 오류:    { ok: false, error: '...' }                                   (502)
//
// 캐시: Netlify Blobs `insights/media/<mediaId>.json`, TTL 15분 (단건이라 짧게)
// 보안:
//   - mediaId 외부 입력 → 영숫자/`_`/`-` 만 허용 (sanitize). 그 외 모두 400.
//   - sellers.id = auth.users.id = public.users.id invariant 활용
//   - access_token 은 절대 응답·로그에 노출 X
//   - 본인 sellerId 의 ig_accounts 행에서 받은 page/access_token 으로만 호출
//     → IG Graph API 가 자체적으로 owner mismatch 차단 (다른 사용자 media 접근 시 권한 에러)

const { getStore } = require('@netlify/blobs');
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const {
  getIgTokenForSeller,
  igGraphRequest,
  IgGraphError,
  markIgTokenInvalid,
} = require('./_shared/ig-graph');

const CACHE_TTL_MS = 15 * 60 * 1000; // 15분 (단건 단기)
// IG media id: 보통 숫자(긴 정수), 일부 환경에서 underscore/hyphen 포함 가능 → 보수적으로 영숫자/_/- 허용
const MEDIA_ID_RE = /^[A-Za-z0-9_-]{3,64}$/;

function getCacheStore() {
  return getStore({
    name: 'insights',
    consistency: 'strong',
    siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
    token: process.env.NETLIFY_TOKEN,
  });
}

async function readCache(mediaId) {
  try {
    const store = getCacheStore();
    const raw = await store.get(`media/${mediaId}`, { type: 'json' });
    if (!raw || !raw.cachedAt) return null;
    if (Date.now() - new Date(raw.cachedAt).getTime() > CACHE_TTL_MS) return null;
    return raw.data;
  } catch (e) {
    console.warn('[insight-on-demand] cache read 무시:', e && e.message);
    return null;
  }
}

async function writeCache(mediaId, data) {
  try {
    const store = getCacheStore();
    await store.setJSON(`media/${mediaId}`, {
      cachedAt: new Date().toISOString(),
      data,
    });
  } catch (e) {
    console.warn('[insight-on-demand] cache write 무시:', e && e.message);
  }
}

// /{mediaId}?fields=... — media 자체 메타 정보
async function fetchMediaMeta(mediaId, token) {
  return igGraphRequest(token, `/${mediaId}`, {
    fields: 'id,like_count,comments_count,timestamp,media_type,caption,permalink,thumbnail_url,media_url',
  });
}

// /{mediaId}/insights?metric=... — 단건 인사이트
// IMAGE/CAROUSEL : impressions,reach,engagement,saved
// VIDEO/REEL     : impressions,reach,engagement,saved,video_views
// metric_type 은 단건 media insights 에는 불필요 (계정 단위에서만 요구).
async function fetchMediaInsights(mediaId, mediaType, token) {
  const metrics = ['impressions', 'reach', 'engagement', 'saved'];
  const isVideoLike = mediaType === 'VIDEO' || mediaType === 'REEL' || mediaType === 'REELS';
  if (isVideoLike) metrics.push('video_views');

  try {
    const resp = await igGraphRequest(token, `/${mediaId}/insights`, {
      metric: metrics.join(','),
    });
    const out = { reach: 0, impressions: 0, engagement: 0, saved: 0 };
    if (isVideoLike) out.videoViews = 0;
    for (const m of resp.data || []) {
      let val = 0;
      if (m.values && Array.isArray(m.values) && m.values.length) {
        val = Number(m.values[m.values.length - 1].value || 0);
      } else if (m.total_value && typeof m.total_value.value === 'number') {
        val = Number(m.total_value.value || 0);
      }
      switch (m.name) {
        case 'reach': out.reach = val; break;
        case 'impressions': out.impressions = val; break;
        case 'engagement': out.engagement = val; break;
        case 'saved': out.saved = val; break;
        case 'video_views': out.videoViews = val; break;
        default: break;
      }
    }
    return out;
  } catch (e) {
    if (e instanceof IgGraphError && e.isTokenExpired()) throw e;
    // 일부 메트릭 미지원/권한 부재 → 0 으로 graceful
    console.warn('[insight-on-demand] media insights 조회 경고:', e && e.message);
    const fallback = { reach: 0, impressions: 0, engagement: 0, saved: 0 };
    if (isVideoLike) fallback.videoViews = 0;
    return fallback;
  }
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
  }

  // mediaId 파싱 + sanitize
  const rawMediaId = (event.queryStringParameters && event.queryStringParameters.mediaId) || '';
  const mediaId = String(rawMediaId).trim();
  if (!mediaId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'mediaId 누락' }) };
  }
  if (!MEDIA_ID_RE.test(mediaId)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'mediaId 형식이 잘못되었습니다.' }) };
  }

  const token = extractBearerToken(event);
  if (!token) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: '인증이 필요합니다.' }) };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[insight-on-demand] admin client 초기화 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: '서버 설정 오류입니다.' }) };
  }

  // 1) Supabase JWT 우선 — auth.users.id 가 곧 sellers.id
  let sellerId = null;
  try {
    const { data: supaAuthData } = await admin.auth.getUser(token);
    if (supaAuthData && supaAuthData.user && supaAuthData.user.id) {
      sellerId = supaAuthData.user.id;
    }
  } catch (_) { /* fallthrough */ }

  // 2) seller-jwt fallback (HS256)
  if (!sellerId) {
    const { payload, error: authErr } = verifySellerToken(token);
    if (authErr || !payload) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: '인증이 만료되었습니다.' }) };
    }
    sellerId = payload.seller_id;
  }

  if (!sellerId) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: '인증이 필요합니다.' }) };
  }

  // 캐시 hit (mediaId 단위) — sellerId 까지 묶을 수도 있으나, IG media id 자체가 전역 유니크라 mediaId 만으로 충분
  const cached = await readCache(mediaId);
  if (cached) {
    return {
      statusCode: 200,
      headers: { ...CORS, 'X-Insight-Cache': 'hit' },
      body: JSON.stringify({ ok: true, data: cached }),
    };
  }

  // IG 토큰 조회
  const igCtx = await getIgTokenForSeller(sellerId, admin);
  if (!igCtx) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, data: null, message: 'IG 미연동' }),
    };
  }

  try {
    // 1) media 메타 먼저 — media_type 분기 위해 직렬 호출
    let meta;
    try {
      meta = await fetchMediaMeta(mediaId, igCtx.accessToken);
    } catch (e) {
      if (e instanceof IgGraphError && e.isTokenExpired()) {
        console.warn(`[insight-on-demand] seller=${String(sellerId).slice(0, 8)} 토큰 만료 (code=${e.code})`);
        await markIgTokenInvalid(admin, sellerId, 'insight-on-demand');
        return {
          statusCode: 200,
          headers: CORS,
          body: JSON.stringify({ ok: true, data: null, error: 'token_expired' }),
        };
      }
      // 권한 없음 / 잘못된 mediaId — 보통 code 100 (Object does not exist) / 803 등
      // status 4xx 면 not_found 로 통합
      if (e instanceof IgGraphError && e.status && e.status >= 400 && e.status < 500) {
        console.warn(`[insight-on-demand] seller=${String(sellerId).slice(0, 8)} media=${mediaId} not_found (code=${e.code})`);
        return {
          statusCode: 404,
          headers: CORS,
          body: JSON.stringify({ ok: false, error: 'media_not_found' }),
        };
      }
      throw e;
    }

    const mediaType = meta && meta.media_type ? String(meta.media_type) : 'IMAGE';

    // 2) 인사이트 호출 (media_type 결정 후)
    const ins = await fetchMediaInsights(mediaId, mediaType, igCtx.accessToken);

    const metrics = {
      likes: Number(meta.like_count || 0),
      comments: Number(meta.comments_count || 0),
      reach: Number(ins.reach || 0),
      impressions: Number(ins.impressions || 0),
      engagement: Number(ins.engagement || 0),
      saved: Number(ins.saved || 0),
    };
    if (mediaType === 'VIDEO' || mediaType === 'REEL' || mediaType === 'REELS') {
      metrics.videoViews = Number(ins.videoViews || 0);
    }

    const data = {
      mediaId: meta.id || mediaId,
      mediaType,
      permalink: meta.permalink || null,
      thumbnail: meta.thumbnail_url || meta.media_url || null,
      caption: meta.caption || null,
      timestamp: meta.timestamp || null,
      metrics,
    };

    await writeCache(mediaId, data);

    console.log(
      `[insight-on-demand] seller=${String(sellerId).slice(0, 8)} media=${mediaId} type=${mediaType} likes=${metrics.likes} reach=${metrics.reach}`
    );

    return {
      statusCode: 200,
      headers: { ...CORS, 'X-Insight-Cache': 'miss' },
      body: JSON.stringify({ ok: true, data }),
    };
  } catch (e) {
    if (e instanceof IgGraphError && e.isTokenExpired()) {
      console.warn(`[insight-on-demand] seller=${String(sellerId).slice(0, 8)} 토큰 만료 (code=${e.code})`);
      await markIgTokenInvalid(admin, sellerId, 'insight-on-demand');
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ ok: true, data: null, error: 'token_expired' }),
      };
    }
    console.error('[insight-on-demand] IG Graph API 오류:', e && e.message);
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: 'IG 인사이트 조회 실패', detail: e && e.message ? e.message : null }),
    };
  }
};
