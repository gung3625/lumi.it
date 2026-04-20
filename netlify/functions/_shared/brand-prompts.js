// 업종별 이미지·영상 프롬프트 생성기.
// GPT-4o-mini로 variationSeed에 따라 매번 다른 구도/각도를 생성.
// 규칙: 얕은 피사계심도, 시네마틱 톤, 텍스트/로고/사람 얼굴 금지.
//
// 환경변수: OPENAI_API_KEY (필수). 값은 절대 로그·응답에 노출 금지.

const OPENAI_BASE = 'https://api.openai.com/v1';
const PROMPT_TIMEOUT_MS = 30_000;

// 업종별 베이스 컨셉 (영문) — 한국 동네 자영업 평균 현실감 톤
// 매거진 편집샷 금지, 스마트폰 스냅처럼 자연스럽고 평범하게.
const INDUSTRY_CONCEPTS = {
  cafe:       'typical Korean neighborhood cafe interior, plain wooden table, ordinary latte in a regular ceramic mug, natural daylight through window, realistic everyday atmosphere',
  restaurant: 'everyday Korean restaurant dish on a simple plate, 반찬 side dishes in small bowls visible, ordinary stainless or melamine tableware, typical casual 식당 table setting',
  beauty:     'everyday Korean skincare routine shelf, a mix of mid-range product bottles, normal bathroom or vanity lighting, realistic home setup',
  nail:       'regular Korean nail salon hand close-up, realistic gel polish, ordinary manicure table, standard fluorescent salon light',
  flower:     'neighborhood Korean flower shop bouquet wrapped in kraft paper, shop counter with scissors and ribbon, casual everyday florist vibe',
  clothing:   'everyday clothing rack inside a small Korean boutique, casual hanger shot, ordinary store lighting, realistic retail floor',
  gym:        'regular Korean neighborhood gym with ordinary equipment, fluorescent ceiling lights, realistic sweat towel on bench, no-frills practical setup',
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

const SHARED_CONSTRAINTS = 'photorealistic everyday scene, natural unfiltered color, smartphone snapshot feel, no text, no logos, no watermarks, no human faces, avoid luxury/editorial/magazine aesthetic, avoid dramatic cinematic lighting, show average Korean small-business reality';

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

  const systemPrompt = `You are writing a realistic phone-shot style video prompt for a Korean small-business SNS Reel.
Generate a single English video generation prompt (max 120 words) for an 8-second 9:16 Sora 2 video.
Rules: ${SHARED_CONSTRAINTS}. Subtle handheld or locked camera — no dramatic zooms, no jump cuts, no cinematic dolly moves. Natural everyday motion only.`;

  const userPrompt = `Create a video prompt for: ${concept}.
Use camera style: ${composition} with slow smooth movement.
Variation index: ${variationSeed}. 8 seconds, 9:16 portrait.
Output only the prompt text, no explanation.`;

  return await callGptMini(systemPrompt, userPrompt);
}

// 업종 한글 라벨 (캡션 생성 프롬프트용)
const INDUSTRY_LABELS = {
  cafe:       '카페',
  restaurant: '음식점',
  beauty:     '뷰티샵',
  nail:       '네일샵',
  flower:     '꽃집',
  clothing:   '의류 편집샵',
  gym:        '피트니스 센터',
};

/**
 * 브랜드 자동 게시용 캡션 생성 (GPT-4o-mini).
 * 업종별로 친근한 자영업 톤 + 해시태그 3~5개. 브랜드 푸터는 호출측에서 append.
 * @param {'cafe'|'restaurant'|'beauty'|'nail'|'flower'|'clothing'|'gym'} industry
 * @param {'image'|'video'} contentType
 * @returns {Promise<{ caption: string }>}
 */
async function getBrandCaption(industry, contentType) {
  const industryLabel = INDUSTRY_LABELS[industry] || '소상공인';
  const mediaLabel = contentType === 'video' ? '짧은 릴스 영상' : '감성 이미지';

  const systemPrompt = `당신은 한국 자영업자의 인스타 캡션을 대신 써주는 카피라이터입니다.
말투는 동네 단골한테 이야기하듯 친근하고 담백하게. 광고 티 없이.
이모지 금지. 과장 표현("최고","유일한","완벽한") 금지. 효능·의료 표현 금지.`;

  const userPrompt = `아래 조건으로 인스타 피드 캡션을 1개만 작성하세요.

업종: ${industryLabel}
미디어: ${mediaLabel}

[캡션 규칙]
- 본문 2~4줄. 한 줄은 짧게 끊어서.
- 첫 문장은 스크롤을 멈추게 하는 감성 한 문장.
- 이모지 사용 금지 (텍스트만).
- 가격·시간·수치 단정 금지. 특정 메뉴 이름 지어내지 말 것.
- 경쟁사/타 브랜드 언급 금지.

[해시태그]
- 본문 마지막 줄바꿈 후 한 블록으로.
- 3~5개. 업종과 직접 관련된 것만.
- 예시: #${industry === 'cafe' ? '카페스타그램' : industry === 'restaurant' ? '맛집추천' : industry === 'beauty' ? '뷰티스타그램' : industry === 'nail' ? '네일아트' : industry === 'flower' ? '플라워샵' : industry === 'clothing' ? '데일리룩' : '오운완'}

[출력 형식]
설명/제목/따옴표 없이 캡션 본문 + 해시태그만 출력.`;

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
        max_tokens: 400,
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
    throw new Error(`getBrandCaption 요청 실패: ${e.message || 'network error'}`);
  }
  clearTimeout(tid);

  if (!res.ok) {
    let snippet = '';
    try { snippet = (await res.text()).slice(0, 200); } catch (_) {}
    throw new Error(`getBrandCaption HTTP ${res.status}: ${snippet}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('getBrandCaption 응답이 비어 있습니다.');
  return { caption: text };
}

module.exports = { getImagePrompt, getVideoPrompt, getBrandCaption, INDUSTRY_CONCEPTS, INDUSTRY_LABELS };
