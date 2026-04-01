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
    const { image, bizCategory, recaptchaToken } = JSON.parse(event.body || '{}');

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
      siteID: process.env.NETLIFY_SITE_ID,
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

    // ── GPT-4o 캡션 생성 ──
    const prompt = `당신은 한국 소상공인의 인스타그램 캡션을 대신 써주는 전문 카피라이터입니다.
사진 한 장과 업종 정보만으로 매력적인 캡션을 만들어주세요.

## 절대 금지
- "안녕하세요", "오늘도 찾아주셔서 감사합니다" 같은 뻔한 인사
- "맛있는", "신선한", "정성스러운" 같은 과장 형용사 남발
- AI가 쓴 것처럼 매끄럽고 완벽한 문장
- "많은 관심 부탁드립니다", "놀러 오세요" 같은 전형적 마무리
- 설명, 제목, 따옴표, 부연 없이 캡션만 바로 출력

## 좋은 캡션
- 읽는 사람이 그 순간을 상상할 수 있는 글
- 대표님이 직접 쓴 것처럼 자연스러운 말투
- 첫 문장이 스크롤을 멈추게 만드는 힘
- 이모지가 글의 감정을 정확히 보완하는 위치
- 해시태그가 탐색 도구처럼 자연스러움

## 입력 정보
업종: ${bizCategory}
사진: 첨부 이미지 분석 결과를 기반으로 작성

## 출력
캡션 1개 (본문 + 해시태그 5~8개 포함). 캡션만 출력하세요.`;

    const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 500,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}`, detail: 'low' } },
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
