// Threads Graph API 공통 헬퍼 (M1.2 스켈레톤)
//
// 패턴은 _shared/ig-graph.js 와 1:1 대응. Threads 가 Meta 인프라라 에러 코드
// 체계(190 = 토큰 만료 등)도 동일. 다만 base URL 이 graph.facebook.com 이
// 아니라 graph.threads.net 으로 분리돼 있음 → 별도 모듈로 둠.
//
// 보안 원칙 (ig-graph.js 와 동일):
//   - access_token 은 로그·응답에 절대 출력 X
//   - 토큰은 호출 직전에만 메모리에 두고 즉시 폐기
//   - service_role 클라이언트(getAdminClient)에서만 호출
//
// 현재 단계 (M1.2): 호출자 0. 함수 정의만 두고 M2 (post-channels-background)
// 가 도입되는 시점부터 실사용. getThreadsTokenForSeller / markThreadsTokenInvalid
// 는 ig_accounts.threads_* 컬럼을 참조하므로 M1.3 마이그레이션 후에 정상 동작.

const THREADS_API_VERSION = 'v1.0';                       // Meta 측 변경 시 여기만 갱신
const THREADS_BASE = `https://graph.threads.net/${THREADS_API_VERSION}`;

class ThreadsGraphError extends Error {
  constructor(message, { status, code, type, fbtrace_id } = {}) {
    super(message);
    this.name = 'ThreadsGraphError';
    this.status = status || null;
    this.code = code || null;          // Meta 표준 코드 (190 = 토큰 무효)
    this.type = type || null;
    this.fbtrace_id = fbtrace_id || null;
  }
  isTokenExpired() {
    if (this.status === 401) return true;
    if (this.code === 190) return true;
    return false;
  }
}

/**
 * 사장님의 Threads 토큰·계정 정보 조회.
 *
 * 결정사항 §12-A #1 (revised) — IG·Threads 별도 OAuth flow.
 * Threads 토큰은 ig_accounts 의 threads_* 컬럼에 저장.
 *
 * 의존 컬럼 (M1.3a):
 *   - ig_accounts.threads_user_id
 *   - ig_accounts.threads_token (Vault 복호화)
 *   - ig_accounts.threads_token_expires_at
 *
 * 코드 리뷰 #2 — IG 헬퍼 (ig-graph.js getIgTokenForSeller) 와 패턴 일치:
 *   토큰 무효 마킹(threads_token_invalid_at) 사전 차단은 호출자 책임.
 *   본 헬퍼는 단순히 토큰만 반환 (무효 마킹돼도 토큰 자체는 있으면 반환).
 *   호출자가 ig_accounts.threads_token_invalid_at 별도 체크해 사전 차단.
 *
 * @param {string} sellerId
 * @param {object} supabase - getAdminClient() 결과 (service_role)
 * @returns {Promise<{threadsUserId, accessToken, tokenExpiresAt}|null>}
 */
async function getThreadsTokenForSeller(sellerId, supabase) {
  if (!sellerId || !supabase) return null;
  try {
    const { data, error } = await supabase
      .from('ig_accounts_decrypted')
      .select('threads_user_id, threads_token, threads_token_expires_at')
      .eq('user_id', sellerId)
      .maybeSingle();
    if (error) {
      console.warn('[threads-graph] ig_accounts_decrypted 조회 경고:', error.message);
      return null;
    }
    if (!data || !data.threads_user_id) return null;
    const token = data.threads_token || null;
    if (!token) return null;
    return {
      threadsUserId: data.threads_user_id,
      accessToken: token,
      tokenExpiresAt: data.threads_token_expires_at || null,
    };
  } catch (e) {
    console.warn('[threads-graph] getThreadsTokenForSeller 예외:', e && e.message);
    return null;
  }
}

/**
 * Threads Graph API 호출 wrapper.
 * - access_token 은 query string (Meta 표준)
 * - 에러 응답이면 ThreadsGraphError 던짐
 *
 * @param {string} token
 * @param {string} path - "/{threads-user-id}/threads" 등
 * @param {object} params
 * @param {object} opts - { method, timeoutMs }
 */
async function threadsGraphRequest(token, path, params = {}, opts = {}) {
  if (!token) throw new ThreadsGraphError('access_token 누락', { status: 401, code: 190 });
  const safePath = path.startsWith('/') ? path : `/${path}`;
  const method = (opts.method || 'GET').toUpperCase();

  const qs = new URLSearchParams();
  let bodyForm = null;
  // GET / DELETE — params 모두 query string. body 없음.
  // 그 외 (POST/PUT 등) — params 는 form-encoded body, token 만 query string.
  if (method === 'GET' || method === 'DELETE') {
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null) continue;
      qs.set(k, String(v));
    }
    qs.set('access_token', token);
  } else {
    bodyForm = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null) continue;
      bodyForm.set(k, String(v));
    }
    qs.set('access_token', token);
  }
  const url = `${THREADS_BASE}${safePath}?${qs.toString()}`;

  const timeoutMs = opts.timeoutMs || 8000;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    const fetchOpts = { signal: ctrl.signal, method };
    if (bodyForm) {
      fetchOpts.body = bodyForm;
      fetchOpts.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    }
    res = await fetch(url, fetchOpts);
  } catch (e) {
    clearTimeout(tid);
    throw new ThreadsGraphError(`fetch 실패: ${e.message || 'unknown'}`, { status: 0 });
  }
  clearTimeout(tid);

  const usage = res.headers.get('x-business-use-case-usage') || res.headers.get('x-app-usage');
  if (usage) {
    const truncated = usage.length > 1024 ? usage.slice(0, 1024) + '…' : usage;
    console.log(`[threads-graph] usage ${safePath} ${truncated}`);
  }

  let data;
  try {
    data = await res.json();
  } catch (_) {
    throw new ThreadsGraphError(`응답 JSON 파싱 실패 (status=${res.status})`, { status: res.status });
  }

  if (!res.ok || (data && data.error)) {
    const e = (data && data.error) || {};
    throw new ThreadsGraphError(e.message || `Threads API 오류 (status=${res.status})`, {
      status: res.status,
      code: e.code || null,
      type: e.type || null,
      fbtrace_id: e.fbtrace_id || null,
    });
  }
  return data;
}

/**
 * Threads 미디어 컨테이너 생성 (2단계 게시의 1단계).
 *
 * Threads API 게시 흐름:
 *   1. POST /{user-id}/threads        — 컨테이너 생성 (creation_id 반환)
 *   2. POST /{user-id}/threads_publish — creation_id 로 실제 게시
 *
 * 답글 작성도 동일 흐름 — replyToId 지정 시 reply thread 컨테이너 생성.
 *
 * @param {object} args
 * @param {string} args.token
 * @param {string} args.threadsUserId
 * @param {string} args.mediaType   - 'TEXT' | 'IMAGE' | 'VIDEO' | 'CAROUSEL'
 * @param {string} [args.imageUrl]  - IMAGE 일 때
 * @param {string} [args.videoUrl]  - VIDEO 일 때
 * @param {string} [args.text]      - 본문 (Threads 500자 한도)
 * @param {string[]} [args.children] - CAROUSEL 의 자식 container id 배열
 * @param {string} [args.replyToId] - 답글일 때 부모 thread/comment id
 * @param {object} [opts]
 * @returns {Promise<{id: string}>} — id = creation_id
 */
async function createThreadsContainer({ token, threadsUserId, mediaType, imageUrl, videoUrl, text, children, replyToId }, opts = {}) {
  if (!threadsUserId) throw new ThreadsGraphError('threadsUserId 누락');
  if (!mediaType) throw new ThreadsGraphError('mediaType 누락');
  const params = { media_type: mediaType };
  if (text)      params.text = text;
  if (imageUrl)  params.image_url = imageUrl;
  if (videoUrl)  params.video_url = videoUrl;
  if (replyToId) params.reply_to_id = replyToId;
  if (Array.isArray(children) && children.length) params.children = children.join(',');
  return threadsGraphRequest(token, `/${threadsUserId}/threads`, params, { method: 'POST', ...opts });
}

/**
 * Threads 댓글에 답글 작성. 내부적으로 3단계:
 *   1) reply 컨테이너 생성 (replyToId 지정)
 *   2) status='FINISHED' 폴링 (텍스트 단독이라 보통 즉시)
 *   3) publish — 실제 thread 발행
 *
 * IG 의 reply-comment 와 의미는 동일하지만 Threads 는 *답글도 thread* 라
 * 게시 흐름과 같은 2-step. 텍스트만이라 빠름.
 *
 * @param {object} args
 * @param {string} args.token
 * @param {string} args.threadsUserId
 * @param {string} args.parentId   - 원 thread 또는 reply id
 * @param {string} args.text       - 답글 본문 (Threads 500자 한도)
 * @returns {Promise<{id: string}>} — 발행된 답 thread id
 */
async function replyToThreadsComment({ token, threadsUserId, parentId, text }, opts = {}) {
  if (!parentId) throw new ThreadsGraphError('parentId 누락');
  if (!text)     throw new ThreadsGraphError('text 누락');
  const container = await createThreadsContainer({
    token, threadsUserId, mediaType: 'TEXT', text, replyToId: parentId,
  }, opts);
  if (!container || !container.id) throw new ThreadsGraphError('답글 컨테이너 생성 실패');
  await waitForThreadsContainer({ token, creationId: container.id }, opts);
  return publishThreadsContainer({ token, threadsUserId, creationId: container.id }, opts);
}

/**
 * Threads 컨테이너 상태 폴링 — publish 호출 전 status='FINISHED' 대기.
 *
 * Meta 공식 (developers.facebook.com/docs/threads/troubleshooting):
 *   GET /{container-id}?fields=status,error_message
 *   status: IN_PROGRESS → FINISHED → (publish 후) PUBLISHED
 *           ERROR / EXPIRED 는 즉시 실패
 *
 * lumi 는 IG `waitForContainer` 와 일관되게 5초 간격 × 24회 (최대 2분).
 * Meta 권장 1분 간격은 보수적이라 단축. 단일 IMAGE 는 보통 5~10초 내 FINISHED.
 *
 * @param {object} args
 * @param {string} args.token
 * @param {string} args.creationId
 * @param {object} [opts] - { intervalMs, maxAttempts, timeoutMs }
 * @returns {Promise<{status: string}>} - status 가 FINISHED|PUBLISHED 일 때만 반환
 * @throws {ThreadsGraphError} - ERROR/EXPIRED/timeout/토큰만료
 */
async function waitForThreadsContainer({ token, creationId }, opts = {}) {
  if (!creationId) throw new ThreadsGraphError('creationId 누락');
  const intervalMs  = opts.intervalMs  || 5000;
  const maxAttempts = opts.maxAttempts || 24;
  const timeoutMs   = opts.timeoutMs   || 8000;
  let lastStatus = null;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    let data;
    try {
      data = await threadsGraphRequest(
        token,
        `/${creationId}`,
        { fields: 'status,error_message' },
        { method: 'GET', timeoutMs },
      );
    } catch (e) {
      if (e instanceof ThreadsGraphError && e.isTokenExpired()) throw e;
      continue;
    }
    lastStatus = data && data.status;
    if (lastStatus === 'FINISHED' || lastStatus === 'PUBLISHED') return data;
    if (lastStatus === 'ERROR' || lastStatus === 'EXPIRED') {
      throw new ThreadsGraphError(
        `Threads 컨테이너 ${lastStatus}: ${(data && data.error_message) || 'unknown'}`,
        { status: 0 },
      );
    }
  }
  throw new ThreadsGraphError(
    `Threads 컨테이너 ${maxAttempts}회 폴링 후 status 미확정 (last=${lastStatus || 'null'})`,
    { status: 0 },
  );
}

/**
 * Threads 컨테이너 publish (2단계 게시의 2단계).
 *
 * @param {object} args
 * @param {string} args.token
 * @param {string} args.threadsUserId
 * @param {string} args.creationId   - createThreadsContainer 가 반환한 id
 * @returns {Promise<{id: string}>} — id = thread_id (channel_posts.post_id 에 저장)
 */
async function publishThreadsContainer({ token, threadsUserId, creationId }, opts = {}) {
  if (!threadsUserId) throw new ThreadsGraphError('threadsUserId 누락');
  if (!creationId)    throw new ThreadsGraphError('creationId 누락');
  return threadsGraphRequest(token, `/${threadsUserId}/threads_publish`, { creation_id: creationId }, { method: 'POST', ...opts });
}

/**
 * Threads 사장님 단위 인사이트 — 기간 합산.
 *
 * M4.2 — insights.html 의 주간/월간 Threads 섹션용. IG fetchAccountInsights
 * 와 유사 패턴. since/until 은 unix seconds.
 *
 * Threads API 엔드포인트:
 *   GET /{threads-user-id}/threads_insights
 *     ?metric=views,likes,replies,reposts,quotes
 *     &since=<unix-sec>&until=<unix-sec>
 *
 * 응답은 IG 와 유사한 { data: [{ name, total_value: { value } }] } 형식.
 * 매트릭마다 total_value 가 있으면 그걸 사용, 없으면 values 배열 합산.
 *
 * @param {object} args
 * @param {string} args.token
 * @param {string} args.threadsUserId
 * @param {number} args.sinceSec
 * @param {number} args.untilSec
 * @returns {Promise<{views:number,likes:number,replies:number,reposts:number,quotes:number}>}
 */
async function getThreadsAccountInsights({ token, threadsUserId, sinceSec, untilSec }, opts = {}) {
  if (!threadsUserId) throw new ThreadsGraphError('threadsUserId 누락');
  const resp = await threadsGraphRequest(token, `/${threadsUserId}/threads_insights`, {
    metric: 'views,likes,replies,reposts,quotes',
    since: sinceSec,
    until: untilSec,
  }, opts);
  const out = { views: 0, likes: 0, replies: 0, reposts: 0, quotes: 0 };
  const rows = (resp && resp.data) || [];
  for (const row of rows) {
    if (!row || !row.name) continue;
    let val = 0;
    if (row.total_value && typeof row.total_value.value === 'number') {
      val = row.total_value.value;
    } else if (Array.isArray(row.values)) {
      val = row.values.reduce((s, v) => s + (Number(v && v.value) || 0), 0);
    }
    if (Object.prototype.hasOwnProperty.call(out, row.name)) {
      out[row.name] = val;
    }
  }
  return out;
}

/**
 * Threads 단건 thread 메타 + 인사이트.
 *
 * insight-on-demand 의 Threads 분기용. IG fetchMediaMeta+fetchMediaInsights 와
 * 1:1 대응이지만 Threads 는 thread 자체에 like_count 등 표면 메트릭이 없고
 * 인사이트 API 의 metric 들이 단일 source — 한 번 호출로 끝.
 *
 * Threads per-post Insights:
 *   GET /{thread-id}/insights?metric=views,likes,replies,reposts,quotes
 *   응답: { data: [{ name, values: [{ value }], total_value: { value } }] }
 *
 * @param {object} args
 * @param {string} args.token
 * @param {string} args.threadId
 * @returns {Promise<{meta: object, metrics: {views, likes, replies, reposts, quotes}}>}
 */
async function getThreadInsights({ token, threadId }, opts = {}) {
  if (!threadId) throw new ThreadsGraphError('threadId 누락');
  const meta = await threadsGraphRequest(token, `/${threadId}`, {
    fields: 'id,permalink,timestamp,media_type,media_url,thumbnail_url,text',
  }, opts);
  let metrics = { views: 0, likes: 0, replies: 0, reposts: 0, quotes: 0 };
  try {
    const resp = await threadsGraphRequest(token, `/${threadId}/insights`, {
      metric: 'views,likes,replies,reposts,quotes',
    }, opts);
    for (const row of (resp && resp.data) || []) {
      if (!row || !row.name) continue;
      let val = 0;
      if (row.total_value && typeof row.total_value.value === 'number') {
        val = row.total_value.value;
      } else if (Array.isArray(row.values) && row.values.length) {
        val = row.values.reduce((s, v) => s + (Number(v && v.value) || 0), 0);
      }
      if (Object.prototype.hasOwnProperty.call(metrics, row.name)) {
        metrics[row.name] = val;
      }
    }
  } catch (e) {
    // 권한·미디어 종류에 따라 일부 메트릭 미지원 — 0 으로 graceful.
    // 토큰 만료는 위로 throw (호출자가 mark).
    if (e instanceof ThreadsGraphError && e.isTokenExpired()) throw e;
    console.warn('[threads-graph] thread insights 조회 경고:', e && e.message);
  }
  return { meta, metrics };
}

/**
 * Threads 게시물 삭제 — DELETE /{threads-media-id}.
 *
 * Meta 정책 (developers.facebook.com/docs/threads/posts/delete-posts):
 *   - 권한: threads_basic + threads_delete (threads-oauth SCOPES 에 추가됨)
 *   - 한도: 계정당 100건/일
 *   - 본인 게시물만 삭제 가능
 *
 * @param {object} args
 * @param {string} args.token
 * @param {string} args.threadId
 * @returns {Promise<{success: boolean}>}
 */
async function deleteThreadsPost({ token, threadId }, opts = {}) {
  if (!threadId) throw new ThreadsGraphError('threadId 누락');
  return threadsGraphRequest(token, `/${threadId}`, {}, { method: 'DELETE', ...opts });
}

/**
 * ig_accounts.threads_token_invalid_at 마킹 헬퍼.
 *
 * Threads Graph 호출에서 ThreadsGraphError.isTokenExpired() 가 true 면
 * 모든 호출자가 이 함수로 즉시 마킹 — cron · 사장님 요청의 사전 차단.
 * (ig-graph.js 의 markIgTokenInvalid 와 1:1 대응)
 *
 * 의존 컬럼: ig_accounts.threads_token_invalid_at (M1.3 에서 추가).
 * 컬럼 없는 동안에는 update 가 catch 로 떨어져 silent fail — best-effort.
 *
 * @param {object} admin - getAdminClient() 결과 (service_role)
 * @param {string} userId
 * @param {string} [context] - 로그용 호출 함수 이름
 */
async function markThreadsTokenInvalid(admin, userId, context = 'threads-graph') {
  if (!admin || !userId) return;
  try {
    await admin
      .from('ig_accounts')
      .update({ threads_token_invalid_at: new Date().toISOString() })
      .eq('user_id', userId);
    console.log(`[${context}] threads_token_invalid_at 마킹: user=${String(userId).slice(0, 8)}`);
  } catch (e) {
    console.warn(`[${context}] threads_token_invalid_at 마킹 실패:`, e && e.message);
  }
}

module.exports = {
  getThreadsTokenForSeller,
  threadsGraphRequest,
  createThreadsContainer,
  waitForThreadsContainer,
  publishThreadsContainer,
  replyToThreadsComment,
  getThreadsAccountInsights,
  getThreadInsights,
  deleteThreadsPost,
  markThreadsTokenInvalid,
  ThreadsGraphError,
  THREADS_API_VERSION,
  THREADS_BASE,
};
