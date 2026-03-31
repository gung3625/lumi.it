const { getStore } = require('@netlify/blobs');
const sharp = require('sharp');
const OpenAI = require('openai');

const SITE_URL = process.env.URL || 'https://lumi.it.kr';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── 헬퍼 ──

function getBlobStore(name) {
  return getStore({
    name,
    consistency: 'strong',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });
}

function buildToneGuide(toneLikes, toneDislikes) {
  let guide = '';
  if (toneLikes) {
    const items = toneLikes.split('|||').filter(Boolean);
    if (items.length) guide += '\u2705 \uc88b\uc544\ud588\ub358 \uc2a4\ud0c0\uc77c:\n' + items.map(i => '- ' + i.trim()).join('\n') + '\n';
  }
  if (toneDislikes) {
    const items = toneDislikes.split('|||').filter(Boolean);
    if (items.length) guide += '\u274c \uc2eb\uc5b4\ud588\ub358 \uc2a4\ud0c0\uc77c:\n' + items.map(i => '- ' + i.trim()).join('\n');
  }
  return guide;
}

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

**[1. 첫인상]** 이 사진을 처음 봤을 때 0.3초 안에 드는 느낌을 한 문장으로 쓰세요.

**[2. 피사체 분석]** 무엇이 찍혀 있는지 구체적으로 파악하세요.

**[3. 감성과 분위기]** 이 사진이 불러일으키는 감정을 구체적으로 표현하세요.

**[4. 색감과 빛]** 주된 색조, 조명의 질감, 밝기와 채도.

**[5. 인스타그램 강점]** 시선을 가장 강하게 끌어당길 요소 한 가지.

**[6. 캡션 방향 제안]** 어떤 이야기로 풀어야 할지 방향을 제시하세요.

---

## 출력 형식

**[분석 요약]** 3~5문장의 브리핑. 사물 나열이 아닌 감성과 스토리 중심.

**[캡션 핵심 키워드]** 사진의 시각적 특징에서 나온 키워드 5개. 날씨/계절 제외.

**[캡션 첫 문장 후보]** 스크롤을 멈추게 만드는 첫 문장 2개.`;

function buildCaptionPrompt(item, imageAnalysis, toneGuide) {
  const w = item.weather || {};
  const sp = item.storeProfile || {};
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

## 입력 정보

### ① 이미지 분석 결과
이미지 분석: ${imageAnalysis}

### ② 대표님 코멘트
코멘트: ${item.userMessage || '(없음)'}

### ③ 날씨
날씨: ${w.status || '정보 없음'} / 기온: ${w.temperature || '?'}°C
숫자 직접 쓰지 말 것.

### ④ 트렌드
트렌드 태그: ${Array.isArray(item.trends) ? item.trends.join(', ') : ''}
본문에 억지로 넣지 말 것. 1~2개만 문장에 녹이고 나머지는 해시태그.

### ⑤ 주변 행사
근처 행사 여부: ${item.nearbyEvent ? 'true' : 'false'}
행사 정보: ${item.nearbyFestivals || '없음'}

### ⑥ 사진 수: ${item.photos.length}

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

요청 스타일: ${item.captionTone || '친근하게'}

---

## 말투 학습 데이터

${toneGuide || '(없음)'}

✅ 좋아요 캡션은 그 감성과 톤을 계승하세요.
❌ 싫어요 캡션은 그 방식을 철저히 피하세요.

---

## 캡션 3개 버전 출력 (중요: 반드시 3개)

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

function getImageUrl(key) {
  return `${SITE_URL}/.netlify/functions/serve-image?key=${encodeURIComponent(key)}`;
}

// ── GPT 호출 ──

async function analyzeImages(resizedBuffers) {
  const results = [];
  for (const buf of resizedBuffers) {
    const base64 = buf.toString('base64');
    const res = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 2048,
      temperature: 1,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: IMAGE_ANALYSIS_PROMPT },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'high' } },
        ],
      }],
    });
    results.push(res.choices[0].message.content);
  }
  return results.join('\n\n---\n\n');
}

async function generateCaptions(item, imageAnalysis, toneGuide) {
  const prompt = buildCaptionPrompt(item, imageAnalysis, toneGuide);
  const res = await openai.responses.create({
    model: 'gpt-5.4',
    input: [{ role: 'user', content: prompt }],
    store: true,
  });
  return parseCaptions(res.output_text);
}

// ── Instagram 게시 ──

async function createMediaContainer(igUserId, igAccessToken, imageUrl, isCarousel) {
  const params = new URLSearchParams({
    image_url: imageUrl,
    access_token: igAccessToken,
  });
  if (isCarousel) params.set('is_carousel_item', 'true');

  const res = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const data = await res.json();
  if (data.error) throw new Error(`IG container error: ${JSON.stringify(data.error)}`);
  return data.id;
}

async function publishCarousel(igUserId, igAccessToken, containerIds, caption) {
  // 캐러셀 컨테이너 생성
  const params = new URLSearchParams({
    media_type: 'CAROUSEL',
    children: containerIds.join(','),
    caption,
    access_token: igAccessToken,
  });
  const res = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const data = await res.json();
  if (data.error) throw new Error(`IG carousel error: ${JSON.stringify(data.error)}`);

  // 10초 대기 후 게시
  await new Promise(r => setTimeout(r, 10000));

  const pubRes = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ creation_id: data.id, access_token: igAccessToken }),
  });
  return pubRes.json();
}

async function publishSingle(igUserId, igAccessToken, imageUrl, caption) {
  const params = new URLSearchParams({
    image_url: imageUrl,
    caption,
    access_token: igAccessToken,
  });
  const res = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const data = await res.json();
  if (data.error) throw new Error(`IG single error: ${JSON.stringify(data.error)}`);

  await new Promise(r => setTimeout(r, 10000));

  const pubRes = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ creation_id: data.id, access_token: igAccessToken }),
  });
  return pubRes.json();
}

async function publishStory(igUserId, igAccessToken, imageUrl) {
  const params = new URLSearchParams({
    image_url: imageUrl,
    media_type: 'STORIES',
    access_token: igAccessToken,
  });
  const res = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const data = await res.json();
  if (data.error) throw new Error(`IG story error: ${JSON.stringify(data.error)}`);

  await new Promise(r => setTimeout(r, 5000));

  const pubRes = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ creation_id: data.id, access_token: igAccessToken }),
  });
  return pubRes.json();
}

// ── Instagram 게시 통합 ──

async function postToInstagram(item, caption, imageUrls, imageKeys) {
  const { igUserId, igAccessToken } = item;
  let result;

  if (imageUrls.length > 1) {
    // 캐러셀
    const containerIds = [];
    for (const url of imageUrls) {
      const id = await createMediaContainer(igUserId, igAccessToken, url, true);
      containerIds.push(id);
    }
    result = await publishCarousel(igUserId, igAccessToken, containerIds, caption);
  } else {
    // 단일 이미지
    result = await publishSingle(igUserId, igAccessToken, imageUrls[0], caption);
  }

  // 스토리 게시
  if (item.storyEnabled) {
    try {
      await publishStory(igUserId, igAccessToken, imageUrls[0]);
      console.log('[lumi] 스토리 게시 완료');
    } catch (e) {
      console.error('[lumi] 스토리 게시 실패:', e.message);
    }
  }

  return result;
}

// ── 캡션 저장 (save-caption 로직 인라인) ──

async function saveCaptionHistory(email, caption) {
  const store = getBlobStore('users');
  let history = [];
  try {
    const raw = await store.get('caption-history:' + email);
    if (raw) history = JSON.parse(raw);
  } catch { history = []; }

  history.unshift({
    id: Date.now(),
    caption: caption.trim(),
    createdAt: new Date().toISOString(),
    feedback: null,
  });
  if (history.length > 20) history = history.slice(0, 20);
  await store.set('caption-history:' + email, JSON.stringify(history));
}

// ── 임시 이미지 정리 ──

async function cleanupImages(tempStore, imageKeys) {
  for (const key of imageKeys) {
    try { await tempStore.delete(key); } catch {}
  }
}

// ── 메인 핸들러 ──

exports.handler = async (event) => {
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    console.error('[process-and-post] invalid body');
    return { statusCode: 400 };
  }

  const { reserveKey } = body;
  if (!reserveKey) {
    console.error('[process-and-post] reserveKey 없음');
    return { statusCode: 400 };
  }

  const reserveStore = getBlobStore('reservations');
  const tempStore = getBlobStore('temp-images');
  let item, imageKeys = [], imageUrls = [], resizedBuffers = [];

  try {
    // 1. 예약 데이터 로드
    const raw = await reserveStore.get(reserveKey);
    if (!raw) throw new Error('예약 데이터 없음: ' + reserveKey);
    item = JSON.parse(raw);

    console.log(`[lumi] 처리 시작: ${reserveKey}, 사진 ${item.photos.length}장`);

    // 2. 이미지 리사이징 + Blobs 임시 저장
    for (let i = 0; i < item.photos.length; i++) {
      const photo = item.photos[i];
      const buf = Buffer.from(photo.base64, 'base64');
      const resized = await sharp(buf)
        .resize(1080, 1350, { fit: 'cover' })
        .jpeg({ quality: 85 })
        .toBuffer();

      const key = `img:${reserveKey}:${i}`;
      await tempStore.set(key, resized);
      imageKeys.push(key);
      resizedBuffers.push(resized);
    }
    imageUrls = imageKeys.map(getImageUrl);

    // 3. GPT 이미지 분석 (base64 직접 전달 — URL fetch 불안정 방지)
    const imageAnalysis = await analyzeImages(resizedBuffers);
    console.log('[lumi] 이미지 분석 완료');

    // 4. 말투 학습 데이터
    const toneGuide = buildToneGuide(item.toneLikes, item.toneDislikes);

    // 5. GPT 캡션 3개 생성
    const captions = await generateCaptions(item, imageAnalysis, toneGuide);
    if (!captions.length) throw new Error('캡션 파싱 실패');
    console.log(`[lumi] 캡션 ${captions.length}개 생성 완료`);

    // 6. 캡션을 예약 데이터에 저장 (고객 선택 대기)
    item.captions = captions;
    item.imageAnalysis = imageAnalysis; // regenerate-caption.js에서 재사용
    item.captionStatus = 'pending'; // pending → selected → posted
    item.captionGeneratedAt = new Date().toISOString();
    item.imageKeys = imageKeys;
    await reserveStore.set(reserveKey, JSON.stringify(item));

    // 7. 미리보기 알림톡 발송 (TODO: 알림톡 템플릿 검수 후 활성화)
    // const previewUrl = `${SITE_URL}/dashboard?preview=${encodeURIComponent(reserveKey)}`;
    // const autoPostTime = new Date(Date.now() + 30 * 60 * 1000).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

    // 8. 30분 자동 게시 타이머 설정
    item.autoPostAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await reserveStore.set(reserveKey, JSON.stringify(item));

    console.log(`[lumi] 캡션 준비 완료, 30분 후 자동 게시 예정: ${reserveKey}`);
    return { statusCode: 200 };

  } catch (err) {
    console.error('[process-and-post] 오류:', err.message);

    // 실패 시 임시 이미지 정리
    if (imageKeys.length) await cleanupImages(tempStore, imageKeys);

    // 에러 상태 저장
    if (item) {
      item.captionStatus = 'error';
      item.errorMessage = err.message;
      await reserveStore.set(reserveKey, JSON.stringify(item));
    }

    return { statusCode: 500 };
  }
};

// Instagram 게시 실행 (select-caption 또는 자동 게시에서 호출)
module.exports.postToInstagram = postToInstagram;
module.exports.saveCaptionHistory = saveCaptionHistory;
module.exports.cleanupImages = cleanupImages;
module.exports.getImageUrl = getImageUrl;
module.exports.getBlobStore = getBlobStore;

exports.config = { type: 'background' };
