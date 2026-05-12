// 업종별 이미지·영상 프롬프트 생성기.
// GPT-4o-mini로 variationSeed에 따라 매번 다른 구도/각도를 생성.
// 규칙: 얕은 피사계심도, 시네마틱 톤, 텍스트/로고/사람 얼굴 금지.
//
// 환경변수: OPENAI_API_KEY (필수). 값은 절대 로그·응답에 노출 금지.

const { utcToKstDate } = require('./kst-utils');

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

  // 현재 월·계절 컨텍스트 (시즌감 녹이기용)
  const kstMonth = utcToKstDate(new Date()).getUTCMonth() + 1;
  const seasonMap = { 1:'겨울',2:'겨울',3:'봄',4:'봄',5:'봄',6:'초여름',7:'여름',8:'여름',9:'초가을',10:'가을',11:'늦가을',12:'겨울' };
  const season = seasonMap[kstMonth];

  const hashtagSeed = industry === 'cafe' ? '#카페스타그램 #데일리카페 #동네카페 #커피스타그램'
    : industry === 'restaurant' ? '#맛집추천 #맛스타그램 #동네맛집 #오늘뭐먹지'
    : industry === 'beauty' ? '#뷰티스타그램 #데일리뷰티 #홈케어 #스킨케어일상'
    : industry === 'nail' ? '#네일아트 #네일스타그램 #데일리네일 #젤네일'
    : industry === 'flower' ? '#플라워샵 #꽃스타그램 #꽃선물 #일상꽃'
    : industry === 'clothing' ? '#데일리룩 #오오티디 #옷스타그램 #오늘의룩'
    : '#오운완 #헬스타그램 #운동일상 #홈트';

  const systemPrompt = `당신은 한국 동네 ${industryLabel} 사장님의 인스타 캡션을 대필하는 전문 카피라이터입니다.
"사장님이 직접 쓴 것처럼" 자연스러운 캡션을 만드는 게 유일한 성공 기준입니다.
당신이 쓴 글을 읽은 사람이 "이거 AI가 쓴 거지?"라고 느끼면 실패. "이 사장님 감성 있네"라고 느끼면 성공.`;

  const userPrompt = `## 컨텍스트
- 업종: ${industryLabel}
- 미디어: ${mediaLabel}
- 오늘 계절: ${season} (${kstMonth}월)

## 절대 금지 (하나라도 어기면 실패)
1. AI 특유의 뻔한 표현 — "안녕하세요", "오늘도 찾아주셔서 감사합니다", "많은 관심 부탁드립니다", "놀러 오세요", "맛있는", "신선한", "정성스러운", "향긋한"
2. 과장 광고 — "최고", "유일한", "완벽한", "대박", "혁신적", "압도적"
3. 법적 위험 — 의료 효능("피부에 좋은", "다이어트 효과"), 미인증 표시("무첨가","유기농","100% 천연"), 가격 단정, 고객 반응 날조
4. 경쟁사/타 브랜드명 (스타벅스, 올리브영 등)
5. 특정 메뉴명·제품명 지어내기 (사진이 없는 상태라 지어내면 들통남)
6. 고객 호명·전화번호·개인정보
7. "lumi" 언급 금지 — footer에 따로 붙음

## 최상위 품질 기준
- **첫 문장이 스크롤을 멈추게 해야 함** — 3가지 앵글 중 가장 강렬한 것 선택: 질문형 / 감성형 / 직관형
- 본문은 **${industryLabel} 사장님의 그날의 한 장면**처럼 — 업종 특유의 소소한 디테일을 녹임
  · 카페: 잔을 내려놓는 소리, 커피머신 스팀, 단골 오신 오후
  · 음식점: 오픈 준비, 재료 손질, 반찬 내는 순간
  · 뷰티: 시술 전후 차이, 손님과의 대화 한 조각
  · 네일: 컬러 고민, 완성 후 만족, 시즌 디자인
  · 꽃집: 입고 꽃 풀기, 포장 리본, 받을 사람 상상
  · 의류: 입고 날 아침, 핏 체크, 계절 코디
  · 피트니스: 새벽 오픈, 땀, 작은 성취
- **${season}의 공기감**을 한 문장에 자연스럽게 녹일 것 ("요즘 같은 ${season}엔" 같이 계절 단어로 시작하진 말 것)
- 이모지 0~2개만. 감정을 보완하는 위치에만. 남발 금지.
- 줄바꿈 2~3번으로 호흡 만들기. 벽돌 문단 금지.
- 마지막 문장은 **자연스러운 유도**: "오늘 이거 생각나는 사람?", "댓글로 알려주세요", "저장해두면 좋아요" 같은 일상 톤

## 본문 길이
3~5줄. 짧고 담백하되, 정서가 남는 길이.

## 해시태그 (본문 마지막 한 줄 비우고 한 블록)
- 8~12개 — 실제 사장님들이 다는 양
- 구성: 대형 1~2개 + 중형 3~5개 + 소형·감성 3~5개
- 반드시 포함 대형 시드: ${hashtagSeed}
- ${season} 시즌감 태그 1~2개 추가 (예: 봄 → #봄감성, 가을 → #가을타는중)
- 업종 무관 밈성 태그 금지

## 출력 형식
설명·제목·따옴표·코드블록 없이 **캡션 본문 + 빈 줄 + 해시태그**만 출력.`;

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
        model: 'gpt-4o',
        max_tokens: 900,
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
