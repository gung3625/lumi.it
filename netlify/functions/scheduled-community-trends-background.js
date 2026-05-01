// scheduled-community-trends-background.js — 커뮤니티 트렌드 GPT 웹 검색 수집
// 수집 대상: 맘카페·디시인사이드·더쿠·에펨코리아·뽐뿌·클리앙 등 공식 API 없는 소스
// 주 1회 (매주 수요일 KST 02:00 = UTC 화요일 17:00)
// GPT-4o-mini + web_search_preview 도구 사용 (환각 낮음, 실제 URL 기반)

const { getAdminClient } = require('./_shared/supabase-admin');
const { runGuarded } = require('./_shared/cron-guard');
const https = require('https');
const { checkAndIncrementQuota, QuotaExceededError } = require('./_shared/openai-quota');

const CATEGORIES = ['cafe', 'food', 'beauty', 'hair', 'nail', 'flower', 'fashion', 'fitness', 'pet'];

const COMMUNITY_QUERIES = {
  cafe: {
    communities: ['맘카페', '디시인사이드 카페 갤러리', '인스타그램 카페 해시태그'],
    context: '요즘 카페 사장님들이 신메뉴·디저트로 주목하는 키워드',
  },
  food: {
    communities: ['맘카페', '에펨코리아', '식당 리뷰 블로그'],
    context: '요즘 외식업계에서 화제 중인 메뉴·식당',
  },
  beauty: {
    communities: ['맘카페', '더쿠', '파우더룸 뷰티 카테고리'],
    context: '요즘 여성들이 입소문으로 주목하는 뷰티 제품·성분',
  },
  hair: {
    communities: ['맘카페', '더쿠 미용실', '헤어 인스타그램 태그'],
    context: '요즘 유행하는 헤어 스타일·시술·염색 컬러',
  },
  nail: {
    communities: ['맘카페', '디시 네일 갤러리', '더쿠 네일'],
    context: '요즘 유행하는 네일 디자인·아트·컬러',
  },
  flower: {
    communities: ['맘카페', '더쿠 꽃집', '플라워 인스타그램'],
    context: '요즘 꽃 선물·웨딩 부케·플라워샵 트렌드',
  },
  fashion: {
    communities: ['맘카페', '더쿠 패션', '디시 패션 갤러리', '인스타 패션 태그'],
    context: '요즘 여성·남성이 주목하는 패션 아이템·브랜드·스타일',
  },
  fitness: {
    communities: ['맘카페', '에펨코리아 헬창', '필라테스 인스타'],
    context: '요즘 피트니스·필라테스·홈트레이닝 트렌드',
  },
  pet: {
    communities: ['맘카페', '더쿠 반려동물', '펫 인스타 태그'],
    context: '요즘 반려동물 사료·간식·용품 브랜드 트렌드',
  },
};

function buildPrompt(category, config) {
  return `다음 한국 커뮤니티에서 실제 검색을 수행해 정보를 찾아주세요:
${config.communities.join(', ')}

주제: ${config.context}

**반드시 실제 웹 검색 결과에서 나온 정보만** JSON 배열로 반환. 각 항목:
{
  "keyword": "구체적 트렌드 키워드 (한글 2-15자)",
  "source_url": "실제 검색 결과 URL",
  "excerpt": "원문에서 직접 인용 30자 이상",
  "community": "출처 커뮤니티명",
  "confidence": 60-100 (확신 정도)
}

엄격 규칙:
- confidence 60 미만은 반환 금지 (불확실하면 아예 빼기)
- source_url은 검색 결과에서 실제 본 URL만
- excerpt는 원문에서 그대로 복붙 (요약·변형 금지)
- 트렌드가 명확하지 않으면 적게 반환해도 됨 (거짓 키워드 금지)
- 최대한 3개 이상 찾도록 노력. 못 찾으면 빈 배열 []
- 설명·마크다운 없이 JSON 배열만 출력`;
}

async function callGPTCommunitySearch(category, prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('[community] OPENAI_API_KEY 없음');
    return null;
  }

  // Responses API: gpt-4o-mini + web_search_preview 도구 사용
  // (gpt-4o-mini-search-preview는 Chat Completions 전용 — Responses API에서 미지원)
  console.log(`[community] ${category} API 호출 시작 (model: gpt-4o-mini + web_search_preview)`);

  return new Promise((resolve) => {
    const payload = JSON.stringify({
      model: 'gpt-4o-mini',
      input: prompt,
      tools: [{ type: 'web_search_preview' }],
      max_output_tokens: 2000,
      store: false,
    });

    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/responses',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        console.log(`[community] ${category} 응답 status:`, res.statusCode);
        console.log(`[community] ${category} 응답 body 일부:`, body.slice(0, 500));
        try {
          const data = JSON.parse(body);

          // Responses API 구조: output[] 배열에서 type==="message" 항목의 content[0].text 추출
          let content = '';
          if (Array.isArray(data.output)) {
            for (const item of data.output) {
              if (item?.type === 'message' && Array.isArray(item.content)) {
                for (const part of item.content) {
                  if (part?.type === 'output_text' && part?.text) content += part.text;
                  else if (part?.text) content += part.text;
                }
              }
            }
          }
          // fallback: output_text 최상위 필드
          if (!content && data.output_text) content = data.output_text;

          console.log(`[community] ${category} 추출된 content 길이:`, content.length);
          if (!content) {
            console.error(`[community] ${category} content 없음. data.error:`, JSON.stringify(data.error || data.message || ''));
            return resolve([]);
          }

          const clean = content.replace(/```json|```/g, '').trim();
          const match = clean.match(/\[[\s\S]*\]/);
          if (!match) {
            console.error(`[community] ${category} JSON 배열 파싱 실패. content:`, content.slice(0, 200));
            return resolve([]);
          }
          const parsed = JSON.parse(match[0]);
          const result = Array.isArray(parsed) ? parsed : [];
          console.log(`[community] ${category} 파싱 결과 수:`, result.length);
          resolve(result);
        } catch (e) {
          console.error(`[community] ${category} parse 실패:`, e.message, body.slice(0, 300));
          resolve([]);
        }
      });
    });
    req.on('error', (e) => {
      console.error(`[community] ${category} 요청 오류:`, e.message);
      resolve([]);
    });
    req.setTimeout(90000, () => {
      console.error(`[community] ${category} 타임아웃`);
      req.destroy();
    });

    req.write(payload);
    req.end();
  });
}

async function fetchCommunityForCategory(category, config) {
  const primary = buildPrompt(category, config);
  let result = await callGPTCommunitySearch(category, primary);

  if (!result || result.length === 0) {
    console.log(`[community] ${category} 1차 결과 없음 → 재시도`);
    const fallback = `"${category}" 업종의 최근 한국 커뮤니티·블로그·뉴스 트렌드 5개를 JSON 배열로. ${primary.slice(500)}`;
    result = await callGPTCommunitySearch(category, fallback);
  }
  return result;
}

async function validateUrl(item) {
  // 최소 검증: URL 존재 여부만 HEAD 체크 (빠름)
  if (!item?.source_url) return false;
  return new Promise((resolve) => {
    try {
      const u = new URL(item.source_url);
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'HEAD',
        timeout: 3000,
      }, (res) => {
        resolve(res.statusCode >= 200 && res.statusCode < 400);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

exports.handler = runGuarded({
  name: 'scheduled-community-trends',
  handler: async (event, ctx) => {
    // Netlify cron 호출은 event.httpMethod가 없음 → 인증 스킵
    // 외부 HTTP 호출만 LUMI_SECRET 검증
    const isScheduled = !event || !event.httpMethod;
    if (!isScheduled) {
      const secret = (event.headers && (event.headers['x-lumi-secret'] || event.headers['X-Lumi-Secret'])) || '';
      if (!process.env.LUMI_SECRET || secret !== process.env.LUMI_SECRET) {
        return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: '인증 실패' }) };
      }
    }

    const supa = getAdminClient();

    // 서비스 전체 예산 체크 (cron — sellerId 없음, 9개 카테고리 × ₩5 = ₩45 추정)
    try {
      await checkAndIncrementQuota(null, 'gpt-4o-mini', CATEGORIES.length * 5);
    } catch (e) {
      if (e instanceof QuotaExceededError) {
        console.warn('[community-trends] 서비스 전체 OpenAI 예산 초과 — cron 중단:', e.message);
        return { statusCode: 429, headers: HEADERS, body: JSON.stringify({ error: e.message, skipped: true }) };
      }
      throw e;
    }

    await ctx.stage('start', { categories: CATEGORIES.length });

    const results = await Promise.all(CATEGORIES.map(async (category) => {
      try {
        console.log(`[community] ${category} 처리 시작`);
        const rawItems = await fetchCommunityForCategory(category, COMMUNITY_QUERIES[category]);

        // URL 검증 제거 — 커뮤니티 사이트는 봇 차단으로 HEAD 항상 실패
        // confidence + keyword + excerpt 기반 필터만 적용
        const validated = [];
        for (const item of (rawItems || [])) {
          if (!item?.keyword || !item?.source_url || !item?.excerpt) continue;
          if (typeof item.confidence !== 'number' || item.confidence < 50) continue;
          validated.push(item);
        }
        console.log(`[community] ${category} validated 수:`, validated.length);

        // Supabase 저장 (trends 테이블 재사용)
        const updatedAt = new Date().toISOString();
        const today = updatedAt.slice(0, 10); // YYYY-MM-DD
        const keywordsPayload = {
          items: validated.slice(0, 10),
          updatedAt,
          source: 'gpt-web-search',
        };

        // 1. 최신 행 (메인 파이프라인이 읽는 키)
        const { error: upsertError } = await supa.from('trends').upsert({
          category: `community:${category}`,
          keywords: keywordsPayload,
          collected_at: updatedAt,
        }, { onConflict: 'category' });

        if (upsertError) {
          console.error(`[community] ${category} upsert 오류:`, upsertError.message);
        } else {
          console.log(`[community] ${category} upsert 성공`);
        }

        // 2. 날짜별 스냅샷 (누적 데이터)
        const { error: snapError } = await supa.from('trends').upsert({
          category: `community:${category}:${today}`,
          keywords: keywordsPayload,
          collected_at: updatedAt,
        }, { onConflict: 'category' });

        if (snapError) {
          console.error(`[community] ${category} snapshot upsert 오류:`, snapError.message);
        } else {
          console.log(`[community] ${category} snapshot ${today} 저장 성공`);
        }
        console.log(`[community] ${category}: ${validated.length}개 저장`);
        return { category, count: validated.length };
      } catch (e) {
        console.error(`[community] ${category} 실패:`, e.message);
        return { category, error: e.message };
      }
    }));

    await ctx.stage('complete', { results });
    return { statusCode: 200, body: JSON.stringify({ success: true, results }) };
  },
});

// 매일 KST 02:00 (= UTC 17:00)
module.exports.config = { schedule: '0 17 * * *' };
