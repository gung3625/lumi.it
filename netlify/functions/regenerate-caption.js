const { getStore } = require('@netlify/blobs');
const OpenAI = require('openai');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function getReservationStore() {
  return getStore({
    name: 'reservations',
    consistency: 'strong',
    siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
    token: process.env.NETLIFY_TOKEN,
  });
}

function getRegenStore() {
  return getStore({
    name: 'caption-regen',
    consistency: 'strong',
    siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
    token: process.env.NETLIFY_TOKEN,
  });
}

function getMonthKey(email) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return `caption-regen:${email}:${yyyy}-${mm}`;
}

function buildToneGuide(toneLikes, toneDislikes) {
  let guide = '';
  if (toneLikes) {
    const items = toneLikes.split('|||').filter(Boolean);
    if (items.length) guide += '✅ 좋아했던 스타일:\n' + items.map(i => '- ' + i.trim()).join('\n') + '\n';
  }
  if (toneDislikes) {
    const items = toneDislikes.split('|||').filter(Boolean);
    if (items.length) guide += '❌ 싫어했던 스타일:\n' + items.map(i => '- ' + i.trim()).join('\n');
  }
  return guide;
}

function buildCaptionPrompt(item, imageAnalysis, toneGuide) {
  const w = item.weather || {};
  const sp = item.storeProfile || {};
  const trends = Array.isArray(item.trends) ? item.trends.join(', ') : (item.trends || '');

  const weatherBlock = w.status
    ? `날씨: ${w.status}${w.temperature ? ' / ' + w.temperature + '°C 체감' : ''}${w.mood ? '\n분위기: ' + w.mood : ''}${w.guide ? '\n가이드: ' + w.guide : ''}${w.locationName ? '\n위치: ' + w.locationName : ''}
숫자 직접 쓰지 말 것. "오늘처럼 선선한 날엔" ✅${w.airQuality ? '\n초미세먼지: ' + w.airQuality + ' (수치/등급 직접 언급 금지)' : ''}`
    : '날씨 정보 없음 — 날씨 언급하지 마세요.';

  const trendBlock = trends
    ? `트렌드 태그: ${trends}${item.trendInsights ? '\n\n[업종 트렌드 인사이트]\n' + item.trendInsights + '\n\n위 트렌드를 참고하되 반드시 아래 규칙을 지키세요:\n- 트렌드는 캡션의 분위기/감성에만 반영. 직접 설명하거나 인용하지 마세요\n- 사진에 실제로 보이는 것과 연결되는 트렌드만 활용\n- 경쟁사/타 브랜드명은 절대 언급하지 마세요\n- "요즘 유행", "SNS에서 화제" 같은 직접적 트렌드 언급 금지\n- 해시태그에는 트렌드 키워드 2~3개를 자연스럽게 포함' : '\n1~2개만 본문에 녹이고, 나머지는 해시태그에 포함.'}`
    : '트렌드 정보 없음.';

  const eventBlock = item.nearbyEvent && item.nearbyFestivals
    ? `근처 행사: ${item.nearbyFestivals}\n자연스럽게 한마디만.`
    : '';

  const storeBlock = [
    sp.name ? `매장명: ${sp.name}` : '',
    sp.category || item.bizCategory ? `업종: ${sp.category || item.bizCategory}` : '',
    sp.region ? `지역: ${sp.region}` : '',
    sp.description ? `소개: ${sp.description}` : '',
    sp.instagram ? `인스타: ${sp.instagram}` : '',
  ].filter(Boolean).join('\n');

  return `당신은 한국 소상공인의 인스타그램 캡션을 대신 써주는 전문 카피라이터입니다.
이전 캡션과 완전히 다른 새로운 캡션 3개를 만들어주세요.

## 절대 금지
- "안녕하세요", "감사합니다" 같은 뻔한 인사/마무리
- "맛있는", "신선한" 같은 과장 형용사
- AI가 쓴 것처럼 매끄러운 문장
- 기온 숫자, 미세먼지 수치/등급 직접 언급
- 제목, 따옴표, 부연 설명 없이 캡션만 출력

## 트렌드 활용 시 절대 금지
- 경쟁사/타 브랜드 이름 직접 언급 금지 (예: "스타벅스에서도 나온", "메가커피처럼")
- "업계 1위", "최고", "최저가", "가성비 최강" 같은 과대광고 표현 금지
- 검증되지 않은 트렌드를 사실처럼 단정 금지 (예: "전국민이 열광하는", "올해 가장 핫한")
- 의학적/건강 효능 단정 금지 (예: "피부에 좋은", "다이어트에 효과적인")
- 가격 비교, 할인율 단정 금지
- 트렌드 정보를 직접 설명하지 말 것 → 분위기/감성으로만 녹일 것
  ✅ "요즘 이 보랏빛에 다들 시선 빼앗기더라고요" (분위기)
  ❌ "요즘 우베라떼가 SNS에서 대유행이래요" (직접 설명)

## 추가 절대 금지 사항

### 종교/정치/민감 이슈
- 특정 종교 언급 금지 ("교회 앞 카페", "절 근처 맛집")
- 정치적 발언/입장 금지 ("선거", "정당", "대통령")
- 사회적 논란 이슈 언급 금지 (젠더, 차별, 혐오)
- 특정 국가/민족 비하 또는 편향적 표현 금지

### 법적 위험 표현
- "무첨가", "100% 천연", "유기농" — 인증 없이 사용 금지
- "의사 추천", "효과 보장", "치료" — 의료법 위반
- "특허", "인증", "수상" — 실제 인증 여부 모르면 사용 금지

### 감정/톤 위험
- 고객 비하 금지 ("아직도 모르세요?", "이것도 몰라요?")
- 강요 금지 ("꼭 와야 해요", "안 오면 후회")
- 불안 조성 금지 ("품절 임박", "마지막 기회", "놓치면 끝")

### 개인정보/프라이버시
- 고객 이름, 전화번호 등 개인정보 노출 금지
- "단골 OO님" 같은 특정 고객 지칭 금지

### 성적/선정적 표현
- 성적 암시, 외모 평가 금지 ("예쁜 사장님이 만든")

### 기타
- 욕설, 비속어, 은어 금지
- 저작권 있는 노래 가사, 영화 대사 인용 금지
- 연예인/유명인 이름을 동의 없이 사용 금지
- 사진에 없는 메뉴를 트렌드라고 넣지 말 것
- "이번 주까지만", "곧 품절" 같은 시간/시기 단정 금지
- "손님들이 다 좋아하세요" 같은 고객 반응 날조 금지

## 이런 캡션을 쓰세요
- 첫 문장에서 스크롤이 멈춤
- 이모지 2~4개, 감정을 보완하는 위치에만 (연속 금지)
- 마지막 문장은 행동 유도 (저장/공유/댓글/방문 중 자연스러운 것)

---

## 입력 정보

### 이미지 분석
${imageAnalysis}

### 대표님 코멘트
${item.userMessage || '(없음)'}

### 날씨
${weatherBlock}

### 트렌드
${trendBlock}

${eventBlock ? '### 주변 행사\n' + eventBlock : ''}

### 매장 정보
${storeBlock || '(정보 없음)'}

### 사진 수: ${item.photoCount || (item.photos ? item.photos.length : 1)}장

---

## 말투

스타일: ${item.captionTone || '친근하게'}
- 친근하게: ~했어요, ~더라고요 / 감성적으로: 짧은 문장, 여백 / 재미있게: 유머, 반전 / 시크하게: 말 적고 여백 / 신뢰감 있게: 정중하되 딱딱하지 않게

${toneGuide ? '### 말투 학습\n' + toneGuide + '\n✅ 좋아요 계승 / ❌ 싫어요 회피' : ''}

---

## 해시태그 전략

총 8~12개: 대형(1~2) + 중형(3~4) + 소형(2~3) + 트렌드(사진과 관련 있는 것만 2~3) + 지역(1)
**절대 규칙:** 사진 내용과 직접 관련 없는 해시태그 금지. 트렌드/인기 태그라도 사진과 무관하면 사용 금지.
캡션 본문 마지막에 줄바꿈 후 한 블록.

---

## 캡션 3개 (이전과 완전히 다르게)

**버전 1 — 스토리텔링** (5~8줄)
**버전 2 — 짧고 강렬** (2~3줄)
**버전 3 — 정보형** (4~6줄)

---CAPTION_1---
[캡션 본문 + 해시태그]
---END_1---

---CAPTION_2---
[캡션 본문 + 해시태그]
---END_2---

---CAPTION_3---
[캡션 본문 + 해시태그]
---END_3---`;
}

function parseCaptions(text) {
  const captions = [];
  for (let i = 1; i <= 3; i++) {
    const regex = new RegExp(`---CAPTION_${i}---([\\s\\S]*?)---END_${i}---`);
    const match = text.match(regex);
    if (match) captions.push(match[1].trim());
  }
  return captions;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Bad Request' }) };
  }

  const { reservationKey, email } = body;

  // Bearer 토큰 인증
  const authHeader = event.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ') || authHeader.length < 10) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증 실패' }) };
  }

  if (!reservationKey) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'reservationKey 필수' }) };
  }
  if (!email) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'email 필수' }) };
  }

  try {
    const reserveStore = getReservationStore();
    const regenStore = getRegenStore();

    // 1. 월별 재생성 횟수 체크
    const monthKey = getMonthKey(email);
    let count = 0;
    try {
      const countRaw = await regenStore.get(monthKey);
      if (countRaw) count = parseInt(countRaw, 10) || 0;
    } catch (_) {}

    if (count >= 3) {
      return {
        statusCode: 429,
        headers: CORS,
        body: JSON.stringify({
          error: '이번 달 재생성 횟수를 모두 사용했어요 (월 3회)',
          remaining: 0,
        }),
      };
    }

    // 2. Blobs에서 reservationKey로 예약 데이터 조회
    const raw = await reserveStore.get(reservationKey);
    if (!raw) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '예약 데이터를 찾을 수 없어요' }) };
    }
    const item = JSON.parse(raw);

    // 3. 예약 데이터에서 이미지 분석 결과 가져오기
    const imageAnalysis = item.imageAnalysis;
    if (!imageAnalysis) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '이미지 분석 결과가 없어요. 먼저 예약을 처리해주세요.' }) };
    }

    // 4. 최신 트렌드 인사이트 가져오기
    try {
      const bizCat = item.bizCategory || (item.storeProfile || {}).category || 'cafe';
      const trendRes = await fetch(`https://lumi.it.kr/.netlify/functions/get-trends?category=${encodeURIComponent(bizCat)}`);
      if (trendRes.ok) {
        const trendData = await trendRes.json();
        if (trendData.keywords && trendData.keywords.length > 0) {
          item.trends = trendData.keywords.map(k => k.keyword.startsWith('#') ? k.keyword : '#' + k.keyword);
        }
        if (trendData.insights) item.trendInsights = trendData.insights;
      }
    } catch (e) { /* 실패해도 캡션 생성은 계속 */ }

    // 5. GPT-5.4로 캡션 3개 재생성
    const toneGuide = buildToneGuide(item.toneLikes, item.toneDislikes);
    const captionPrompt = buildCaptionPrompt(item, imageAnalysis, toneGuide);

    const openai = new OpenAI();
    const gptRes = await openai.responses.create({
      model: 'gpt-5.4',
      input: [{ role: 'user', content: captionPrompt }],
      store: true,
    });

    const outputText = gptRes.output_text || '';
    const captions = parseCaptions(outputText);
    if (!captions.length) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '캡션 파싱 실패. GPT 출력 형식을 확인해주세요.' }) };
    }

    // 5. 생성된 캡션 3개 덮어쓰기
    item.captions = captions;
    item.captionRegeneratedAt = new Date().toISOString();
    // 자동 게시 시간 리셋 (30분)
    item.autoPostAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    item.captionStatus = 'pending';
    await reserveStore.set(reservationKey, JSON.stringify(item));

    // 6. 재생성 횟수 +1 저장
    await regenStore.set(monthKey, String(count + 1));

    // 7. 새 캡션 3개 반환
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        captions,
        remaining: Math.max(0, 3 - (count + 1)),
      }),
    };

  } catch (err) {
    console.error('[regenerate-caption] 오류:', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '재생성 실패', detail: err.message }),
    };
  }
};
