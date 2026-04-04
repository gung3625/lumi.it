const { getStore } = require('@netlify/blobs');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    // ── 토큰 인증 ──
    const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: '로그인이 필요합니다.' }) };
    }

    const usersStore = getStore({
      name: 'users',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_TOKEN,
    });

    const tokenData = await usersStore.get('token:' + token);
    if (!tokenData) {
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
- "안녕하세요", "오늘도 찾아주셔서 감사합니다" 같은 뻔한 인사
- "맛있는", "신선한", "정성스러운" 같은 과장 형용사 남발
- AI가 쓴 것처럼 매끄럽고 완벽한 문장
- "많은 관심 부탁드립니다", "놀러 오세요" 같은 전형적 마무리
- AI임을 드러내는 표현

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
    "caption": "오늘(${month}월 ${day}일 ${dayOfWeek}요일) 날씨·기온·분위기를 자연스럽게 녹인 캡션. 해시태그 5~8개 포함."
  },
  {
    "type": "트렌드 반영",
    "caption": "${season} 시즌 트렌드, 요즘 유행하는 키워드·밈·시즌 이벤트를 반영한 캡션. 해시태그 5~8개 포함."
  },
  {
    "type": "기본",
    "caption": "가게의 일상을 담은 표준 캡션. 해시태그 5~8개 포함."
  }
]`;

    const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 1500,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
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
