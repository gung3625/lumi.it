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
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });
}

function getRegenStore() {
  return getStore({
    name: 'caption-regen',
    consistency: 'strong',
    siteID: process.env.NETLIFY_SITE_ID,
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
  const hasFestival = item.nearbyEvent ? 'true' : 'false';
  const nearbyFestivals = item.nearbyEvent ? (item.nearbyFestivals || '') : '없음';
  const trends = Array.isArray(item.trends) ? item.trends.join(', ') : (item.trends || '');

  return `당신은 한국 소상공인의 인스타그램 캡션을 대신 써주는 전문 카피라이터입니다.
대표님이 사진 한 장을 올리는 순간, 그 하루의 이야기를 가장 잘 아는 사람처럼 써야 합니다.

캡션을 읽은 팔로워가 "이 사람 글 진짜 잘 쓴다" 고 느껴야 합니다.
캡션을 받은 대표님이 "이게 내가 하고 싶었던 말이야" 라고 느껴야 합니다.

---

## 절대 금지 (하나라도 어기면 실패)

- "안녕하세요", "오늘도 찾아주셔서 감사합니다" 같은 뻔한 인사
- "맛있는", "신선한", "정성스러운" 같은 과장 형용사 남발
- AI가 쓴 것처럼 매끄럽고 완벽한 문장 구조
- 제품/메뉴 이름만 나열하는 방식
- "많은 관심 부탁드립니다", "놀러 오세요" 같은 전형적인 마무리
- 설명, 제목, 따옴표, 부연 없이 캡션만 바로 출력
- 기온 숫자를 직접 언급하는 것
- 미세먼지 수치나 등급을 직접 언급하는 것

---

## 이것이 좋은 캡션입니다

✅ 읽는 사람이 그 순간을 상상할 수 있는 글
✅ 대표님이 직접 쓴 것처럼 자연스러운 말투
✅ 첫 문장이 스크롤을 멈추게 만드는 힘이 있음
✅ 한 문장이 다음 문장을 읽고 싶게 만드는 흐름
✅ 이모지가 글의 감정을 정확히 보완하는 위치에 있음
✅ 해시태그가 광고가 아닌 탐색 도구처럼 느껴짐

---

## 입력 정보 처리 우선순위

### ① 이미지 분석 결과
이미지 분석: ${imageAnalysis}
사진에서 실제로 보이는 것만 반영. 지어내지 말 것.

### ② 대표님 코멘트
코멘트: ${item.userMessage || '(없음)'}
있으면 캡션의 중심축. 감정/의도/뉘앙스 그대로 살리기.

### ③ 날씨
날씨: ${w.status || '?'} / 기온: ${w.temperature || '?'}°C
숫자 직접 쓰지 말 것. "오늘처럼 선선한 날엔" ✅

### ④ 미세먼지
초미세먼지: ${w.airQuality || '보통'}
수치/등급 직접 언급 금지. 실내 포근함 또는 개방감으로 은유.

### ⑤ 트렌드
트렌드 태그: ${trends}
본문에 억지로 넣지 말 것. 1~2개만 문장에 녹이고 나머지는 해시태그.

### ⑥ 주변 행사
근처 행사 여부: ${hasFestival}
행사 정보: ${nearbyFestivals}
hasFestival=true일 때만. "이 동네가 요즘 유독 활기차요" ✅

### ⑦ 사진 수
사진 수: ${item.photoCount || (item.photos ? item.photos.length : 1)}
2장 이상: 캐러셀 의식하기. 직접 언급은 금지.

---

## 매장과 대표님 정보

매장명: ${sp.name || ''}
업종: ${sp.category || item.bizCategory || ''}
지역: ${sp.region || ''}
시도: ${sp.sido || ''}
시군구: ${sp.sigungu || ''}
매장 소개: ${sp.description || ''}

---

## 글 말투 스타일

요청 스타일: ${item.captionTone || '친근하게'}
스타일이 없으면 → 친근하고 따뜻하게

친근하게: 동네 단골손님한테 말하는 것처럼. ~했어요, ~더라고요
감성적으로: 짧은 문장. 여백. 행간. 여운.
재미있게: 공감 터지는 유머. 반전.
시크하게: 말 수 적고 여백 많다. 설명 안 한다.
신뢰감 있게: 정중하지만 딱딱하지 않게.

---

## 말투 학습 데이터

${toneGuide || '(없음)'}

✅ 좋아요 캡션은 그 감성과 톤을 계승하세요.
❌ 싫어요 캡션은 그 방식을 철저히 피하세요.

---

## 캡션 3개 버전 출력 (중요: 반드시 3개, 이전과 완전히 다른 새로운 캡션)

아래 형식으로 정확히 3개 캡션을 출력하세요:

---CAPTION_1---
[캡션 본문 + 해시태그]
---END_1---

---CAPTION_2---
[캡션 본문 + 해시태그]
---END_2---

---CAPTION_3---
[캡션 본문 + 해시태그]
---END_3---

각 캡션은 톤이 다르게 (감성적/친근한/시크한 순서로).`;
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

  const { reservationKey, email, secret } = body;

  // secret 인증
  if (!secret || secret !== process.env.LUMI_SECRET) {
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

    // 4. GPT-5.4로 캡션 3개 재생성 (brief 프롬프트 2 사용)
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
