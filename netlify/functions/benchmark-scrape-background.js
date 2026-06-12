// 벤치마크 분석 워커 (background, 15분 타임아웃)
// POST /api/benchmark-scrape  body: { accountId: <uuid> }
// 헤더: Authorization: Bearer <jwt>
//
// 흐름: 인증 → 쿨다운/한도 검사 → running 리포트 row 생성 →
//   ① Apify 프로필(팔로워수) ② Apify 게시물 30개 → benchmark_posts upsert
//   ③ 내 계정 IG Graph 최근 30개 (미연동 시 생략)
//   ④ computeStats 양쪽 ⑤ OpenAI 해석(실패해도 통계만으로 done)
//
// 비고:
// - background 함수라 응답(202)은 즉시 나가고 본문은 클라이언트에 전달되지 않는다.
//   클라이언트는 get-benchmark 를 폴링해 최신 리포트 status 로 진행을 본다.
// - Apify 필드명은 2026-06-11 실측 고정: 게시물 type/likesCount/commentsCount/
//   timestamp/hashtags/url/id (+ 영상 videoPlayCount|videoViewCount, productType),
//   프로필 followersCount/private.
// - access_token·APIFY_TOKEN 은 로그/응답에 절대 노출하지 않는다.

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken } = require('./_shared/supabase-auth');
const { computeStats } = require('./_shared/benchmark-stats');
const { getIgTokenForSeller, igGraphRequest } = require('./_shared/ig-graph');
const { checkAndIncrementQuota, QuotaExceededError } = require('./_shared/openai-quota');
const { llmChat } = require('./_shared/llm-call');

const COOLDOWN_HOURS = 6;       // 같은 계정 재분석 쿨다운
const DAILY_LIMIT = 10;         // 셀러당 하루 분석 횟수
const POSTS_LIMIT = 30;

// ── Apify ──────────────────────────────────────────────
async function apifyRunSync(actorPath, input) {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('apify_not_configured');
  const url = `https://api.apify.com/v2/acts/${actorPath}/run-sync-get-dataset-items?token=${token}&memory=1024&timeout=240`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`apify_${res.status}: ${text}`);
  }
  return res.json();
}

function normalizeApifyPost(item) {
  return {
    igPostId: String(item.id || item.shortCode || ''),
    takenAt: item.timestamp || null,
    mediaType: ['Image', 'Video', 'Sidecar'].includes(item.type) ? item.type : null,
    caption: (item.caption || '').slice(0, 4000),
    hashtags: Array.isArray(item.hashtags) ? item.hashtags.slice(0, 50) : [],
    likes: typeof item.likesCount === 'number' && item.likesCount >= 0 ? item.likesCount : null,
    comments: typeof item.commentsCount === 'number' && item.commentsCount >= 0 ? item.commentsCount : null,
    views: item.videoPlayCount ?? item.videoViewCount ?? null,
    url: item.url || null,
  };
}

// ── 내 계정 (IG Graph — 연동 시) ───────────────────────
const GRAPH_MEDIA_TYPE_MAP = { IMAGE: 'Image', VIDEO: 'Video', CAROUSEL_ALBUM: 'Sidecar' };

async function fetchMyPosts(sellerId, supa) {
  // getIgTokenForSeller 반환은 camelCase: { igUserId, accessToken, igUsername }
  const ig = await getIgTokenForSeller(sellerId, supa);
  if (!ig || !ig.igUserId) return null;
  const token = ig.accessToken;
  if (!token) return null;
  try {
    const me = await igGraphRequest(token, `/${ig.igUserId}`, { fields: 'followers_count' });
    const media = await igGraphRequest(token, `/${ig.igUserId}/media`, {
      fields: 'media_type,media_product_type,like_count,comments_count,timestamp,caption,permalink',
      limit: POSTS_LIMIT,
    });
    const posts = (media.data || []).map((m) => ({
      takenAt: m.timestamp || null,
      mediaType: m.media_product_type === 'REELS' ? 'Video' : (GRAPH_MEDIA_TYPE_MAP[m.media_type] || null),
      caption: m.caption || '',
      hashtags: (m.caption || '').match(/#[^\s#@]+/g)?.map((t) => t.slice(1)) || [],
      likes: typeof m.like_count === 'number' ? m.like_count : null,
      comments: typeof m.comments_count === 'number' ? m.comments_count : null,
      views: null,
      url: m.permalink || null,
    }));
    return { posts, followers: me.followers_count ?? null, username: ig.igUsername || null };
  } catch (e) {
    // 토큰 만료 등 — 비교 없이 상대 분석만 진행
    console.log('[benchmark] my-posts skip:', e.message);
    return null;
  }
}

// ── OpenAI 해석 ────────────────────────────────────────
async function aiInterpret(sellerId, mine, theirs, username) {
  await checkAndIncrementQuota(sellerId, 'gpt-4o-mini');
  const sys = '너는 "루미" — 소상공인 사장님의 SNS 마케팅을 돕는 차분하고 현실적인 컨설턴트다. '
    + '입력으로 두 인스타 계정의 통계(JSON)를 받는다: mine(사장님 계정, 없을 수 있음), theirs(벤치마크 계정). '
    + '과장·확신 금지: 공개 데이터 기반 추정임을 전제로, 단정 대신 "~로 보여요" 톤. 존댓말. '
    + '반드시 JSON으로만 답한다: {"differences":[{"title","body"}…3개],"formula":[{"title","body"}…3개],"suggestions":[{"title","body"}…3개]}. '
    + 'differences=사장님 계정과의 핵심 차이(mine 없으면 일반 소상공인 대비), formula=이 계정이 잘 되는 방식, '
    + 'suggestions=사장님이 이번 주에 바로 해볼 일(루미로 게시물을 만들 수 있게 구체적 소재로). '
    + 'body는 2문장 이내, 수치 인용은 입력 JSON에 있는 것만.';
  const userMsg = JSON.stringify({ benchmarkUsername: username, mine, theirs });

  const res = await llmChat({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    temperature: 0.4,
    max_tokens: 900,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: userMsg },
    ],
  }, { timeoutMs: 60_000, label: 'benchmark-interpret' });
  if (!res.ok) throw new Error(`openai_${res.status}`);
  const json = await res.json();
  const parsed = JSON.parse(json.choices?.[0]?.message?.content || '{}');
  if (!Array.isArray(parsed.differences) || !Array.isArray(parsed.formula) || !Array.isArray(parsed.suggestions)) {
    throw new Error('openai_bad_shape');
  }
  return parsed;
}

// ── 핸들러 ─────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '' };

  const token = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) { console.log('[benchmark] unauthorized call dropped'); return { statusCode: 401, body: '' }; }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
  const accountId = String(body.accountId || '');
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) return { statusCode: 400, body: '' };

  const supa = getAdminClient();

  const { data: account } = await supa
    .from('benchmark_accounts')
    .select('id, seller_id, ig_username, active')
    .eq('id', accountId)
    .eq('seller_id', user.id)
    .single();
  if (!account || !account.active) { console.log('[benchmark] account not found/inactive'); return { statusCode: 404, body: '' }; }

  // 쿨다운: 직전 done 리포트 6시간 / 진행 중(running 10분 내) 중복 차단 / 일일 한도
  const now = Date.now();
  const { data: recent } = await supa
    .from('benchmark_reports')
    .select('id, status, created_at')
    .eq('seller_id', user.id)
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(1);
  const last = recent && recent[0];
  if (last) {
    const ageMin = (now - new Date(last.created_at).getTime()) / 60000;
    if (last.status === 'running' && ageMin < 10) { console.log('[benchmark] already running'); return { statusCode: 202, body: '' }; }
    if (last.status === 'done' && ageMin < COOLDOWN_HOURS * 60) { console.log('[benchmark] cooldown'); return { statusCode: 202, body: '' }; }
  }
  const todayStart = new Date(); todayStart.setUTCHours(todayStart.getUTCHours() - 24);
  const { count: dayCount } = await supa
    .from('benchmark_reports')
    .select('id', { count: 'exact', head: true })
    .eq('seller_id', user.id)
    .gte('created_at', todayStart.toISOString());
  if ((dayCount || 0) >= DAILY_LIMIT) { console.log('[benchmark] daily limit'); return { statusCode: 202, body: '' }; }

  const { data: report } = await supa
    .from('benchmark_reports')
    .insert({ seller_id: user.id, account_id: accountId, status: 'running' })
    .select('id')
    .single();
  if (!report) return { statusCode: 500, body: '' };

  const fail = async (msg) => {
    await supa.from('benchmark_reports')
      .update({ status: 'error', error: msg, finished_at: new Date().toISOString() })
      .eq('id', report.id);
  };

  try {
    // ① 프로필 (팔로워수·비공개 여부)
    const profiles = await apifyRunSync('apify~instagram-profile-scraper', { usernames: [account.ig_username] });
    const profile = profiles && profiles[0];
    if (!profile || profile.error) throw new Error('profile_not_found');
    if (profile.private) { await fail('비공개 계정이라 분석할 수 없어요. 공개 계정만 가능해요.'); return { statusCode: 200, body: '' }; }

    // ② 게시물
    const rawPosts = await apifyRunSync('apify~instagram-scraper', {
      directUrls: [`https://www.instagram.com/${account.ig_username}/`],
      resultsType: 'posts',
      resultsLimit: POSTS_LIMIT,
      addParentData: false,
    });
    const theirsPosts = (rawPosts || []).map(normalizeApifyPost).filter((p) => p.igPostId && p.takenAt);
    if (theirsPosts.length === 0) throw new Error('no_posts');

    const rows = theirsPosts.map((p) => ({
      account_id: accountId,
      ig_post_id: p.igPostId,
      taken_at: p.takenAt,
      media_type: p.mediaType,
      caption: p.caption,
      hashtags: p.hashtags,
      like_count: p.likes,
      comment_count: p.comments,
      play_count: p.views,
      post_url: p.url,
      scraped_at: new Date().toISOString(),
    }));
    await supa.from('benchmark_posts').upsert(rows, { onConflict: 'account_id,ig_post_id' });
    await supa.from('benchmark_accounts').update({ last_scraped_at: new Date().toISOString() }).eq('id', accountId);

    // ③④ 통계
    const mineData = await fetchMyPosts(user.id, supa);
    const stats = {
      theirs: { username: account.ig_username, ...computeStats(theirsPosts, profile.followersCount ?? null) },
      mine: mineData ? { username: mineData.username, ...computeStats(mineData.posts, mineData.followers) } : null,
    };

    // ⑤ AI 해석 — 키/쿼터 문제 시 통계만으로 완료
    let aiReport = null, model = null;
    try {
      aiReport = await aiInterpret(user.id, stats.mine, stats.theirs, account.ig_username);
      model = 'gpt-4o-mini';
    } catch (e) {
      const reason = e instanceof QuotaExceededError ? 'quota' : e.message;
      console.log('[benchmark] ai skip:', reason);
    }

    await supa.from('benchmark_reports')
      .update({ status: 'done', stats, report: aiReport, model, finished_at: new Date().toISOString() })
      .eq('id', report.id);
    return { statusCode: 200, body: '' };
  } catch (e) {
    const msg = String(e.message || e);
    console.log('[benchmark] failed:', msg.slice(0, 200));
    let userMsg = '분석 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.';
    if (msg === 'apify_not_configured') userMsg = '분석 기능 준비 중이에요. 곧 열릴 예정이에요.';
    else if (msg === 'profile_not_found') userMsg = '계정을 찾지 못했어요. 아이디를 다시 확인해 주세요.';
    else if (msg === 'no_posts') userMsg = '이 계정에서 게시물을 가져오지 못했어요. 잠시 후 다시 시도해 주세요.';
    await fail(userMsg);
    return { statusCode: 200, body: '' };
  }
};
