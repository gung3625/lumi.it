// 월간 IG 인사이트 — dashboard 좋아요/도달/팔로워/노출 stat 카드용
// GET /api/insight-monthly
// 헤더: Authorization: Bearer <jwt> (Supabase JWT 우선, seller-jwt fallback)
//
// 응답:
// {
//   "ok": true,
//   "data": {
//     "period": "monthly",
//     "rangeStart": "2026-04-07",
//     "rangeEnd":   "2026-05-07",
//     "followers": 1234,
//     "mediaCount": 28,
//     "likesTotal": 4567,
//     "commentsTotal": 89,
//     "reach": 12345,
//     "profileViews": 678,
//     "followersChange": null,
//     "ig": { "username": "..." }
//   }
// }
//
// IG 미연동: { ok: true, data: null, message: 'IG 미연동' }
// 토큰 만료: { ok: true, data: null, error: 'token_expired' }
// 그 외 IG 오류: { ok: false, error: '...' } (5xx)
//
// 캐시: Netlify Blobs `insights/monthly/<sellerId>.json`, TTL 1시간
// 보안:
//   - sellers.id = auth.users.id = public.users.id 라는 invariant 활용
//   - access_token 은 절대 응답·로그에 노출 X
//   - 본인 sellerId 의 ig_accounts 행만 조회

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
const {
  getThreadsTokenForSeller,
  getThreadsAccountInsights,
  markThreadsTokenInvalid,
  ThreadsGraphError,
} = require('./_shared/threads-graph');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1시간
const RANGE_DAYS = 30;

function ymd(d) {
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function getCacheStore() {
  return getStore({
    name: 'insights',
    consistency: 'strong',
    siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
    token: process.env.NETLIFY_TOKEN,
  });
}

async function readCache(sellerId) {
  try {
    const store = getCacheStore();
    const raw = await store.get(`monthly/${sellerId}`, { type: 'json' });
    if (!raw || !raw.cachedAt) return null;
    if (Date.now() - new Date(raw.cachedAt).getTime() > CACHE_TTL_MS) return null;
    return raw.data;
  } catch (e) {
    // Blobs 미설정/네트워크 이슈 — 무시하고 cold path 진행
    console.warn('[insight-monthly] cache read 무시:', e && e.message);
    return null;
  }
}

async function writeCache(sellerId, data) {
  try {
    const store = getCacheStore();
    await store.setJSON(`monthly/${sellerId}`, {
      cachedAt: new Date().toISOString(),
      data,
    });
  } catch (e) {
    console.warn('[insight-monthly] cache write 무시:', e && e.message);
  }
}

// IG insights 호출 — 28일 윈도우.
// 사장님 보고 (2026-05-15): period=days_28 가 일부 계정에서 0 반환 → weekly 와 동일하게
// period=day + since/until 28일 + 클라이언트 합산 패턴으로 통일.
async function fetchAccountInsights(igUserId, token, sinceSec, untilSec) {
  try {
    const resp = await igGraphRequest(token, `/${igUserId}/insights`, {
      metric: 'reach,profile_views',
      period: 'day',
      metric_type: 'total_value',
      since: sinceSec,
      until: untilSec,
    });
    const out = { reach: 0, profileViews: 0 };
    for (const m of resp.data || []) {
      let total = 0;
      if (m.total_value && typeof m.total_value.value === 'number') {
        total = m.total_value.value;
      } else if (Array.isArray(m.values) && m.values.length) {
        total = m.values.reduce((s, v) => s + Number(v.value || 0), 0);
      }
      if (m.name === 'reach') out.reach = Number(total) || 0;
      else if (m.name === 'profile_views') out.profileViews = Number(total) || 0;
    }
    return out;
  } catch (e) {
    if (e instanceof IgGraphError && e.isTokenExpired()) throw e;
    console.warn('[insight-monthly] account insights 조회 경고:', e && e.message);
    return { reach: 0, profileViews: 0 };
  }
}

// 최근 30일 게시물의 like_count + comments_count 합산
async function fetchMediaSums(igUserId, token, sinceTs) {
  let likesTotal = 0;
  let commentsTotal = 0;
  let mediaCountInRange = 0;
  try {
    const resp = await igGraphRequest(token, `/${igUserId}/media`, {
      fields: 'id,like_count,comments_count,timestamp',
      limit: 50,
    });
    for (const m of resp.data || []) {
      if (!m.timestamp) continue;
      const t = new Date(m.timestamp).getTime();
      if (Number.isNaN(t) || t < sinceTs) continue;
      likesTotal += Number(m.like_count || 0);
      commentsTotal += Number(m.comments_count || 0);
      mediaCountInRange += 1;
    }
    return { likesTotal, commentsTotal, mediaCountInRange };
  } catch (e) {
    if (e instanceof IgGraphError && e.isTokenExpired()) throw e;
    console.warn('[insight-monthly] media 조회 경고:', e && e.message);
    return { likesTotal: 0, commentsTotal: 0, mediaCountInRange: 0 };
  }
}

// 계정 단위 followers/media count 스냅샷
async function fetchAccountSnapshot(igUserId, token) {
  try {
    const resp = await igGraphRequest(token, `/${igUserId}`, {
      fields: 'followers_count,media_count',
    });
    return {
      followers: Number(resp.followers_count || 0),
      mediaCountTotal: Number(resp.media_count || 0),
    };
  } catch (e) {
    if (e instanceof IgGraphError && e.isTokenExpired()) throw e;
    console.warn('[insight-monthly] account snapshot 조회 경고:', e && e.message);
    return { followers: 0, mediaCountTotal: 0 };
  }
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  if (!token) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: '인증이 필요합니다.' }) };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[insight-monthly] admin client 초기화 실패:', e.message);
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

  const now = new Date();
  const since = new Date(now.getTime() - RANGE_DAYS * 24 * 60 * 60 * 1000);
  const rangeStart = ymd(since);
  const rangeEnd = ymd(now);

  // 캐시 hit 시 즉시 반환
  const cached = await readCache(sellerId);
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

  // Graph API 병렬 호출
  try {
    const sinceSec = Math.floor(since.getTime() / 1000);
    const untilSec = Math.floor(now.getTime() / 1000);
    const [snapshot, insights, mediaSums] = await Promise.all([
      fetchAccountSnapshot(igCtx.igUserId, igCtx.accessToken),
      fetchAccountInsights(igCtx.igUserId, igCtx.accessToken, sinceSec, untilSec),
      fetchMediaSums(igCtx.igUserId, igCtx.accessToken, since.getTime()),
    ]);

    // M4.2 — Threads 사장님 단위 인사이트 (있으면). insight-weekly.js 패턴 동일.
    let threadsBlock = null;
    try {
      const threadsCtx = await getThreadsTokenForSeller(sellerId, admin);
      if (threadsCtx) {
        const { data: trow } = await admin
          .from('ig_accounts')
          .select('threads_token_invalid_at')
          .eq('user_id', sellerId)
          .maybeSingle();
        if (!trow || !trow.threads_token_invalid_at) {
          const ti = await getThreadsAccountInsights({
            token: threadsCtx.accessToken,
            threadsUserId: threadsCtx.threadsUserId,
            sinceSec,
            untilSec,
          });
          threadsBlock = { ...ti, connected: true, tokenExpired: false };
        } else {
          threadsBlock = { views: 0, likes: 0, replies: 0, reposts: 0, quotes: 0, connected: true, tokenExpired: true };
        }
      }
    } catch (te) {
      if (te instanceof ThreadsGraphError && te.isTokenExpired()) {
        try { await markThreadsTokenInvalid(admin, sellerId, 'insight-monthly'); } catch (_) {}
        threadsBlock = { views: 0, likes: 0, replies: 0, reposts: 0, quotes: 0, connected: true, tokenExpired: true };
      } else {
        console.warn('[insight-monthly] Threads insights 실패 (무시):', te && te.message);
      }
    }

    const data = {
      period: 'monthly',
      rangeStart,
      rangeEnd,
      followers: snapshot.followers,
      mediaCount: mediaSums.mediaCountInRange,
      likesTotal: mediaSums.likesTotal,
      commentsTotal: mediaSums.commentsTotal,
      reach: insights.reach,
      profileViews: insights.profileViews,
      followersChange: null,
      ig: { username: igCtx.igUsername || null },
      threads: threadsBlock,
    };

    // 캐시 저장 (실패 무시)
    await writeCache(sellerId, data);

    console.log(
      `[insight-monthly] seller=${String(sellerId).slice(0, 8)} followers=${data.followers} media=${data.mediaCount} likes=${data.likesTotal} reach=${data.reach}`
    );

    return {
      statusCode: 200,
      headers: { ...CORS, 'X-Insight-Cache': 'miss' },
      body: JSON.stringify({ ok: true, data }),
    };
  } catch (e) {
    if (e instanceof IgGraphError && e.isTokenExpired()) {
      console.warn(`[insight-monthly] seller=${String(sellerId).slice(0, 8)} 토큰 만료 (code=${e.code})`);
      await markIgTokenInvalid(admin, sellerId, 'insight-monthly');
      return {
        statusCode: 200,
        headers: CORS,
        // tokenExpired: true 추가 — 응답 키 통일 (PR #169). error 는 옛 호환용 유지.
        body: JSON.stringify({ ok: true, data: null, tokenExpired: true, error: 'token_expired' }),
      };
    }
    console.error('[insight-monthly] IG Graph API 오류:', e && e.message);
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: 'IG 인사이트 조회 실패', detail: e && e.message ? e.message : null }),
    };
  }
};
