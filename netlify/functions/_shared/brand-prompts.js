// 업종별 이미지·영상 프롬프트 생성기.
// GPT-4o-mini로 variationSeed에 따라 매번 다른 구도/각도를 생성.
// 규칙: 얕은 피사계심도, 시네마틱 톤, 텍스트/로고/사람 얼굴 금지.
//
// 환경변수: OPENAI_API_KEY (필수). 값은 절대 로그·응답에 노출 금지.

const OPENAI_BASE = 'https://api.openai.com/v1';
const PROMPT_TIMEOUT_MS = 30_000;

// 업종별 베이스 컨셉 (영문)
const INDUSTRY_CONCEPTS = {
  cafe:       'cozy modern cafe, golden hour light, steam rising from latte art, warm bokeh background, artisan coffee close-up',
  restaurant: 'plated gourmet dish close-up, Korean fine dining, dramatic overhead shot, sauce texture, garnish detail',
  beauty:     'serene salon interior, soft natural light, skincare bottles macro shot, clean white marble surface, dewy skin texture',
  nail:       'nail art close-up, pastel gel polish, delicate floral detail, hands resting on linen texture, soft studio light',
  flower:     'fresh floral arrangement, morning dew on petals, florist studio, shallow depth of field, muted earth tones',
  clothing:   'fashion editorial flatlay, minimalist Korean style, fabric texture detail, neutral background, soft diffused light',
  gym:        'modern gym interior, equipment detail, chalk dust in air, motivational atmosphere, industrial warm light',
};

// 구도 variation 풀 (variationSeed로 선택)
const COMPOSITION_VARIANTS = [
  'extreme close-up macro',
  'overhead flat lay',
  'low angle dramatic perspective',
  'side profile with leading lines',
  'rule of thirds composition',
  'symmetrical centered frame',
  'diagonal dynamic composition',
];

const SHARED_CONSTRAINTS = 'cinematic color grade, no text, no logos, no watermarks, no human faces, photorealistic, professional photography';

function requireApiKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY 환경변수가 설정되지 않았습니다.');
  return key;
}

async function callGptMini(systemPrompt, userPrompt) {
  const apiKey = requireApiKey();
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), PROMPT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 200,
        temperature: 0.85,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(tid);
    throw new Error(`GPT-4o-mini 요청 실패: ${e.message || 'network error'}`);
  }
  clearTimeout(tid);

  if (!res.ok) {
    let snippet = '';
    try { snippet = (await res.text()).slice(0, 200); } catch (_) {}
    throw new Error(`GPT-4o-mini HTTP ${res.status}: ${snippet}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('GPT-4o-mini 응답이 비어 있습니다.');
  return text;
}

/**
 * 업종별 이미지 프롬프트 생성 (gpt-image-1용, 세로 1024×1536)
 * @param {string} industry - cafe | restaurant | beauty | nail | flower | clothing | gym
 * @param {number} variationSeed - 0~13 (14개 슬롯 인덱스)
 * @returns {Promise<string>} 영문 프롬프트
 */
async function getImagePrompt(industry, variationSeed = 0) {
  const concept = INDUSTRY_CONCEPTS[industry];
  if (!concept) throw new Error(`알 수 없는 업종: ${industry}`);

  const composition = COMPOSITION_VARIANTS[variationSeed % COMPOSITION_VARIANTS.length];

  const systemPrompt = `You are a professional commercial photographer's art director.
Generate a single English image generation prompt (max 120 words) for a Korean SNS brand account.
Rules: ${SHARED_CONSTRAINTS}. Portrait orientation (9:16). Focus on ${composition}.`;

  const userPrompt = `Create a variation prompt for: ${concept}.
Use composition style: ${composition}.
Variation index: ${variationSeed}. Make it distinctly different from other variations.
Output only the prompt text, no explanation.`;

  return await callGptMini(systemPrompt, userPrompt);
}

/**
 * 업종별 영상 프롬프트 생성 (Sora 2용, 720×1280 8초)
 * @param {string} industry - cafe | restaurant | beauty | nail | flower | clothing | gym
 * @param {number} variationSeed - 0~13
 * @returns {Promise<string>} 영문 프롬프트
 */
async function getVideoPrompt(industry, variationSeed = 0) {
  const concept = INDUSTRY_CONCEPTS[industry];
  if (!concept) throw new Error(`알 수 없는 업종: ${industry}`);

  const composition = COMPOSITION_VARIANTS[variationSeed % COMPOSITION_VARIANTS.length];

  const systemPrompt = `You are a professional video director specializing in Korean SNS Reels.
Generate a single English video generation prompt (max 120 words) for an 8-second 9:16 Sora 2 video.
Rules: ${SHARED_CONSTRAINTS}. Subtle camera movement only. No jump cuts. Smooth cinematic motion.`;

  const userPrompt = `Create a video prompt for: ${concept}.
Use camera style: ${composition} with slow smooth movement.
Variation index: ${variationSeed}. 8 seconds, 9:16 portrait.
Output only the prompt text, no explanation.`;

  return await callGptMini(systemPrompt, userPrompt);
}

module.exports = { getImagePrompt, getVideoPrompt, INDUSTRY_CONCEPTS };
