// scheduled-community-trends-background.js — 커뮤니티 트렌드 GPT 웹 검색 수집
// 수집 대상: 맘카페·디시인사이드·더쿠·에펨코리아·뽐뿌·클리앙 등 공식 API 없는 소스
// 주 1회 (매주 수요일 KST 02:00 = UTC 화요일 17:00)
// GPT-4o-mini + web_search_preview 도구 사용 (환각 낮음, 실제 URL 기반)

const { getAdminClient } = require('./_shared/supabase-admin');
const { runGuarded } = require('./_shared/cron-guard');
const https = require('https');

const CATEGORIES = ['cafe', 'food', 'beauty', 'hair', 'nail', 'flower', 'fashion', 'fitness', 'pet'];

const COMMUNITY_QUERIES = {
  cafe: '맘카페 디시인사이드 더쿠 등 한국 주요 커뮤니티에서 최근 1주일간 화제 중인 카페·음료·디저트 트렌드 키워드 10개',
  food: '맘카페 에펨코리아 루리웹 등 커뮤니티에서 최근 화제 중인 외식·맛집·신상 음식 트렌드 키워드 10개',
  beauty: '맘카페 더쿠 등 커뮤니티에서 최근 여성들이 주목하는 뷰티·스킨케어·메이크업 트렌드 키워드 10개',
  hair: '맘카페 더쿠 등 커뮤니티에서 최근 관심받는 헤어 스타일·시술 트렌드 키워드 10개',
  nail: '맘카페 디시 등 커뮤니티에서 최근 인기 네일 디자인·아트 트렌드 키워드 10개',
  flower: '맘카페 더쿠 등에서 화제 중인 꽃·부케·꽃다발 선물 트렌드 키워드 10개',
  fashion: '맘카페 더쿠 디시 등에서 최근 화제 중인 패션·의류·악세서리 트렌드 키워드 10개',
  fitness: '맘카페 에펨코리아 등에서 최근 인기 피트니스·필라테스·홈트 트렌드 키워드 10개',
  pet: '맘카페 더쿠 등에서 최근 화제 중인 반려동물 용품·서비스 트렌드 키워드 10개',
};

async function callGPTCommunitySearch(query) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const prompt = `${query}

JSON 배열로만 응답하세요. 각 항목:
{
  "keyword": "키워드 (한글 2-15자)",
  "source_url": "검색 결과 실제 URL",
  "excerpt": "원문 인용 30자 이상",
  "community": "맘카페|디시|더쿠|에펨코리아|뽐뿌|클리앙|기타",
  "confidence": 0-100 정수
}

엄격 규칙:
- 검색 결과에 없는 정보 금지 (환각 금지)
- source_url은 검색된 실제 URL이어야 함
- excerpt는 원문에서 직접 인용 (요약 금지)
- 명확한 트렌드 근거 없으면 빈 배열 반환
- temperature 낮춤 처리됨
- 설명·마크다운 없이 JSON 배열만 출력`;

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/responses',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          let content = data.output_text || '';
          if (!content && Array.isArray(data.output)) {
            for (const item of data.output) {
              for (const part of (item?.content || [])) {
                if (part?.text) content += part.text;
              }
            }
          }
          const clean = content.replace(/```json|```/g, '').trim();
          const match = clean.match(/\[[\s\S]*\]/);
          if (!match) return resolve([]);
          const parsed = JSON.parse(match[0]);
          resolve(Array.isArray(parsed) ? parsed : []);
        } catch (e) {
          console.error('[community-search] parse 실패:', e.message);
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(60000, () => req.destroy());

    req.write(JSON.stringify({
      model: 'gpt-4o-mini',
      input: prompt,
      tools: [{ type: 'web_search_preview' }],
      temperature: 0.1,
      max_output_tokens: 2000,
      store: false,
    }));
    req.end();
  });
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

exports.handler = runGuarded({
  name: 'scheduled-community-trends',
  handler: async (event, ctx) => {
    const supa = getAdminClient();

    await ctx.stage('start', { categories: CATEGORIES.length });

    const results = await Promise.all(CATEGORIES.map(async (category) => {
      try {
        const rawItems = await callGPTCommunitySearch(COMMUNITY_QUERIES[category]);

        // URL 검증 제거 — 커뮤니티 사이트는 봇 차단으로 HEAD 항상 실패
        // confidence + keyword + excerpt 기반 필터만 적용
        const validated = [];
        for (const item of (rawItems || [])) {
          if (!item?.keyword || !item?.source_url || !item?.excerpt) continue;
          if (typeof item.confidence !== 'number' || item.confidence < 50) continue;
          validated.push(item);
        }

        // Supabase 저장 (trends 테이블 재사용)
        await supa.from('trends').upsert({
          category: `community:${category}`,
          keywords: {
            items: validated.slice(0, 10),
            updatedAt: new Date().toISOString(),
            source: 'gpt-web-search',
          },
          collected_at: new Date().toISOString(),
        }, { onConflict: 'category' });

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

// 주 1회 — 매주 수요일 KST 02:00 (= UTC 화요일 17:00)
module.exports.config = { schedule: '0 17 * * 2' };
