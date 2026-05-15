// keyword-detail.js — 트렌드 키워드 상세 설명 즉석 생성 + 캐시
// GET /api/keyword-detail?keyword=<kw>&category=<cat>
//
// 동작:
//   1) Bearer 토큰 검증 — 회원 전용 (트렌드 페이지가 회원 진입이라 외부 직접 호출은 차단)
//   2) Netlify Blobs `keyword-detail` 캐시 lookup (key: <category>/<encodedKeyword>)
//      - hit (TTL 30일 이내) → cached: true 로 즉시 반환 (quota 차감 X)
//   3) miss → OpenAI quota gate (sellerId, gpt-4o-mini) → 호출 → 캐시 저장
//   4) { ok:true, data:{ keyword, category, definition, audience, why, ideas[], hashtags[], generatedAt, cached } }
//
// 에러:
//   401 invalid_token / 429 quota_exceeded / 200 ok:false generation_failed → 모달 fallback

const { getStore } = require('@netlify/blobs');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { checkAndIncrementQuota, QuotaExceededError } = require('./_shared/openai-quota');

const OPENAI_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일

const ALLOWED_CATEGORIES = new Set([
  'all', 'cafe', 'food', 'beauty', 'hair', 'nail',
  'fashion', 'flower', 'fitness',
]);

function getCacheStore() {
  return getStore({
    name: 'keyword-detail',
    consistency: 'strong',
    siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
    token: process.env.NETLIFY_TOKEN,
  });
}

// URL-safe blob key (Netlify Blobs 키는 슬래시 prefix 허용 — 카테고리 폴더링)
function cacheKey(category, keyword) {
  return `${category}/${encodeURIComponent(keyword)}`;
}

async function readCache(category, keyword) {
  try {
    const store = getCacheStore();
    const raw = await store.get(cacheKey(category, keyword), { type: 'json' });
    if (!raw || !raw.cachedAt) return null;
    if (Date.now() - new Date(raw.cachedAt).getTime() > CACHE_TTL_MS) return null;
    return raw.data;
  } catch (e) {
    console.warn('[keyword-detail] cache read 무시:', e && e.message);
    return null;
  }
}

async function writeCache(category, keyword, data) {
  try {
    const store = getCacheStore();
    await store.setJSON(cacheKey(category, keyword), {
      cachedAt: new Date().toISOString(),
      data,
    });
  } catch (e) {
    console.warn('[keyword-detail] cache write 무시:', e && e.message);
  }
}

// 응답 정규화 — OpenAI가 키 누락/타입 변형을 보내도 fail 안 하도록 방어.
function normalizeDetail(parsed, keyword, category) {
  function s(v, max) {
    if (v == null) return '';
    return String(v).slice(0, max);
  }
  function arrStr(v, maxItems, maxLen) {
    if (!Array.isArray(v)) return [];
    return v
      .filter((x) => x != null && String(x).trim().length > 0)
      .slice(0, maxItems)
      .map((x) => String(x).slice(0, maxLen));
  }
  // 해시태그는 # 미포함 입력도 # 부착
  const hashtags = arrStr(parsed.hashtags, 8, 40).map((h) => (h.startsWith('#') ? h : '#' + h));

  return {
    keyword,
    category,
    definition: s(parsed.definition, 400),
    audience: s(parsed.audience, 200),
    why: s(parsed.why, 400),
    ideas: arrStr(parsed.ideas, 3, 200),
    hashtags,
    generatedAt: new Date().toISOString(),
  };
}

async function generateWithOpenAI(keyword, category) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY 미설정');
  }

  const systemPrompt =
    '당신은 한국 소상공인 매장(카페·음식점·꽃집·미용 등)에게 트렌드 키워드를 알기 쉽게 설명하는 어시스턴트입니다.\n' +
    'JSON으로만 답변. 키:\n' +
    '- definition: 키워드의 정의·설명 (2~3문장)\n' +
    '- audience: 누가 이 키워드를 찾는지 (1문장, 타겟 소비자층)\n' +
    '- why: 왜 지금 뜨는지 (2~3문장, 트렌드 배경)\n' +
    '- ideas: 매장 활용 아이디어 (배열, 문자열 3개, 각각 1문장 — 신메뉴·세트 구성·마케팅 활용 등 실행 가능한 제안)\n' +
    '- hashtags: 관련 해시태그 (배열, 5~7개, # 포함)\n' +
    '\n' +
    '모든 답은 한국어. 정확하고 유익하게. 추측은 금지하고 일반적·검증 가능한 정보만.';

  const userInput = `키워드: ${keyword}\n카테고리: ${category}`;

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), OPENAI_TIMEOUT_MS);

  let res;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userInput },
        ],
        temperature: 0.4,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(tid);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`openai HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const json = await res.json();
  const raw = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!raw || typeof raw !== 'string') {
    throw new Error('openai 응답 본문 없음');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('openai JSON 파싱 실패');
  }

  const out = normalizeDetail(parsed, keyword, category);
  // 최소 검증: definition·why 둘 중 하나라도 있어야 의미 있는 응답.
  if (!out.definition && !out.why) {
    throw new Error('openai 응답 비어있음');
  }
  return out;
}

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: 'method_not_allowed' }),
    };
  }

  try {
    // 0) 회원 인증 — 외부에서 직접 호출해 GPT 자원 소모하는 경로 차단
    const token = extractBearerToken(event);
    if (!token) {
      return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };
    }
    const { user, error: authErr } = await verifyBearerToken(token);
    if (authErr || !user) {
      return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'invalid_token' }) };
    }

    const qs = event.queryStringParameters || {};
    const keyword = String(qs.keyword || '').trim();
    let category = String(qs.category || 'all').trim().toLowerCase();

    if (!keyword) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: 'keyword_required' }),
      };
    }
    if (keyword.length > 60) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: 'keyword_too_long' }),
      };
    }
    if (!ALLOWED_CATEGORIES.has(category)) category = 'all';

    // 1) 캐시 lookup — hit 면 quota 차감 없이 즉시 반환 (글로벌 30일 캐시 효과)
    const cached = await readCache(category, keyword);
    if (cached) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: true,
          data: { ...cached, cached: true },
        }),
      };
    }

    // 2) miss → OpenAI quota gate (cache miss 만 카운트). 한도 초과 시 429.
    try {
      await checkAndIncrementQuota(user.id, 'gpt-4o-mini');
    } catch (qe) {
      if (qe instanceof QuotaExceededError) {
        return {
          statusCode: 429,
          headers,
          body: JSON.stringify({ ok: false, error: 'quota_exceeded', reason: qe.reason || null }),
        };
      }
      console.warn('[keyword-detail] quota 체크 실패 (fail-open으로 진행):', qe && qe.message);
    }

    // 3) OpenAI 즉석 생성
    let detail;
    try {
      detail = await generateWithOpenAI(keyword, category);
    } catch (e) {
      console.warn('[keyword-detail] openai 실패:', e && e.message);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: false, error: 'generation_failed' }),
      };
    }

    // 4) 캐시 저장 (best-effort)
    await writeCache(category, keyword, detail);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        data: { ...detail, cached: false },
      }),
    };
  } catch (e) {
    console.error('[keyword-detail] exception:', e && e.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: 'server_error' }),
    };
  }
};
