const { getStore } = require('@netlify/blobs');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
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
    const { image, bizCategory, recaptchaToken, tone } = JSON.parse(event.body || '{}');

    if (!image || !bizCategory) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '사진과 업종을 입력해주세요.' }) };
    }

    // ── reCAPTCHA v3 검증 ──
    if (process.env.RECAPTCHA_SECRET_KEY && recaptchaToken) {
      const rcRes = await fetch(`https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_SECRET_KEY}&response=${recaptchaToken}`);
      const rcData = await rcRes.json();
      if (!rcData.success || (rcData.score != null && rcData.score < 0.3)) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: '보안 검증에 실패했어요. 다시 시도해주세요.' }) };
      }
    }

    // ── IP 기반 rate limit (하루 3회) ──
    const ip = (event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown').split(',')[0].trim();
    const rateLimitKey = `demo-rate:${ip}`;
    const store = getStore({
      name: 'demo-rate',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN,
    });

    const today = new Date().toISOString().slice(0, 10);
    let rateData = { date: today, count: 0 };
    try {
      const existing = await store.get(rateLimitKey);
      if (existing) {
        rateData = JSON.parse(existing);
        if (rateData.date !== today) {
          rateData = { date: today, count: 0 };
        }
      }
    } catch (e) { /* first use */ }

    if (rateData.count >= 3) {
      return { statusCode: 429, headers, body: JSON.stringify({ error: '오늘 체험 횟수(3회)를 모두 사용했어요. 내일 다시 시도해주세요!' }) };
    }

    // ── 톤별 프롬프트 지시 ──
    const toneMap = {
      friendly: '편하게 말하듯이, ~요 체, 이모지 적절히 사용',
      formal: '정중하고 깔끔하게, ~합니다 체, 이모지 최소한으로',
      emotional: '서정적이고 따뜻하게, 문학적 표현, 줄바꿈 활용',
      humorous: '재치있고 위트있게, 말장난 OK, 밈 참조 OK',
    };
    const toneInstruction = toneMap[tone] || toneMap.friendly;

    // ── 날짜/시즌 ──
    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const dayOfWeek = ['일', '월', '화', '수', '목', '금', '토'][now.getDay()];
    const seasonMap = { 1:'겨울',2:'겨울',3:'봄',4:'봄',5:'봄',6:'여름',7:'여름',8:'여름',9:'가을',10:'가을',11:'가을',12:'겨울' };

    // ── GPT-4o 캡션 생성 ──
    const prompt = `당신은 한국 소상공인의 인스타그램 캡션을 대신 써주는 전문 카피라이터입니다.
사진 한 장과 업종 정보만으로 매력적인 캡션을 만들어주세요.

업종: ${bizCategory}
오늘: ${month}월 ${day}일 (${dayOfWeek}요일), ${seasonMap[month]}

## 말투: ${toneInstruction}

## 절대 금지
- "안녕하세요", "감사합니다" 같은 뻔한 인사/마무리
- "맛있는", "신선한" 같은 과장 형용사
- AI가 쓴 것처럼 매끄러운 문장
- 제목, 따옴표, 부연 설명

## 이런 캡션을 쓰세요
- 첫 문장에서 스크롤이 멈추는 힘
- 대표님이 직접 쓴 것 같은 자연스러움
- 이모지 2~3개, 감정을 보완하는 위치에만
- 마지막 문장은 자연스러운 행동 유도 (저장/댓글/방문)
- 사진에 메뉴판/간판이 보이면 메뉴명을 캡션에 활용

## 해시태그
총 8~10개: 대형(1~2) + 중형(3~4) + 소형(2~3)
업종 + 시즌 키워드를 섞어서 구성.

## 출력
캡션 1개 (본문 + 해시태그). 캡션만 출력하세요.`;

    const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 600,
        temperature: 0.8,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}`, detail: 'high' } },
            ],
          },
        ],
      }),
    });

    const gptData = await gptRes.json();
    if (gptData.error) {
      throw new Error(`GPT 오류: ${gptData.error.message || JSON.stringify(gptData.error)}`);
    }

    const caption = gptData.choices?.[0]?.message?.content?.trim();
    if (!caption) throw new Error('캡션 생성 실패');

    // ── rate limit 카운트 증가 ──
    rateData.count += 1;
    await store.set(rateLimitKey, JSON.stringify(rateData));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        caption,
        disclaimer: '이 캡션은 체험용입니다. 가입하시면 날씨·트렌드·말투 학습이 적용된 더 정교한 캡션을 받으실 수 있어요.',
      }),
    };
  } catch (err) {
    console.error('demo-caption error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '캡션 생성 중 오류가 발생했어요. 다시 시도해주세요.' }) };
  }
};
