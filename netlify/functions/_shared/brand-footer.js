// lumi 브랜드 캡션 footer 생성.
// 매일 자동 게시(브랜드 계정 @lumi__it) 캡션 마지막에 붙이는 홍보 문구.
// GPT-4o-mini로 variation 확보, 실패 시 하드코딩 폴백.
//
// 호출: generateBrandFooter({ industry, openaiKey }) → 문자열
// - industry: 업종 한글 라벨 (예: '카페', '음식점', '뷰티샵')
// - openaiKey: process.env.OPENAI_API_KEY (함수 내부에서 읽지 않고 명시적으로 주입)

const FOOTER_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const FOOTER_TIMEOUT_MS = 20_000;

function fallbackFooter(industry) {
  const safeIndustry = industry || '소상공인';
  return `✨ 이 콘텐츠는 lumi가 자동 생성했어요.
${safeIndustry} 사장님들을 위한 인스타 자동화 서비스,
지금 베타 테스터 모집 중이에요.
자세히 보기 → https://lumi.it.kr`;
}

async function generateBrandFooter({ industry, openaiKey } = {}) {
  const key = openaiKey || process.env.OPENAI_API_KEY;
  if (!key) {
    console.warn('[brand-footer] OPENAI_API_KEY 없음 — 폴백 사용');
    return fallbackFooter(industry);
  }

  const safeIndustry = industry || '소상공인';
  const prompt = `당신은 한국 소상공인 인스타 자동화 서비스 lumi의 SNS 카피라이터입니다.
오늘 게시 콘텐츠 업종: ${safeIndustry}

아래 조건을 모두 충족하는 인스타 캡션 footer 문구를 한국어로 1개만 작성하세요.

[필수 포함]
- "이 콘텐츠는 lumi가 자동 생성" 이라는 뉘앙스의 표현 (토씨 똑같이 아니어도 OK)
- 베타 테스터 모집 중임을 알리는 한 줄
- CTA 링크: https://lumi.it.kr

[톤·형식]
- 3~4줄, 캐주얼하고 친근한 톤
- ✨ 이모지를 1개 이상 자연스럽게 사용
- 과장·광고 문구 금지 ("최고", "유일한", "완벽한" 등 사용 금지)
- 의료·효능 표현 금지
- 줄바꿈으로 가독성 확보
- 설명·제목·따옴표 없이 footer 본문만 출력`;

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), FOOTER_TIMEOUT_MS);
  try {
    const res = await fetch(FOOTER_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 0.9,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn('[brand-footer] OpenAI HTTP', res.status, '— 폴백 사용');
      return fallbackFooter(industry);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) {
      console.warn('[brand-footer] 빈 응답 — 폴백 사용');
      return fallbackFooter(industry);
    }
    // 최소 검증: lumi.it.kr 링크가 없으면 폴백
    if (!text.includes('lumi.it.kr')) {
      console.warn('[brand-footer] CTA 링크 누락 — 폴백 사용');
      return fallbackFooter(industry);
    }
    return text;
  } catch (e) {
    console.warn('[brand-footer] 예외 — 폴백 사용:', e.message);
    return fallbackFooter(industry);
  } finally {
    clearTimeout(tid);
  }
}

module.exports = { generateBrandFooter };
