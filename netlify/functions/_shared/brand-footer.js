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
  return `⸻

✨ 이 게시물은 사진 한 장만 올리면 lumi가 캡션·해시태그까지 전부 자동으로 만들어줬어요.
${safeIndustry} 사장님들이 매일 게시물 고민하시는 시간, 이제 2분이면 끝나요.

지금 테스터 모집 중이고, 모든 기능 무료예요.
👉 https://lumi.it.kr`;
}

async function generateBrandFooter({ industry, openaiKey } = {}) {
  const key = openaiKey || process.env.OPENAI_API_KEY;
  if (!key) {
    console.warn('[brand-footer] OPENAI_API_KEY 없음 — 폴백 사용');
    return fallbackFooter(industry);
  }

  const safeIndustry = industry || '소상공인';
  const prompt = `당신은 한국 소상공인 인스타 자동화 서비스 lumi의 SNS 카피라이터입니다.
위에는 실제 ${safeIndustry} 사장님이 올린 듯한 게시물 본문이 이미 작성돼 있습니다.
그 본문 바로 아래에 붙일 footer(= "근데 사실 이 게시물, AI가 만들었어요" 하고 밝히는 짧은 안내)를 작성하세요.

[필수 포함 포인트 — 순서 자유, 문구는 당신이 자연스럽게]
1. **"사진 한 장만 올리면 캡션·해시태그까지 자동 완성"** — lumi가 하는 일을 한 문장으로 증명
2. ${safeIndustry} 사장님 공감 포인트 — 매일 게시물 고민·소재 고갈·문구 막막함 중 하나를 한 줄
3. **지금 테스터 모집 중, 모든 기능 무료** — 꼭 "무료" 단어 들어가야 함
4. CTA 링크: https://lumi.it.kr

[구조·톤]
- 맨 위에 구분선(⸻ 또는 ───) 한 줄로 본문과 시각적으로 분리
- 전체 4~6줄. 짧은 문장들을 줄바꿈으로 배치 (벽돌처럼 붙이지 말 것)
- 이모지는 ✨ 또는 👉 중 1~2개만. 남발 금지
- 캐주얼하고 친근하게. "~해요"체
- 광고 뻘소리 금지: "최고", "유일한", "혁신", "완벽한", "압도적", "대박" 등 사용 금지
- 의료·효능·단정 표현 금지
- 링크는 반드시 https://lumi.it.kr (lumi.it.kr 문자열 반드시 포함)
- 설명·제목·따옴표·코드블록 없이 footer 본문만 출력

출력 예시 톤 (이대로 복붙 금지, 참고만):
⸻

✨ 이 게시물, 사실 사진 한 장만 올렸더니 lumi가 캡션이랑 해시태그까지 다 만들어줬어요.
매일 뭐 올리지 고민하는 시간, 이제 2분이면 돼요.

지금 테스터 모집 중, 전 기능 무료예요.
👉 https://lumi.it.kr`;

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
