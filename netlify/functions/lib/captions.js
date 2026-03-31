/**
 * GPT 캡션 생성 공유 헬퍼
 */
const OpenAI = require('openai');

const IMAGE_ANALYSIS_PROMPT = `당신은 소상공인 인스타그램 마케팅 전문 이미지 분석가입니다.
당신의 분석 결과는 캡션 카피라이터에게 전달되어 최고 품질의 캡션을 만드는 데 쓰입니다.
분석이 정확하고 풍부할수록 캡션 품질이 올라갑니다.

중요: 계절, 날씨, 트렌드 정보는 별도로 제공됩니다.
이 이미지에서 보이는 것만 분석하세요.

---

## 분석 철학

사물을 나열하지 마세요.
"딸기가 있고, 우유가 있고, 잔이 있다" → 실패
"선명한 딸기 빛이 흰 우유 위에 스며드는 순간을 포착했다" → 성공

보는 사람의 감정을 먼저 읽으세요.
이 사진을 인스타그램에서 스크롤하다 마주쳤을 때
손가락이 멈추게 만드는 요소가 무엇인지 찾으세요.

---

## 분석 항목

**[1. 첫인상]**
이 사진을 처음 봤을 때 0.3초 안에 드는 느낌을 한 문장으로 쓰세요.
이것이 캡션 첫 문장의 씨앗이 됩니다.

**[2. 피사체 분석]**
무엇이 찍혀 있는지 구체적으로 파악하세요.
- 음식/음료: 어떤 메뉴로 보이는지, 색감, 재료의 신선함, 플레이팅의 감각
- 공간: 어떤 분위기의 공간인지, 조명의 질감, 인테리어 스타일, 눈에 띄는 소품
- 제품: 어떤 종류인지, 색상과 질감, 디자인이 주는 인상
- 사람이 있다면: 어떤 감정인지, 무엇을 하고 있는지

**[3. 감성과 분위기]**
이 사진이 불러일으키는 감정을 구체적으로 표현하세요.
단순한 형용사(예쁜, 맛있어 보이는)가 아니라
"첫 데이트 전날 밤 같은 설렘" 처럼 구체적인 감성 언어를 쓰세요.

**[4. 색감과 빛]**
- 주된 색조: 어떤 색이 화면을 지배하는지
- 조명의 질감: 자연광인지 인공조명인지, 부드러운지 선명한지
- 밝기와 채도

**[5. 인스타그램 강점]**
시선을 가장 강하게 끌어당길 요소 한 가지를 꼽으세요.

**[6. 캡션 방향 제안]**
어떤 이야기로 풀어야 할지 방향을 제시하세요.

---

## 출력 형식

**[분석 요약]**
3~5문장의 브리핑. 사물 나열이 아닌 감성과 스토리 중심.

**[캡션 핵심 키워드]**
사진의 시각적 특징에서 나온 키워드 5개. 날씨/계절 제외.

**[캡션 첫 문장 후보]**
스크롤을 멈추게 만드는 첫 문장 2개.`;

function buildCaptionPrompt({ imageAnalysis, item }) {
  const w = item.weather || {};
  const sp = item.storeProfile || {};
  const toneGuide = buildToneGuide(item.toneLikes, item.toneDislikes);

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
날씨: ${w.status || '정보 없음'} / 기온: ${w.temperature !== undefined ? w.temperature + '°C' : '정보 없음'}
숫자 직접 쓰지 말 것. "오늘처럼 선선한 날엔" ✅

### ④ 미세먼지
초미세먼지: ${w.state || '정보 없음'}
수치/등급 직접 언급 금지. 실내 포근함 또는 개방감으로 은유.

### ⑤ 트렌드
트렌드 태그: ${Array.isArray(item.trends) ? item.trends.join(', ') : (item.trends || '없음')}
본문에 억지로 넣지 말 것. 1~2개만 문장에 녹이고 나머지는 해시태그.

### ⑥ 주변 행사
근처 행사 여부: ${item.nearbyEvent ? 'true' : 'false'}
행사 정보: ${item.nearbyFestivals || '없음'}
hasFestival=true일 때만. "이 동네가 요즘 유독 활기차요" ✅

### ⑦ 사진 수
사진 수: ${item.photos ? item.photos.length : 1}
2장 이상: 캐러셀 의식하기. 직접 언급은 금지.

---

## 매장과 대표님 정보

매장명: ${sp.name || ''}
업종: ${item.bizCategory || sp.category || ''}
지역: ${sp.region || ''}
시도: ${sp.sido || ''}
시군구: ${sp.sigungu || ''}
매장 소개: ${sp.description || ''}

---

## 글 말투 스타일

요청 스타일: ${item.captionTone || ''}
스타일이 없으면 → 친근하고 따뜻하게

친근하게: 동네 단골손님한테 말하는 것처럼. ~했어요, ~더라고요
감성적으로: 짧은 문장. 여백. 행간. 여운.
재미있게: 공감 터지는 유머. 반전.
시크하게: 말 수 적고 여백 많다. 설명 안 한다.
신뢰감 있게: 정중하지만 딱딱하지 않게.

---

## 말투 학습 데이터

${toneGuide || '(학습 데이터 없음)'}

✅ 좋아요 캡션은 그 감성과 톤을 계승하세요.
❌ 싫어요 캡션은 그 방식을 철저히 피하세요.

---

## 캡션 3개 버전 출력 (중요: 반드시 3개)

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

function buildToneGuide(toneLikes, toneDislikes) {
  let guide = '';
  if (toneLikes) {
    const items = toneLikes.split('|||').filter(Boolean);
    if (items.length) {
      guide += '✅ 좋아했던 스타일:\n' + items.map(i => `- ${i.trim()}`).join('\n');
    }
  }
  if (toneDislikes) {
    const items = toneDislikes.split('|||').filter(Boolean);
    if (items.length) {
      if (guide) guide += '\n\n';
      guide += '❌ 싫어했던 스타일:\n' + items.map(i => `- ${i.trim()}`).join('\n');
    }
  }
  return guide;
}

function parseCaptions(text) {
  const captions = [];
  for (let i = 1; i <= 3; i++) {
    const startTag = `---CAPTION_${i}---`;
    const endTag = `---END_${i}---`;
    const startIdx = text.indexOf(startTag);
    const endIdx = text.indexOf(endTag);
    if (startIdx !== -1 && endIdx !== -1) {
      captions.push(text.substring(startIdx + startTag.length, endIdx).trim());
    }
  }
  return captions;
}

async function analyzeImages(openai, imageUrls) {
  const results = [];
  for (const url of imageUrls) {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 2048,
      temperature: 1,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: IMAGE_ANALYSIS_PROMPT },
          { type: 'image_url', image_url: { url, detail: 'high' } },
        ],
      }],
    });
    results.push(res.choices[0].message.content);
  }
  return results.join('\n\n---\n\n');
}

async function generateCaptions({ imageUrls, item }) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // 1단계: 이미지 분석 (GPT-4o)
  console.log('[lumi] 이미지 분석 시작 (%d장)', imageUrls.length);
  const imageAnalysis = await analyzeImages(openai, imageUrls);
  console.log('[lumi] 이미지 분석 완료');

  // 2단계: 캡션 생성 (gpt-5.4)
  const captionPrompt = buildCaptionPrompt({ imageAnalysis, item });
  console.log('[lumi] 캡션 생성 시작 (gpt-5.4)');

  const res = await openai.chat.completions.create({
    model: 'gpt-5.4',
    max_tokens: 4096,
    temperature: 1,
    messages: [{ role: 'user', content: captionPrompt }],
  });

  const rawText = res.choices[0].message.content;
  const captions = parseCaptions(rawText);
  console.log('[lumi] 캡션 %d개 파싱 완료', captions.length);

  if (captions.length < 3) {
    console.warn('[lumi] 캡션 파싱 부족 (%d개). 원문 길이: %d', captions.length, rawText.length);
  }

  return { captions, imageAnalysis };
}

module.exports = { generateCaptions, parseCaptions, buildCaptionPrompt, analyzeImages, buildToneGuide };
