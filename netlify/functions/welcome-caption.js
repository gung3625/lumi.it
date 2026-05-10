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

    // ── GPT-4o 캡션 3개 생성 ──
    const prompt = `당신은 한국 소상공인의 인스타그램 캡션을 대신 써주는 전문 카피라이터입니다.
가게 정보만으로 매력적인 캡션 3개를 만들어주세요.

## 가게 정보
- 가게 이름: ${storeName}
- 업종: ${bizCategory}
- 지역: ${region || '미지정'}

## 오늘 날짜 정보
- ${month}월 ${day}일 (${dayOfWeek}요일)
- 계절: ${season}

## 말투 지시
${toneInstruction}

## 절대 금지
- 매장명("${storeName}") 본문 직접 언급 금지 — 프로필에 이미 노출되므로 "${storeName}에서", "${storeName} 오늘은" 같이 매장명으로 시작·포함되는 문장 금지
- 해시태그에 매장명 태그(#${storeName}, #${(storeName || '').replace(/\s+/g,'')}) 금지
- "안녕하세요", "오늘도 찾아주셔서 감사합니다" 같은 뻔한 인사
- "맛있는", "신선한", "정성스러운" 같은 과장 형용사 남발
- AI가 쓴 것처럼 매끄럽고 완벽한 문장
- "많은 관심 부탁드립니다", "놀러 오세요" 같은 전형적 마무리
- AI임을 드러내는 표현
- 경쟁사/타 브랜드 이름 언급 금지 (스타벅스, 올리브영 등)
- "업계 1위", "최고", "가성비 최강" 같은 과대광고 표현 금지
- 의학적/건강 효능 단정 금지 ("피부에 좋은", "다이어트에 효과적인")
- "무첨가", "100% 천연", "유기농" 등 법적 위험 표현 금지
- 종교/정치/사회적 논란 이슈 언급 금지
- 성적/선정적 표현, 외모 평가 금지
- 욕설, 비속어, 은어 금지
- 연예인/유명인 이름 동의 없이 사용 금지
- 저작권 있는 노래 가사/영화 대사 인용 금지
- 고객 비하, 강요, 불안 조성 표현 금지 ("품절 임박", "놓치면 끝")
- 가격 비교, 할인율 단정 금지

## 좋은 캡션
- 읽는 사람이 그 순간을 상상할 수 있는 글
- 대표님이 직접 쓴 것처럼 자연스러운 말투
- 첫 문장이 스크롤을 멈추게 만드는 힘
- 이모지가 글의 감정을 정확히 보완하는 위치
- 해시태그가 탐색 도구처럼 자연스러움

## 출력 형식
반드시 아래 JSON 형식으로만 출력하세요. 다른 텍스트 없이 JSON만 출력하세요.
[
  {
    "type": "날씨 반영",
    "caption": "오늘(${month}월 ${day}일 ${dayOfWeek}요일) 날씨·기온·분위기를 자연스럽게 녹인 캡션. 요즘 인스타 트렌드에 맞는 해시태그 포함."
  },
  {
    "type": "트렌드 반영",
    "caption": "${season} 시즌 트렌드, 요즘 유행하는 키워드·밈·시즌 이벤트를 반영한 캡션. 요즘 인스타 트렌드에 맞는 해시태그 포함."
  },
  {
    "type": "기본",
    "caption": "가게의 일상을 담은 표준 캡션. 요즘 인스타 트렌드에 맞는 해시태그 포함."
  }
]`;

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
        max_tokens: 1500,
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
