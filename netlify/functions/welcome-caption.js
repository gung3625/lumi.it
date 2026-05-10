const { corsHeaders, getOrigin } = require('./_shared/auth');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { checkAndIncrementQuota, QuotaExceededError } = require('./_shared/openai-quota');


exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    // ── Bearer 토큰 검증 ──
    const token = extractBearerToken(event);
    if (!token) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: '로그인이 필요합니다.' }) };
    }
    const { user, error: authError } = await verifyBearerToken(token);
    if (authError || !user) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: '유효하지 않은 인증입니다.' }) };
    }

    // ── 입력 파싱 ──
    const { bizCategory, storeName, region, captionTone } = JSON.parse(event.body || '{}');

    if (!bizCategory || !storeName) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '업종과 가게 이름을 입력해주세요.' }) };
    }

    // ── 톤별 프롬프트 지시 ──
    const toneMap = {
      friendly: '편하게 말하듯이, ~요 체, 이모지 적절히 사용',
      formal: '정중하고 깔끔하게, ~합니다 체, 이모지 최소한으로',
      emotional: '서정적이고 따뜻하게, 문학적 표현, 줄바꿈 활용',
      humorous: '재치있고 위트있게, 말장난 OK, 밈 참조 OK',
    };
    const toneInstruction = toneMap[captionTone] || toneMap.friendly;

    // ── 현재 날짜·계절 정보 ──
    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const dayOfWeek = ['일', '월', '화', '수', '목', '금', '토'][now.getDay()];
    const seasonMap = { 1: '겨울', 2: '겨울', 3: '봄', 4: '봄', 5: '봄', 6: '여름', 7: '여름', 8: '여름', 9: '가을', 10: '가을', 11: '가을', 12: '겨울' };
    const season = seasonMap[month];

    // ── GPT-5.4 캡션 3개 생성 (온보딩 데모: 사진 없이 가게 정보만으로) ──
    const prompt = `당신은 한국 소상공인의 인스타그램 캡션을 대신 써주는 전문 카피라이터입니다.
사장님이 첫 게시물을 어떻게 시작할지 감을 잡도록, 가게 정보만으로 캡션 3개 시안을 보여줍니다.

## 가게 정보
- 가게 이름: ${storeName} (본문/해시태그에 절대 등장시키지 말 것)
- 업종: ${bizCategory}
- 지역: ${region || '미지정'}

## 오늘
- ${month}월 ${day}일 (${dayOfWeek}요일) · ${season}

## 말투
${toneInstruction}

## 절대 금지 (위반 = 폐기)
1. 매장명("${storeName}") 본문/해시태그 등장 금지. "${storeName}에서/${storeName} 오늘은" 같은 시작/포함 문장 금지. "@${storeName}" 멘션도 금지. 해시태그 #${storeName}, #${(storeName || '').replace(/\s+/g,'')} 금지.
2. 사진을 보지 않고 쓰는 캡션이라, 구체 메뉴/제품/시술/가격/효능 단정 금지. "오늘의 한 잔", "한 그릇" 같이 추상적으로.
3. AI 클리셰: "안녕하세요", "맛있는", "신선한", "정성스러운", "감성 가득", "프리미엄", "잊지 못할", "최고의", "한 번쯤", "꼭 한 번", "특별한 경험", "퀄리티".
4. 번역체: "~을 즐기실 수 있는", "~을 만나보세요", "~을 경험해보세요".
5. 홍보 멘트: "DM 부탁드립니다", "예약 문의 환영", "많은 관심 부탁드려요", "놀러 오세요".
6. 경쟁사/타 브랜드: 스타벅스·올리브영 등 직접 언급 금지.
7. 과대광고/효능 단정: "업계 1위", "최고", "가성비 최강", "피부에 좋은", "다이어트 효과", "무첨가", "100%", "유기농".
8. 종교·정치 이슈, 성적 표현, 외모 평가, 욕설, 연예인 무단 사용, 저작권 있는 가사/대사 인용 금지.
9. "품절 임박", "놓치면 끝" 같은 불안 조성 표현 금지.

## 좋은 캡션
- 첫 문장이 스크롤을 멈추게 함 (질문형/감성형/직관형 중 하나)
- 사장님 1인칭 시점, 단골에게 말하듯
- 이모지는 감정 보완용 1~3개
- 해시태그는 본문 마지막 한 블록. 5~10개. ${season} 시즌과 ${bizCategory} 업종에 자연스러운 것만.

## 길이
첫 125자에 훅+가치. 본문 전체 250~500자.

## 출력 형식 (JSON 만)
\`\`\`json
[
  { "type": "날씨 반영", "caption": "오늘(${month}/${day} ${dayOfWeek}요일) 날씨·기온·분위기를 자연스럽게 녹인 캡션. 본문 + 해시태그." },
  { "type": "트렌드 반영", "caption": "${season} 시즌 분위기·요즘 인스타 키워드를 자연스럽게 녹인 캡션. 본문 + 해시태그." },
  { "type": "기본", "caption": "가게 일상의 단면을 담은 표준 캡션. 본문 + 해시태그." }
]
\`\`\`
다른 텍스트 없이 JSON 배열만.`;

    // Quota 검증 (gpt-4o ₩50/호출)
    try {
      await checkAndIncrementQuota(user.id, 'gpt-4o');
    } catch (e) {
      if (e instanceof QuotaExceededError) {
        return { statusCode: 429, headers, body: JSON.stringify({ error: e.message }) };
      }
      throw e;
    }

    const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        // GPT-5 series: max_tokens deprecated → max_completion_tokens
        max_completion_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const gptData = await gptRes.json();
    if (gptData.error) {
      throw new Error(`GPT 오류: ${gptData.error.message || JSON.stringify(gptData.error)}`);
    }

    const raw = gptData.choices?.[0]?.message?.content?.trim();
    if (!raw) throw new Error('캡션 생성 실패');

    // ── JSON 파싱 (코드블록 제거) ──
    const jsonStr = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
    let captions;
    try {
      captions = JSON.parse(jsonStr);
    } catch (parseErr) {
      throw new Error('캡션 파싱 실패');
    }

    // DB 저장 없음 — welcome-caption은 응답만 반환 (첫 방문 데모)
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ captions }),
    };
  } catch (err) {
    console.error('welcome-caption error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '캡션 생성 중 오류가 발생했어요. 다시 시도해주세요.' }) };
  }
};
