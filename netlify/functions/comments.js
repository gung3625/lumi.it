// comments.js — 사장님 인스타 게시물 최근 댓글 모음
// GET /api/comments?limit=50
// 헤더: Authorization: Bearer <jwt>
//
// 응답:
//   IG 미연동:   { ok: true, igConnected: false, items: [] }
//   토큰 만료:   { ok: true, igConnected: true, tokenExpired: true, items: [] }
//   정상:        { ok: true, igConnected: true, items: [{ id, username, text, timestamp, reply_text, permalink }, ...] }
//
// 동작:
//  1) 단일 Graph 호출 — /{ig-user-id}/media?fields=...,comments{...,replies{...}}&limit=15
//     필드 확장으로 미디어 15개 × 댓글 20개 + 답글 5개를 한 번에. rate limit 절감.
//  2) 평탄화 + timestamp 역순 정렬. 사장님 본인이 단 답글은 부모 댓글에 reply_text 로 머지하고
//     목록에선 제외 (UI 에서 답글 줄로 표시).
//  3) Netlify Blobs 캐시 TTL 5분 (sellers/<id>.json).

'use strict';

const { getStore } = require('@netlify/blobs');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { getAdminClient } = require('./_shared/supabase-admin');
const { getIgTokenForSeller, igGraphRequest, IgGraphError } = require('./_shared/ig-graph');
const {
  getThreadsTokenForSeller,
  threadsGraphRequest,
  markThreadsTokenInvalid,
  ThreadsGraphError,
} = require('./_shared/threads-graph');

// TTL 2분 — IG 에서 댓글 삭제·신규 시 사장님 체감 신선도 ↑.
// reply-comment.js 가 답글 직후 즉시 무효화하지만 사장님이 IG 앱에서 직접
// 단/지운 케이스는 캐시 만료까지 안 보임. 5분 → 2분 (Graph rate limit 영향 미미).
const CACHE_TTL_MS = 2 * 60 * 1000;
const MEDIA_LIMIT = 15;
const COMMENTS_PER_MEDIA = 20;
const REPLIES_PER_COMMENT = 5;
// M4.1 — Threads 측 limit (별도 — IG 와 호출 비용 분리)
const THREADS_LIMIT = 15;
const REPLIES_PER_THREAD = 10;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function getCacheStore() {
  return getStore({
    name: 'comments',
    consistency: 'eventual',
    siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
    token: process.env.NETLIFY_TOKEN,
  });
}

async function readCache(sellerId) {
  try {
    const raw = await getCacheStore().get(`sellers/${sellerId}.json`, { type: 'json' });
    if (!raw || !raw.cachedAt) return null;
    if (Date.now() - new Date(raw.cachedAt).getTime() > CACHE_TTL_MS) return null;
    // M4.1 — 캐시 shape 가 옛 형식 (배열) 이면 무시 (자연스럽게 새로 채워짐)
    if (Array.isArray(raw.data)) return null;
    if (!raw.data || !Array.isArray(raw.data.items)) return null;
    return raw.data;
  } catch (e) {
    console.warn('[comments] cache read 무시:', e && e.message);
    return null;
  }
}

async function writeCache(sellerId, data) {
  try {
    await getCacheStore().setJSON(`sellers/${sellerId}.json`, {
      cachedAt: new Date().toISOString(),
      data,
    });
  } catch (e) {
    console.warn('[comments] cache write 무시:', e && e.message);
  }
}

// 사장님 본인 username 정규화 — 대소문자 무시, 앞 @ 제거.
function normalizeHandle(s) {
  if (!s || typeof s !== 'string') return '';
  return s.trim().replace(/^@+/, '').toLowerCase();
}

// IG Graph 응답 → 평탄화된 댓글 배열.
// 사장님 본인 답글은 부모 댓글의 reply_text 로 묶고 목록에선 제외.
function flattenComments(mediaList, ownerHandle) {
  const items = [];
  for (const media of mediaList || []) {
    const permalink = media.permalink || '';
    // 게시물 썸네일: VIDEO/REELS 는 thumbnail_url, 사진은 media_url.
    const isVideo = media.media_type === 'VIDEO' || media.media_type === 'REELS';
    const postThumb = isVideo ? (media.thumbnail_url || '') : (media.media_url || '');
    // 캡션 미리보기 — 줄바꿈/공백 정리 후 40자.
    const postCaption = String(media.caption || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const comments = (media.comments && media.comments.data) || [];
    for (const c of comments) {
      const handle = normalizeHandle(c.username);
      // 사장님 본인이 직접 단 댓글 (답글 아닌 최상위) → 목록에서 제외.
      // 댓글창에 사장님이 자기 게시물에 댓글로 부연설명한 케이스. 사장님이 받은 댓글이 아니라 본인이 한 말.
      if (ownerHandle && handle === ownerHandle) continue;
      // 답글 중 사장님이 단 것을 reply_text 로 추출 (가장 최근 1개).
      const replies = (c.replies && c.replies.data) || [];
      let replyText = '';
      for (const r of replies) {
        if (ownerHandle && normalizeHandle(r.username) === ownerHandle) {
          replyText = r.text || '';
          // break 하지 않음 — 마지막에 단 답글로 덮어쓰기 (replies 는 시간 오름차순)
        }
      }
      items.push({
        id: c.id || '',
        username: c.username || '',
        text: c.text || '',
        timestamp: c.timestamp || '',
        reply_text: replyText,
        permalink,
        post_thumb: postThumb,
        post_caption: postCaption,
        channel: 'ig',
      });
    }
  }
  // timestamp 역순 정렬 (최신 위로). 빈 timestamp 는 뒤로.
  items.sort((a, b) => {
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return b.timestamp.localeCompare(a.timestamp);
  });
  return items;
}

// Threads replies 평탄화. IG flattenComments 와 1:1 대응.
// ownerHandle 은 ig_accounts.threads_username (우선) 또는 IG username (fallback).
// 'reply_text' (사장님 본인 답글의 답글) 는 별도 호출 필요 — 현재 빈 값 유지.
function flattenThreadsComments(threadsList, ownerHandle) {
  const items = [];
  for (const thread of threadsList || []) {
    const permalink = thread.permalink || '';
    const isVideo = thread.media_type === 'VIDEO';
    const postThumb = isVideo ? (thread.thumbnail_url || '') : (thread.media_url || '');
    const postCaption = String(thread.text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const replies = (thread.replies && thread.replies.data) || [];
    for (const r of replies) {
      const handle = normalizeHandle(r.username);
      if (ownerHandle && handle === ownerHandle) continue;
      items.push({
        id: r.id || '',
        username: r.username || '',
        text: r.text || '',
        timestamp: r.timestamp || '',
        reply_text: '',   // Threads 답글의 답글 통합은 M4.2 후속
        permalink,
        post_thumb: postThumb,
        post_caption: postCaption,
        channel: 'threads',
      });
    }
  }
  return items;
}

async function fetchCommentsFromGraph(igCtx) {
  // 필드 확장 — Graph v25 가 comments{} / replies{} 중첩 확장을 지원.
  // 동작 안 하면 다음 단계: /{media}/comments 로 N+1 호출 fallback.
  // post_thumb 용으로 media_type/media_url/thumbnail_url 추가 (사장님이 어느 게시물 댓글인지 식별).
  const fields = [
    'id',
    'permalink',
    'timestamp',
    'media_type',
    'media_url',
    'thumbnail_url',
    'caption',
    `comments.limit(${COMMENTS_PER_MEDIA}){id,text,username,timestamp,replies.limit(${REPLIES_PER_COMMENT}){id,text,username,timestamp}}`,
  ].join(',');
  const resp = await igGraphRequest(igCtx.accessToken, `/${igCtx.igUserId}/media`, {
    fields,
    limit: MEDIA_LIMIT,
  });
  return resp && resp.data ? resp.data : [];
}

// M4.1 — Threads replies fetch (IG fetchCommentsFromGraph 와 동일 패턴).
// 필드 확장 시도. 실패 시 호출자에서 catch.
async function fetchThreadsRepliesFromGraph(threadsCtx) {
  const fields = [
    'id',
    'permalink',
    'timestamp',
    'media_type',
    'media_url',
    'thumbnail_url',
    'text',
    `replies.limit(${REPLIES_PER_THREAD}){id,text,username,timestamp}`,
  ].join(',');
  const resp = await threadsGraphRequest(threadsCtx.accessToken, `/${threadsCtx.threadsUserId}/threads`, {
    fields,
    limit: THREADS_LIMIT,
  });
  return resp && resp.data ? resp.data : [];
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user || !user.id) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  const qs = event.queryStringParameters || {};
  const parsedLimit = parseInt(qs.limit, 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, MAX_LIMIT)
    : DEFAULT_LIMIT;

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    console.error('[comments] admin 초기화 실패:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류' }) };
  }

  // M4.1 — IG + Threads 둘 다 시도. 한쪽 실패해도 다른 쪽은 진행.
  // 응답 shape: { ok, igConnected, tokenExpired, threadsConnected, threadsTokenExpired, items, cached? }
  // 각 item 은 channel: 'ig' | 'threads' 태그됨.

  const forceRefresh = qs.refresh === '1' || qs.refresh === 'true';

  // 캐시 hit (refresh 시 스킵)
  const cached = !forceRefresh ? await readCache(user.id) : null;
  if (cached) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        igConnected:          cached.igConnected || false,
        tokenExpired:         cached.tokenExpired || false,
        threadsConnected:     cached.threadsConnected || false,
        threadsTokenExpired:  cached.threadsTokenExpired || false,
        cached: true,
        items: cached.items.slice(0, limit),
      }),
    };
  }

  // ──────────────────────────────────────────────
  // 1) IG / Threads 연동 상태 + 사전 차단 플래그 동시 조회
  // ──────────────────────────────────────────────
  const igCtx      = await getIgTokenForSeller(user.id, admin);
  const threadsCtx = await getThreadsTokenForSeller(user.id, admin);

  let igInvalidAt      = null;
  let threadsInvalidAt = null;
  let threadsUsername  = null;
  try {
    const { data: row } = await admin
      .from('ig_accounts')
      .select('token_invalid_at, threads_token_invalid_at, threads_username')
      .eq('user_id', user.id)
      .maybeSingle();
    if (row) {
      igInvalidAt      = row.token_invalid_at || null;
      threadsInvalidAt = row.threads_token_invalid_at || null;
      threadsUsername  = row.threads_username || null;
    }
  } catch (_) { /* 사전 차단 못 해도 진행 — Graph 가 실패 → mark 함 */ }

  const igConnected         = !!igCtx;
  const igTokenExpired      = igConnected && !!igInvalidAt;
  const threadsConnected    = !!threadsCtx;
  const threadsTokenExpired = threadsConnected && !!threadsInvalidAt;

  // 둘 다 미연동이면 즉시 빈 응답
  if (!igConnected && !threadsConnected) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, igConnected: false, threadsConnected: false, items: [] }),
    };
  }

  // ──────────────────────────────────────────────
  // 2) IG / Threads Graph 병렬 호출 — 각각 독립 try/catch
  // ──────────────────────────────────────────────
  const ownerIgHandle      = normalizeHandle(igCtx?.igUsername);
  const ownerThreadsHandle = normalizeHandle(threadsUsername) || ownerIgHandle;

  const igPromise = (async () => {
    if (!igConnected || igTokenExpired) return [];
    try {
      const mediaList = await fetchCommentsFromGraph(igCtx);
      return flattenComments(mediaList, ownerIgHandle);
    } catch (e) {
      if (e instanceof IgGraphError && e.isTokenExpired()) {
        try {
          await admin.from('ig_accounts').update({ token_invalid_at: new Date().toISOString() }).eq('user_id', user.id);
        } catch (_) { /* noop */ }
        return { _expired: true };
      }
      console.warn('[comments] IG Graph 호출 실패:', e && e.message);
      return [];
    }
  })();

  const threadsPromise = (async () => {
    if (!threadsConnected || threadsTokenExpired) return [];
    try {
      const threadsList = await fetchThreadsRepliesFromGraph(threadsCtx);
      // Threads 본인 핸들 — ig_accounts.threads_username 우선, 없으면 IG 핸들 fallback.
      return flattenThreadsComments(threadsList, ownerThreadsHandle);
    } catch (e) {
      if (e instanceof ThreadsGraphError && e.isTokenExpired()) {
        try { await markThreadsTokenInvalid(admin, user.id, 'comments'); } catch (_) { /* noop */ }
        return { _expired: true };
      }
      console.warn('[comments] Threads Graph 호출 실패:', e && e.message);
      return [];
    }
  })();

  const [igResult, threadsResult] = await Promise.all([igPromise, threadsPromise]);

  // 토큰 만료 발견 시 응답에 반영 (사전 차단 안 됐던 케이스 — 첫 호출에서 발견)
  const finalIgTokenExpired      = igTokenExpired      || (igResult      && igResult._expired);
  const finalThreadsTokenExpired = threadsTokenExpired || (threadsResult && threadsResult._expired);

  const igItems      = Array.isArray(igResult)      ? igResult      : [];
  const threadsItems = Array.isArray(threadsResult) ? threadsResult : [];

  // ──────────────────────────────────────────────
  // 3) merge + 시간 역순 정렬
  // ──────────────────────────────────────────────
  const items = [...igItems, ...threadsItems];
  items.sort((a, b) => {
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return b.timestamp.localeCompare(a.timestamp);
  });

  // 캐시 — 풀 데이터 보관 (limit 다르게 호출해도 재사용)
  await writeCache(user.id, {
    igConnected,
    tokenExpired: !!finalIgTokenExpired,
    threadsConnected,
    threadsTokenExpired: !!finalThreadsTokenExpired,
    items,
  });

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      igConnected,
      tokenExpired: !!finalIgTokenExpired,
      threadsConnected,
      threadsTokenExpired: !!finalThreadsTokenExpired,
      items: items.slice(0, limit),
    }),
  };
};
