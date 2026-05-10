// today-mission.js — 모바일 v3 홈 탭 "오늘의 미션" AI 추천 카드
// 사용자 업종 + 요일 + 계절 + 현재 업종 트렌드 결합 → GPT-4o-mini로 1개 미션 생성
// 6시간 캐시 (per user) — 과도한 호출 방지
const https = require('https');
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifySellerToken, extractBearerToken } = require('./_shared/seller-jwt');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { checkAndIncrementQuota, QuotaExceededError } = require('./_shared/openai-quota');

const CATEGORY_KR = {
  cafe: '카페·음료', food: '음식·외식', beauty: '뷰티·스킨케어',
  hair: '헤어', nail: '네일', flower: '꽃집·플라워',
  fashion: '패션·의류', fitness: '헬스·필라테스', pet: '반려동물·펫',
};

function getSeasonAndDay() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDay();
  const season = month <= 2 || month === 12 ? '겨울' : month <= 5 ? '봄' : month <= 8 ? '여름' : '가을';
  const dayName = ['일','월','화','수','목','금','토'][day] + '요일';
  return { season, dayName, month };
}

async function fetchTopTrends(supa, category) {
  try {
    const { data } = await supa.from('trends').select('keywords').eq('category', `l30d-domestic:${category}`).maybeSingle();
    const arr = data?.keywords?.keywords;
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, 5).map(k => k.keyword).filter(Boolean);
  } catch (_) { return []; }
}

async function callGPT(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      model: 'gpt-4o-mini',
      input: prompt,
      temperature: 0.5,
      max_output_tokens: 400,
      store: false,
    });
    const req = https.request({
      hostname: 'api.openai.com', path: '/v1/responses', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          let text = '';
          if (Array.isArray(j.output)) {
            for (const item of j.output) {
              if (item?.type === 'message' && Array.isArray(item.content)) {
                for (const part of item.content) {
                  if (part?.type === 'output_text' && part?.text) text += part.text;
                }
              }
            }
          }
          if (!text && j.output_text) text = j.output_text;
          resolve(text || null);
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(12000, () => { req.destroy(); resolve(null); });
    req.write(payload); req.end();
  });
}

function buildPrompt({ categoryKR, season, dayName, trends }) {
  const trendText = trends.length ? trends.slice(0,3).join(', ') : '(트렌드 데이터 없음)';
  return `당신은 한국 소상공인의 인스타그램 운영을 돕는 AI 어시스턴트 루미(lumi)입니다.
오늘 ${categoryKR} 사장님이 올릴 만한 **1개 미션**을 추천하세요.

[컨텍스트]
- 업종: ${categoryKR}
- 계절: ${season}
- 요일: ${dayName}
- 오늘 뜨는 키워드: ${trendText}

[출력 형식 - 반드시 JSON만, 설명 없이]
{
  "title": "한 줄 미션 제목 (15~25자, 따옴표 없이, 구체적 행동 제안)",
  "desc": "왜 이 미션이 오늘 좋은지 + 포인트 설명 (40~70자, 자연스럽고 따뜻한 말투)",
  "ctaLabel": "사진 올리러 가기"
}

[규칙]
- 사장님 언어. 존댓말이되 친구같이
- 트렌드 키워드를 자연스럽게 녹여서 (억지 아님)
- 너무 뻔한 얘기 금지 (예: "맛있는 사진 올려보세요" X)
- 계절·요일 맞춤 감성
- 이모지 없이 텍스트만`;
}

function parseJson(text) {
  if (!text) return null;
  const clean = text.replace(/```json|```/g, '').trim();
  const m = clean.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

// 기본 fallback 미션 (GPT 실패 시)
function fallbackMission({ categoryKR, dayName, season }) {
  const samples = {
    '카페·음료': { title: '오늘 시그니처 음료 한 컷', desc: `${dayName} ${season} 분위기에 어울리는 대표 음료 클로즈업 어때요?`, ctaLabel: '사진 올리러 가기' },
    '음식·외식': { title: '오늘의 추천 메뉴 한 장', desc: `${dayName}에 잘 나가는 메뉴 하나 정해서 예쁘게 담아보세요.`, ctaLabel: '사진 올리러 가기' },
    '뷰티·스킨케어': { title: '오늘 쓸 만한 제품 1개', desc: `${season} 피부 고민에 맞는 제품 추천 한 컷 어때요?`, ctaLabel: '사진 올리러 가기' },
    '헤어': { title: `이번주 ${season} 스타일 비포&애프터`, desc: '작업한 손님 허락 받고 한 장 올려보세요. 리뷰 효과 큽니다.', ctaLabel: '사진 올리러 가기' },
    '네일': { title: `${season} 컬러 오늘의 작업`, desc: '오늘 한 네일 중 제일 예쁜 거 한 장 올려요.', ctaLabel: '사진 올리러 가기' },
    '꽃집·플라워': { title: `${dayName} 꽃 한 송이 사진`, desc: '오늘 들어온 꽃 중 가장 색감 좋은 거 클로즈업.', ctaLabel: '사진 올리러 가기' },
    '패션·의류': { title: '오늘 픽 1개 코디컷', desc: `${season}에 딱 맞는 아이템 하나 스타일링 사진.`, ctaLabel: '사진 올리러 가기' },
    '헬스·필라테스': { title: `${dayName} 운동 한 자세`, desc: '오늘 운동한 회원 동의 받고 짧은 모먼트 공유.', ctaLabel: '사진 올리러 가기' },
    '반려동물·펫': { title: '오늘의 손님 인증컷', desc: '오늘 다녀간 귀여운 아이 한 장. 팬이 생겨요.', ctaLabel: '사진 올리러 가기' },
  };
  return samples[categoryKR] || { title: '오늘 한 장 올려볼까요?', desc: '매일 하나씩만 올려도 반응이 쌓여요.', ctaLabel: '사진 올리러 가기' };
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // 인증 강제 — 미인증 요청 차단 (OpenAI 비용 어뷰징 방지)
  const token = extractBearerToken(event);
  const { payload, error: jwtErr } = verifySellerToken(token);
  if (jwtErr || !payload?.seller_id) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }
  const userId = payload.seller_id;

  try {
    const supa = getAdminClient();

    // 사장님 업종 조회 (sellers.industry)
    let category = 'cafe';
    try {
      const { data } = await supa.from('sellers').select('industry').eq('id', userId).maybeSingle();
      const c = data?.industry;
      if (c && CATEGORY_KR[c]) category = c;
    } catch (_) {}

    // 캐시 조회 (6시간)
    const cacheKey = `today-mission:${userId}:${category}`;
    try {
      const { data } = await supa.from('trends').select('keywords, collected_at').eq('category', cacheKey).maybeSingle();
      if (data?.keywords?.mission && data.collected_at) {
        const ageMs = Date.now() - new Date(data.collected_at).getTime();
        if (ageMs < 6 * 60 * 60 * 1000) {
          return { statusCode: 200, headers: CORS, body: JSON.stringify({ mission: data.keywords.mission, cached: true }) };
        }
      }
    } catch (_) {}

    const { season, dayName } = getSeasonAndDay();
    const categoryKR = CATEGORY_KR[category] || '일반';
    const trends = await fetchTopTrends(supa, category);

    // Quota 검증 (gpt-4o-mini ₩5/호출)
    try {
      await checkAndIncrementQuota(userId, 'gpt-4o-mini');
    } catch (e) {
      if (e instanceof QuotaExceededError) {
        const CORS2 = corsHeaders(getOrigin(event));
        return { statusCode: 429, headers: CORS2, body: JSON.stringify({ error: e.message }) };
      }
      throw e;
    }

    const prompt = buildPrompt({ categoryKR, season, dayName, trends });
    const text = await callGPT(prompt);
    let mission = parseJson(text);

    if (!mission || !mission.title) {
      mission = fallbackMission({ categoryKR, dayName, season });
    }

    // 캐시 저장
    try {
      await supa.from('trends').upsert(
        { category: cacheKey, keywords: { mission }, collected_at: new Date().toISOString() },
        { onConflict: 'category' }
      );
    } catch (_) {}

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ mission, category, categoryKR, trendsUsed: trends.slice(0,3) }) };
  } catch (e) {
    console.error('[today-mission]', e.message);
    const { season, dayName } = getSeasonAndDay();
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ mission: fallbackMission({ categoryKR: '일반', dayName, season }), error: 'fallback' }),
    };
  }
};
