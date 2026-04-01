const { getStore } = require('@netlify/blobs');
const { createHmac } = require('crypto');


const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── 캡션 파싱 ──
function parseCaptions(text) {
  const captions = [];
  for (let i = 1; i <= 3; i++) {
    const regex = new RegExp(`---CAPTION_${i}---([\\s\\S]*?)---END_${i}---`);
    const match = text.match(regex);
    if (match) captions.push(match[1].trim());
  }
  return captions;
}

// ── 말투 학습 데이터 가공 ──
function buildToneGuide(likes, dislikes) {
  let guide = '';
  if (likes) {
    const items = likes.split('|||').filter(Boolean);
    if (items.length) guide += '✅ 좋아했던 스타일:\n' + items.map(s => `- ${s}`).join('\n') + '\n\n';
  }
  if (dislikes) {
    const items = dislikes.split('|||').filter(Boolean);
    if (items.length) guide += '❌ 싫어했던 스타일:\n' + items.map(s => `- ${s}`).join('\n');
  }
  return guide;
}

// ── 유틸 ──
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getReservationStore() {
  return getStore({
    name: 'reservations',
    consistency: 'strong',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });
}

function getTempImageStore() {
  return getStore({
    name: 'temp-images',
    consistency: 'strong',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });
}

// ── 이미지 리사이징 + Blobs 임시 저장 ──
async function processImages(photos, reserveKey) {
  let sharp;
  try { sharp = require('sharp'); } catch (e) { sharp = null; }

  const siteUrl = process.env.URL || 'https://lumi.it.kr';
  const imgStore = getTempImageStore();
  const imageUrls = [];
  const tempKeys = [];
  const imageBuffers = [];

  // 1단계: 모든 이미지 리사이징 (병렬)
  const buffers = await Promise.all(photos.map(async (photo, i) => {
    let buffer = Buffer.from(photo.base64, 'base64');
    if (sharp) {
      try {
        buffer = await sharp(buffer)
          .resize(1080, 1350, { fit: 'cover', position: 'center' })
          .jpeg({ quality: 85 })
          .toBuffer();
      } catch (e) { console.error(`이미지 ${i} 리사이징 실패:`, e.message); }
    }
    return buffer;
  }));

  // 2단계: Blobs 저장 (병렬)
  await Promise.all(buffers.map(async (buffer, i) => {
    const tempKey = `temp-img:${reserveKey}:${i}`;
    await imgStore.set(tempKey, buffer, { metadata: { contentType: 'image/jpeg' } });
    tempKeys[i] = tempKey;
    imageUrls[i] = `${siteUrl}/.netlify/functions/serve-image?key=${encodeURIComponent(tempKey)}`;
    imageBuffers[i] = buffer.toString('base64');
  }));

  return { imageUrls, tempKeys, imageBuffers };
}

// ── GPT-4o 이미지 분석 (base64 직접 전달 — URL fetch 콜드스타트 없음) ──
async function analyzeImages(imageBuffers) {
  const prompt = `당신은 소상공인 인스타그램 마케팅 전문 이미지 분석가입니다.
당신의 분석 결과는 캡션 카피라이터에게 전달되어 최고 품질의 캡션을 만드는 데 쓰입니다.
분석이 정확하고 풍부할수록 캡션 품질이 올라갑니다.

중요: 계절, 날씨, 트렌드 정보는 별도로 제공됩니다.
이 이미지에서 보이는 것만 분석하세요.

## 분석 철학
사물을 나열하지 마세요.
"딸기가 있고, 우유가 있고, 잔이 있다" → 실패
"선명한 딸기 빛이 흰 우유 위에 스며드는 순간을 포착했다" → 성공

보는 사람의 감정을 먼저 읽으세요.
이 사진을 인스타그램에서 스크롤하다 마주쳤을 때 손가락이 멈추게 만드는 요소가 무엇인지 찾으세요.

## 분석 항목

**[1. 첫인상]**
이 사진을 처음 봤을 때 0.3초 안에 드는 느낌을 한 문장으로 쓰세요.
이것이 캡션 첫 문장의 씨앗이 됩니다.

**[2. 피사체 분석]**
무엇이 찍혀 있는지 구체적으로 파악하세요.
- 음식/음료: 어떤 메뉴, 색감, 재료의 신선함, 플레이팅의 감각
- 공간: 어떤 분위기, 조명의 질감, 인테리어 스타일, 눈에 띄는 소품
- 제품: 어떤 종류인지, 색상과 질감, 디자인이 주는 인상
- 사람이 있다면: 어떤 감정인지, 무엇을 하고 있는지

**[3. 감성과 분위기]**
"예쁜, 맛있어 보이는" 같은 단순 형용사가 아니라
"첫 데이트 전날 밤 같은 설렘"처럼 구체적인 감성 언어를 쓰세요.

**[4. 색감과 빛]**
- 주된 색조: 어떤 색이 화면을 지배하는지
- 조명의 질감: 자연광인지 인공조명인지, 부드러운지 선명한지
- 밝기와 채도

**[5. 인스타그램 강점]**
시선을 가장 강하게 끌어당길 요소 한 가지를 꼽으세요.

**[6. 캡션 방향 제안]**
어떤 이야기로 풀어야 할지 방향을 제시하세요.

## 출력 형식
**[분석 요약]** 3~5문장의 브리핑. 사물 나열이 아닌 감성과 스토리 중심.
**[캡션 핵심 키워드]** 사진의 시각적 특징에서 나온 키워드 5개. 날씨/계절 제외.
**[캡션 첫 문장 후보]** 스크롤을 멈추게 만드는 첫 문장 2개.`;

  const content = [{ type: 'text', text: prompt }];
  for (const b64 of imageBuffers) {
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'high' } });
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content }],
      max_tokens: 2048,
      temperature: 1,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`GPT-4o 오류: ${data.error.message}`);
  return data.choices?.[0]?.message?.content || '';
}

// ── gpt-5.4 캡션 생성 ──
async function generateCaptions(imageAnalysis, item) {
  const w = item.weather || {};
  const sp = item.storeProfile || {};
  const toneGuide = buildToneGuide(item.toneLikes, item.toneDislikes);

  const prompt = `당신은 한국 소상공인의 인스타그램 캡션을 대신 써주는 전문 카피라이터입니다.
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
코멘트: ${item.userMessage || ''}
있으면 캡션의 중심축. 감정/의도/뉘앙스 그대로 살리기.

### ③ 날씨
날씨: ${w.status || ''} / 기온: ${w.temperature || ''}°C
날씨 상태: ${w.state || ''}
날씨 가이드: ${w.guide || ''}
날씨 분위기: ${w.mood || ''}
위치: ${w.locationName || ''}
숫자 직접 쓰지 말 것. "오늘처럼 선선한 날엔" ✅

### ④ 미세먼지
초미세먼지: ${w.airQuality || ''}
수치/등급 직접 언급 금지. 실내 포근함 또는 개방감으로 은유.

### ⑤ 트렌드
트렌드 태그: ${Array.isArray(item.trends) ? item.trends.join(', ') : ''}
태그 스타일: ${item.tagStyle || 'mid'}
본문에 억지로 넣지 말 것. 1~2개만 문장에 녹이고 나머지는 해시태그.

### ⑥ 주변 행사
근처 행사 여부: ${item.nearbyEvent || false}
행사 정보: ${item.nearbyFestivals || ''}
nearbyEvent=true일 때만. "이 동네가 요즘 유독 활기차요" ✅

### ⑦ 사진 수
사진 수: ${item.photos.length}
2장 이상: 캐러셀 의식하기. 직접 언급은 금지.

---

## 매장과 대표님 정보

매장명: ${sp.name || ''}
업종: ${item.bizCategory || sp.category || ''}
지역: ${sp.region || ''}
시도: ${sp.sido || ''}
시군구: ${sp.sigungu || ''}
매장 소개: ${sp.description || ''}
인스타그램: ${sp.instagram || ''}

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

${toneGuide}

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

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: 'gpt-5.4', input: prompt, store: true }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`gpt-5.4 오류: ${data.error.message || JSON.stringify(data.error)}`);
  const text = data.output?.[0]?.content?.[0]?.text || data.output_text || '';
  if (!text) throw new Error('gpt-5.4 응답 없음');
  const captions = parseCaptions(text);
  if (!captions.length) throw new Error(`캡션 파싱 실패. 응답: ${text.substring(0, 200)}`);
  return captions;
}

// ── 알림톡 발송 ──
async function sendAlimtalk(phone, text) {
  try {
    const now = new Date().toISOString();
    const salt = `post_${Date.now()}`;
    const sig = createHmac('sha256', process.env.SOLAPI_API_SECRET).update(`${now}${salt}`).digest('hex');
    await fetch('https://api.solapi.com/messages/v4/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `HMAC-SHA256 ApiKey=${process.env.SOLAPI_API_KEY}, Date=${now}, Salt=${salt}, Signature=${sig}`,
      },
      body: JSON.stringify({ message: { to: phone, from: '01064246284', text } }),
    });
  } catch (e) { console.error('알림톡 실패:', e.message); }
}

// ── Instagram 게시 ──
async function postToInstagram(item, caption, imageUrls) {
  const { igUserId, storyEnabled } = item;
  // pageAccessToken 우선, 없으면 accessToken 사용
  const igAccessToken = item.igPageAccessToken || item.igAccessToken;
  if (!igUserId || !igAccessToken) throw new Error('Instagram 연동 정보 없음');

  let postId;

  if (imageUrls.length > 1) {
    // 캐러셀: 각 이미지 컨테이너 생성
    const containerIds = [];
    for (const url of imageUrls) {
      const res = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ image_url: url, is_carousel_item: 'true', access_token: igAccessToken }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error.message);
      containerIds.push(d.id);
    }
    // 캐러셀 컨테이너
    const cRes = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ media_type: 'CAROUSEL', children: containerIds.join(','), caption, access_token: igAccessToken }),
    });
    const cData = await cRes.json();
    if (cData.error) throw new Error(cData.error.message);
    await sleep(5000);
    // 게시
    const pRes = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ creation_id: cData.id, access_token: igAccessToken }),
    });
    const pData = await pRes.json();
    if (pData.error) throw new Error(pData.error.message);
    postId = pData.id;
  } else {
    // 단일 이미지
    const res = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ image_url: imageUrls[0], caption, access_token: igAccessToken }),
    });
    const d = await res.json();
    if (d.error) throw new Error(d.error.message);
    await sleep(5000);
    const pRes = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ creation_id: d.id, access_token: igAccessToken }),
    });
    const pData = await pRes.json();
    if (pData.error) throw new Error(pData.error.message);
    postId = pData.id;
  }

  // 스토리
  if (storyEnabled && imageUrls[0]) {
    try {
      const sRes = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ image_url: imageUrls[0], media_type: 'STORIES', access_token: igAccessToken }),
      });
      const sData = await sRes.json();
      if (!sData.error) {
        await sleep(5000);
        await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media_publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ creation_id: sData.id, access_token: igAccessToken }),
        });
      }
    } catch (e) { console.error('스토리 실패:', e.message); }
  }

  return postId;
}

// ── 캡션 히스토리 저장 ──
async function saveCaptionHistory(email, caption) {
  try {
    await fetch('https://lumi.it.kr/.netlify/functions/save-caption', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, caption, secret: process.env.LUMI_SECRET }),
    });
  } catch (e) { console.error('캡션 저장 실패:', e.message); }
}

// ── 임시 이미지 정리 ──
async function cleanupTempImages(tempKeys) {
  const imgStore = getTempImageStore();
  for (const key of tempKeys) {
    try { await imgStore.delete(key); } catch (e) {}
  }
}

// ── 메인 핸들러 (Background Function — export default 최신 문법) ──
exports.handler = async (event) => {
  let reservationKey = null;

  try {
    const body = JSON.parse(event.body || '{}');
    reservationKey = body.reservationKey;
    if (!reservationKey) return;

    const store = getReservationStore();
    const raw = await store.get(reservationKey);
    if (!raw) return;
    const item = JSON.parse(raw);
    const sp = item.storeProfile || {};

    console.log(`[process-and-post] 시작: ${reservationKey}, 사진 ${item.photos.length}장`);

    // 0. Blobs에서 ig 토큰 + 말투 학습 데이터 조회 (reserve.js 로직 통합)
    const userStore = getStore({
      name: 'users',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_TOKEN,
    });

    if (sp.ownerEmail && !item.igUserId) {
      try {
        // ig 토큰 조회
        let igUserId = '';
        let igAccessToken = '';
        const igUserIdRaw = await userStore.get('email-ig:' + sp.ownerEmail).catch(() => null);
        if (igUserIdRaw) {
          igUserId = igUserIdRaw.trim();
        } else {
          const userRaw = await userStore.get('user:' + sp.ownerEmail).catch(() => null);
          if (userRaw) igUserId = JSON.parse(userRaw).igUserId || '';
        }
        if (igUserId) {
          const igRaw = await userStore.get('ig:' + igUserId).catch(() => null);
          if (igRaw) {
            const igData = JSON.parse(igRaw);
            igAccessToken = igData.accessToken || '';
            item.igPageAccessToken = igData.pageAccessToken || igData.accessToken || '';
          }
        }
        item.igUserId = igUserId;
        item.igAccessToken = igAccessToken;

        // tone-like / tone-dislike 조회
        if (!item.toneLikes) {
          const likeRaw = await userStore.get('tone-like:' + sp.ownerEmail).catch(() => null);
          if (likeRaw) item.toneLikes = JSON.parse(likeRaw).map(t => t.caption).join('|||');
        }
        if (!item.toneDislikes) {
          const dislikeRaw = await userStore.get('tone-dislike:' + sp.ownerEmail).catch(() => null);
          if (dislikeRaw) item.toneDislikes = JSON.parse(dislikeRaw).map(t => t.caption).join('|||');
        }

        // customCaptions 조회
        if (!item.customCaptions) {
          const userData = await userStore.get('user:' + sp.ownerEmail).catch(() => null);
          if (userData) {
            const captions = JSON.parse(userData).customCaptions || [];
            item.customCaptions = captions.filter(c => c && c.trim()).join('|||');
          }
        }
      } catch (e) { console.error('[process-and-post] 사용자 데이터 조회 실패:', e.message); }
    }

    // airQuality 등급 변환
    if (item.weather && !item.weather.airQuality && item.airQuality) {
      item.weather.airQuality = item.airQuality;
    }

    // 1. 이미지 리사이징 + [Blobs저장 & GPT-4o 분석] 병렬 처리
    const { imageUrls, tempKeys, imageBuffers } = await processImages(item.photos, reservationKey);
    console.log('[process-and-post] 이미지 처리 완료');

    // 2. GPT-4o 분석과 gpt-5.4 캡션 생성 — 분석 완료 후 캡션 생성
    const imageAnalysis = await analyzeImages(imageBuffers);
    console.log('[process-and-post] 이미지 분석 완료');

    // 3. gpt-5.4 캡션 3개 생성
    const captions = await generateCaptions(imageAnalysis, item);
    console.log('[process-and-post] 캡션 생성 완료:', captions.length, '개');

    // 4. Blobs에 결과 저장
    item.generatedCaptions = captions;
    item.captions = captions;
    item.imageAnalysis = imageAnalysis;
    item.imageUrls = imageUrls;
    item.imageKeys = tempKeys;
    item.tempKeys = tempKeys;
    item.captionsGeneratedAt = new Date().toISOString();
    await store.set(reservationKey, JSON.stringify(item));

    // 5. 릴레이 모드 확인
    const isRelayMode = item.relayMode === true;

    // 6. 알림톡 (캡션 준비 완료)
    const phone = sp.phone || sp.ownerPhone;
    if (phone) {
      const previewUrl = `https://lumi.it.kr/dashboard?preview=${encodeURIComponent(reservationKey)}`;
      if (isRelayMode) {
        await sendAlimtalk(phone, `[lumi] ${sp.name || '사장'}님, 캡션이 준비됐어요!\n\n3가지 스타일로 만들었어요.\n마음에 드는 캡션을 선택하거나 수정해주세요.\n\n미리보기: ${previewUrl}\n\n릴레이 모드: 직접 선택하기 전까지 자동 게시되지 않아요.`);
      } else {
        const autoTime = new Date(Date.now() + 30 * 60000).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
        await sendAlimtalk(phone, `[lumi] ${sp.name || '사장'}님, 캡션이 준비됐어요!\n\n3가지 스타일로 만들었어요.\n마음에 드는 캡션을 선택해주세요.\n\n미리보기: ${previewUrl}\n\n선택하지 않으면 ${autoTime}에 자동 게시됩니다.`);
      }
    }

    // 릴레이 모드면 자동 게시 스킵 — 사용자가 직접 선택할 때까지 대기
    if (isRelayMode) {
      item.captionStatus = 'ready';
      await store.set(reservationKey, JSON.stringify(item));
      await cleanupTempImages(tempKeys);
      console.log('[process-and-post] 릴레이 모드 — 자동 게시 스킵, 사용자 선택 대기');
      return;
    }

    // 7. autoPostAt 설정 (scheduler.js가 처리) — Background Function 15분 제한으로 직접 sleep 불가
    item.autoPostAt = new Date(Date.now() + 30 * 60000).toISOString();
    await store.set(reservationKey, JSON.stringify(item));
    console.log('[process-and-post] autoPostAt 설정:', item.autoPostAt, '— scheduler가 자동 게시 처리');

    // 10분 대기 후 아직 선택 안 했으면 자동 게시 시도 (Background Function 15분 내)
    await sleep(10 * 60 * 1000);

    // 재조회 (고객이 선택했을 수 있음)
    const updatedRaw = await store.get(reservationKey);
    if (!updatedRaw) {
      console.log('[process-and-post] 예약 데이터 삭제됨. 종료.');
      await cleanupTempImages(tempKeys);
      return;
    }
    const updated = JSON.parse(updatedRaw);
    if (updated.isSent) {
      console.log('[process-and-post] 이미 게시됨. 종료.');
      await cleanupTempImages(tempKeys);
      return;
    }

    // 아직 autoPostAt이 미래면 scheduler에 위임하고 종료
    if (updated.autoPostAt && new Date(updated.autoPostAt).getTime() > Date.now() + 60000) {
      console.log('[process-and-post] autoPostAt 아직 미래. scheduler에 위임.');
      await cleanupTempImages(tempKeys);
      return;
    }

    // 1번 캡션으로 자동 게시
    const finalCaptions = updated.captions || updated.generatedCaptions || captions;
    console.log('[process-and-post] 자동 게시 실행');
    try {
      const postCaption = finalCaptions[0];
      const postId = await postToInstagram(updated, postCaption, imageUrls);
      updated.isSent = true;
      updated.sentAt = new Date().toISOString();
      updated.selectedCaptionIndex = 0;
      updated.postedCaption = postCaption;
      updated.instagramPostId = postId;
      await store.set(reservationKey, JSON.stringify(updated));
      await saveCaptionHistory(sp.ownerEmail, postCaption);

      if (phone) {
        await sendAlimtalk(phone, `[lumi] 인스타그램에 게시됐어요!\n\n${sp.name || '매장'} 게시물이 자동으로 올라갔어요.\n인스타그램에서 확인해보세요 📸`);
      }
      console.log('[process-and-post] 완료:', postId);
    } catch (postErr) {
      console.error('[process-and-post] 게시 실패:', postErr.message);
      if (phone) {
        await sendAlimtalk(phone, `[lumi] 게시에 실패했어요 😢\n\n원인: ${postErr.message}\n다시 시도하시거나 고객센터에 문의해주세요.`);
      }
    }

    await cleanupTempImages(tempKeys);
    return;

  } catch (err) {
    console.error('[process-and-post] 에러:', err.message);
    // 에러 발생 시 Blobs에 에러 상태 저장 → 폴링 무한루프 방지
    if (reservationKey) {
      try {
        const store = getReservationStore();
        const raw = await store.get(reservationKey);
        if (raw) {
          const item = JSON.parse(raw);
          item.captionsGeneratedAt = new Date().toISOString();
          item.captionError = err.message;
          item.generatedCaptions = [];
          await store.set(reservationKey, JSON.stringify(item));
        }
      } catch (_) {}
    }
    return;
  }
}