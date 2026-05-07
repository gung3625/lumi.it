// 관리자 통계 dashboard — brand-admin.html 통계 카드 backing endpoint.
// GET /api/brand-stats
// 헤더: Authorization: Bearer <jwt> (Supabase JWT — 관리자 계정만)
//
// 인증:
//   - Supabase JWT 검증 → users.is_admin = true 확인 (admin-guard.js)
//   - 환경변수 폴백 admin (LUMI_ADMIN_EMAILS / FALLBACK_ADMIN_IDS) 도 통과
//   - 비관리자: 403
//
// 응답:
// {
//   "ok": true,
//   "data": {
//     "sellers":      { "total", "today", "thisWeek", "thisMonth", "deletionPending" },
//     "reservations": { "total", "thisMonth", "posted" },
//     "integrations": { "instagram", "tiktok" },
//     "captions":     { "total", "thisMonth", "lastCreatedAt" },
//     "feedback":     { "thisMonth" },
//     "generatedAt":  "2026-05-07T..."
//   },
//   "cached": false
// }
//
// 캐시: Netlify Blobs `brand-stats/all`, TTL 5분.
// 데이터 소스 (모두 Service role — RLS 우회):
//   - sellers (total / signup_completed_at 일·주·월 / deletion_requested_at 진행 중)
//   - reservations (total / created_at 이번달 / status='posted' or is_sent=true)
//   - ig_accounts.user_id distinct count
//   - tiktok_accounts.seller_id distinct count
//   - caption_history total + 이번달 + 가장 최근 created_at
//   - tone_feedback 이번달 (재학습 피드백 수)
//
// 일부 테이블이 없거나 컬럼 mismatch면 0 반환 — 통계 자체는 깨지지 않음.

const { getStore } = require('@netlify/blobs');
const { getAdminClient } = require('./_shared/supabase-admin');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { requireAdmin } = require('./_shared/admin-guard');

const CACHE_TTL_MS = 5 * 60 * 1000; // 5분

function getCacheStore() {
  return getStore({
    name: 'brand-stats',
    consistency: 'strong',
    siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
    token: process.env.NETLIFY_TOKEN,
  });
}

async function readCache() {
  try {
    const store = getCacheStore();
    const raw = await store.get('all', { type: 'json' });
    if (!raw || !raw.cachedAt) return null;
    if (Date.now() - new Date(raw.cachedAt).getTime() > CACHE_TTL_MS) return null;
    return raw.data;
  } catch (e) {
    console.warn('[brand-stats] cache read 무시:', e && e.message);
    return null;
  }
}

async function writeCache(data) {
  try {
    const store = getCacheStore();
    await store.setJSON('all', {
      cachedAt: new Date().toISOString(),
      data,
    });
  } catch (e) {
    console.warn('[brand-stats] cache write 무시:', e && e.message);
  }
}

// 안전한 count(*) — 테이블 부재/컬럼 mismatch 시 0 반환.
async function safeCount(admin, table, applyFilters) {
  try {
    let q = admin.from(table).select('*', { count: 'exact', head: true });
    if (typeof applyFilters === 'function') q = applyFilters(q);
    const { count, error } = await q;
    if (error) {
      console.warn(`[brand-stats] ${table} count 경고:`, error.message);
      return 0;
    }
    return count || 0;
  } catch (e) {
    console.warn(`[brand-stats] ${table} count 예외:`, e && e.message);
    return 0;
  }
}

// distinct user_id count — RPC 없이 select + Set으로 (적은 row 가정).
async function safeDistinctCount(admin, table, column) {
  try {
    const { data, error } = await admin.from(table).select(column);
    if (error) {
      console.warn(`[brand-stats] ${table} distinct 경고:`, error.message);
      return 0;
    }
    const set = new Set();
    for (const row of data || []) {
      const v = row && row[column];
      if (v) set.add(String(v));
    }
    return set.size;
  } catch (e) {
    console.warn(`[brand-stats] ${table} distinct 예외:`, e && e.message);
    return 0;
  }
}

async function safeLatest(admin, table, orderColumn) {
  try {
    const { data, error } = await admin
      .from(table)
      .select(orderColumn)
      .order(orderColumn, { ascending: false })
      .limit(1);
    if (error) {
      console.warn(`[brand-stats] ${table} latest 경고:`, error.message);
      return null;
    }
    if (!data || !data.length) return null;
    return data[0][orderColumn] || null;
  } catch (e) {
    console.warn(`[brand-stats] ${table} latest 예외:`, e && e.message);
    return null;
  }
}

// KST 기준 날짜 경계 (00:00 KST → UTC ISO).
function kstStartOfTodayIso() {
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 3600 * 1000);
  const dayKey = kstNow.toISOString().slice(0, 10); // YYYY-MM-DD
  return new Date(`${dayKey}T00:00:00+09:00`).toISOString();
}

function kstStartOfThisWeekIso() {
  // 주 시작: 월요일 00:00 KST
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 3600 * 1000);
  const day = kstNow.getUTCDay(); // 0=일,1=월,...
  const offset = day === 0 ? 6 : day - 1;
  const monday = new Date(kstNow.getTime() - offset * 24 * 3600 * 1000);
  const dayKey = monday.toISOString().slice(0, 10);
  return new Date(`${dayKey}T00:00:00+09:00`).toISOString();
}

function kstStartOfThisMonthIso() {
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 3600 * 1000);
  const yy = kstNow.getUTCFullYear();
  const mm = String(kstNow.getUTCMonth() + 1).padStart(2, '0');
  return new Date(`${yy}-${mm}-01T00:00:00+09:00`).toISOString();
}

async function aggregate(admin) {
  const todayIso = kstStartOfTodayIso();
  const weekIso = kstStartOfThisWeekIso();
  const monthIso = kstStartOfThisMonthIso();

  const [
    sellersTotal,
    sellersToday,
    sellersThisWeek,
    sellersThisMonth,
    sellersDeletionPending,
    reservationsTotal,
    reservationsThisMonth,
    reservationsPosted,
    instagramConnected,
    tiktokConnected,
    captionsTotal,
    captionsThisMonth,
    captionsLast,
    feedbackThisMonth,
  ] = await Promise.all([
    safeCount(admin, 'sellers'),
    safeCount(admin, 'sellers', (q) => q.gte('signup_completed_at', todayIso)),
    safeCount(admin, 'sellers', (q) => q.gte('signup_completed_at', weekIso)),
    safeCount(admin, 'sellers', (q) => q.gte('signup_completed_at', monthIso)),
    safeCount(admin, 'sellers', (q) =>
      q.not('deletion_requested_at', 'is', null).is('deletion_cancelled_at', null)
    ),
    safeCount(admin, 'reservations'),
    safeCount(admin, 'reservations', (q) => q.gte('created_at', monthIso)),
    safeCount(admin, 'reservations', (q) => q.eq('is_sent', true)),
    safeDistinctCount(admin, 'ig_accounts', 'user_id'),
    safeDistinctCount(admin, 'tiktok_accounts', 'seller_id'),
    safeCount(admin, 'caption_history'),
    safeCount(admin, 'caption_history', (q) => q.gte('created_at', monthIso)),
    safeLatest(admin, 'caption_history', 'created_at'),
    safeCount(admin, 'tone_feedback', (q) => q.gte('created_at', monthIso)),
  ]);

  return {
    sellers: {
      total: sellersTotal,
      today: sellersToday,
      thisWeek: sellersThisWeek,
      thisMonth: sellersThisMonth,
      deletionPending: sellersDeletionPending,
    },
    reservations: {
      total: reservationsTotal,
      thisMonth: reservationsThisMonth,
      posted: reservationsPosted,
    },
    integrations: {
      instagram: instagramConnected,
      tiktok: tiktokConnected,
    },
    captions: {
      total: captionsTotal,
      thisMonth: captionsThisMonth,
      lastCreatedAt: captionsLast,
    },
    feedback: {
      thisMonth: feedbackThisMonth,
    },
    generatedAt: new Date().toISOString(),
  };
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: 'Method not allowed' }),
    };
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[brand-stats] admin client 초기화 실패:', e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: '서버 설정 오류입니다.' }),
    };
  }

  // 관리자 권한 체크
  const guard = await requireAdmin(event, admin);
  if (!guard.ok) {
    return {
      statusCode: guard.status,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: guard.error }),
    };
  }

  // 캐시 확인 (5분)
  const cached = await readCache();
  if (cached) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, data: cached, cached: true }),
    };
  }

  try {
    const data = await aggregate(admin);
    // best-effort 캐시 저장 (실패 무시)
    await writeCache(data);

    console.log(
      `[brand-stats] admin=${String(guard.user.id).slice(0, 8)} sellers=${data.sellers.total} reservations=${data.reservations.total} captions=${data.captions.total}`
    );

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, data, cached: false }),
    };
  } catch (e) {
    console.error('[brand-stats] aggregate 실패:', e && e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: '통계 집계 실패' }),
    };
  }
};
