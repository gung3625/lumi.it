const { getStore } = require('@netlify/blobs');

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

  const imgStore = getTempImageStore();
  const imageUrls = [];
  const tempKeys = [];

  for (let i = 0; i < photos.length; i++) {
    let buffer = Buffer.from(photos[i].base64, 'base64');

    if (sharp) {
      try {
        buffer = await sharp(buffer)
          .resize(1080, 1350, { fit: 'cover', position: 'center' })
          .jpeg({ quality: 85 })
          .toBuffer();
      } catch (e) { console.error(`이미지 ${i} 리사이징 실패:`, e.message); }
    }

    const tempKey = `temp-img:${reserveKey}:${i}`;
    await imgStore.set(tempKey, buffer, { metadata: { contentType: 'image/jpeg' } });

    const siteUrl = process.env.URL || 'https://lumi.it.kr';
    imageUrls.push(`${siteUrl}/.netlify/functions/serve-image?key=${encodeURIComponent(tempKey)}`);
    tempKeys.push(tempKey);
  }

  return { imageUrls, tempKeys };
}

// ── GPT-4o 이미지 분석 ──
async function analyzeImages(imageUrls) {
  const prompt = `당신은 소상공인 인스타그램 마케팅 전문 이미지 분석가입니다.
당신의 분석 결과는 캡션 카피라이터에게 전달되어 최고 품질의 캡션을 만드는 데 쓰입니다.
분석이 정확하고 풍부할수록 캡션 품질이 올라갑니다.

중요: 계절, 날씨, 트렌드 정보는 별도로 제공됩니다.
이 이미지에서 보이는 것만 분석하세요.

## 분석 철학
사물을 나열하지 마세요.
보는 사람의 감정을 먼저 읽으세요.

## 분석 항목
[1. 첫인상] 0.3초 안에 드는 느낌 한 문장.
[2. 피사체 분석] 구체적으로.
[3. 감성과 분위기] 구체적 감성 언어.
[4. 색감과 빛] 주된 색조, 조명.
[5. 인스타그램 강점] 시선 끄는 요소 1가지.
[6. 캡션 방향 제안]

## 출력 형식
**[분석 요약]** 3~5문장
**[캡션 핵심 키워드]** 5개
**[캡션 첫 문장 후보]** 2개`;

  const content = [{ type: 'text', text: prompt }];
  for (const url of imageUrls) {
    content.push({ type: 'image_url', image_url: { url, detail: 'high' } });
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
  return data.choices?.[0]?.message?.content || '';
}

// ── gpt-5.4 캡션 생성 ──
async function generateCaptions(imageAnalysis, item) {
  const w = item.weather || {};
  const sp = item.storeProfile || {};
  const toneGuide = buildToneGuide(item.toneLikes, item.toneDislikes);

  const prompt = `당신은 한국 소상공인의 인스타그램 캡션을 대신 써주는 전문 카피라이터입니다.
대표님이 사진 한 장을 올리는 순간, 그 하루의 이야기를 가장 잘 아는 사람처럼 써야 합니다.

캡션을 읽은 팔로워가 "이 사람 글 진짜 잘 쓴다"고 느껴야 합니다.
캡션을 받은 대표님이 "이게 내가 하고 싶었던 말이야"라고 느껴야 합니다.

## 절대 금지
- "안녕하세요" 같은 뻔한 인사
- "맛있는", "신선한" 같은 과장 형용사 남발
- AI가 쓴 것처럼 매끄럽고 완벽한 문장 구조
- 제품/메뉴 이름만 나열
- "많은 관심 부탁드립니다" 같은 마무리
- 설명, 제목, 따옴표 없이 캡션만 바로 출력
- 기온 숫자 직접 언급
- 미세먼지 수치/등급 직접 언급

## 입력 정보
이미지 분석: ${imageAnalysis}
코멘트: ${item.userMessage || ''}
날씨: ${w.status || ''} / 기온: ${w.temperature || ''}°C
날씨 상태: ${w.state || ''}
날씨 가이드: ${w.guide || ''}
날씨 분위기: ${w.mood || ''}
위치: ${w.locationName || ''}
초미세먼지: ${w.airQuality || ''}
트렌드 태그: ${Array.isArray(item.trends) ? item.trends.join(', ') : ''}
태그 스타일: ${item.tagStyle || 'mid'}
근처 행사 여부: ${item.nearbyEvent || false}
행사 정보: ${item.nearbyFestivals || ''}
사진 수: ${item.photos.length}

## 매장 정보
매장명: ${sp.name || ''}
업종: ${item.bizCategory || sp.category || ''}
지역: ${sp.region || ''}
시도: ${sp.sido || ''}
시군구: ${sp.sigungu || ''}
매장 소개: ${sp.description || ''}
인스타그램: ${sp.instagram || ''}

## 말투 스타일
요청 스타일: ${item.captionTone || '친근하게'}

## 말투 학습 데이터
${toneGuide}

## 캡션 3개 버전 출력 (반드시 3개)

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
  const text = data.output?.[0]?.content?.[0]?.text || data.output_text || '';
  return parseCaptions(text);
}

// ── 알림톡 발송 ──
async function sendAlimtalk(phone, text) {
  try {
    const now = new Date().toISOString();
    const salt = `post_${Date.now()}`;
    const crypto = require('crypto');
    const sig = crypto.createHmac('sha256', process.env.SOLAPI_API_SECRET).update(`${now}${salt}`).digest('hex');
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
    await sleep(10000);
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
    await sleep(10000);
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
      body: JSON.stringify({ email, caption, secret: 'lumi2026secret' }),
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

// ── 메인 핸들러 (Background Function) ──
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { reservationKey } = JSON.parse(event.body || '{}');
    if (!reservationKey) return { statusCode: 400, headers, body: JSON.stringify({ error: 'reservationKey 필요' }) };

    const store = getReservationStore();
    const raw = await store.get(reservationKey);
    if (!raw) return { statusCode: 404, headers, body: JSON.stringify({ error: '예약 없음' }) };
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

    // 1. 이미지 리사이징 + 임시 저장
    const { imageUrls, tempKeys } = await processImages(item.photos, reservationKey);
    console.log('[process-and-post] 이미지 처리 완료');

    // 2. GPT-4o 이미지 분석
    const imageAnalysis = await analyzeImages(imageUrls);
    console.log('[process-and-post] 이미지 분석 완료');

    // 3. gpt-5.4 캡션 3개 생성
    const captions = await generateCaptions(imageAnalysis, item);
    console.log('[process-and-post] 캡션 생성 완료:', captions.length, '개');

    // 4. Blobs에 결과 저장
    item.generatedCaptions = captions;
    item.imageAnalysis = imageAnalysis;
    item.imageUrls = imageUrls;
    item.tempKeys = tempKeys;
    item.captionsGeneratedAt = new Date().toISOString();
    await store.set(reservationKey, JSON.stringify(item));

    // 5. 알림톡 (캡션 준비 완료)
    const phone = sp.phone || sp.ownerPhone;
    if (phone) {
      const previewUrl = `https://lumi.it.kr/dashboard?preview=${encodeURIComponent(reservationKey)}`;
      const autoTime = new Date(Date.now() + 30 * 60000).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      await sendAlimtalk(phone, `[lumi] ${sp.name || '사장'}님, 캡션이 준비됐어요!\n\n3가지 스타일로 만들었어요.\n마음에 드는 캡션을 선택해주세요.\n\n미리보기: ${previewUrl}\n\n선택하지 않으면 ${autoTime}에 자동 게시됩니다.`);
    }

    // 6. 30분 대기 후 자동 게시
    await sleep(30 * 60 * 1000);

    // 재조회 (고객이 선택했을 수 있음)
    const updated = JSON.parse(await store.get(reservationKey));
    if (updated.isSent) {
      console.log('[process-and-post] 이미 게시됨. 종료.');
      await cleanupTempImages(tempKeys);
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'already_posted' }) };
    }

    // 1번 캡션으로 자동 게시
    console.log('[process-and-post] 자동 게시 실행');
    try {
      const postId = await postToInstagram(updated, captions[0], imageUrls);
      updated.isSent = true;
      updated.sentAt = new Date().toISOString();
      updated.selectedCaptionIndex = 0;
      updated.postedCaption = captions[0];
      updated.instagramPostId = postId;
      await store.set(reservationKey, JSON.stringify(updated));
      await saveCaptionHistory(sp.ownerEmail, captions[0]);

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
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'completed' }) };

  } catch (err) {
    console.error('[process-and-post] 에러:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
