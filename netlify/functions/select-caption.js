const { getStore } = require('@netlify/blobs');

function getBlobStore(name) {
  return getStore({
    name,
    consistency: 'strong',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const SITE_URL = process.env.URL || 'https://lumi.it.kr';

// ── Instagram API ──

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
  const res = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      media_type: 'CAROUSEL',
      children: containerIds.join(','),
      caption,
      access_token: igAccessToken,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`IG carousel error: ${JSON.stringify(data.error)}`);

  // Meta 서버 처리 시간 — 10초 대기
  await new Promise(r => setTimeout(r, 5000));

  const pubRes = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ creation_id: data.id, access_token: igAccessToken }),
  });
  return pubRes.json();
}

async function publishSingle(igUserId, igAccessToken, imageUrl, caption) {
  const res = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      image_url: imageUrl,
      caption,
      access_token: igAccessToken,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`IG single error: ${JSON.stringify(data.error)}`);

  await new Promise(r => setTimeout(r, 5000));

  const pubRes = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ creation_id: data.id, access_token: igAccessToken }),
  });
  return pubRes.json();
}

async function publishStory(igUserId, igAccessToken, imageUrl) {
  const res = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      image_url: imageUrl,
      media_type: 'STORIES',
      access_token: igAccessToken,
    }),
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

async function postToInstagram(item, caption, imageUrls) {
  const { igUserId } = item;
  const igAccessToken = item.igPageAccessToken || item.igAccessToken;
  let result;

  if (imageUrls.length > 1) {
    // 캐러셀 게시
    const containerIds = [];
    for (const url of imageUrls) {
      const id = await createMediaContainer(igUserId, igAccessToken, url, true);
      containerIds.push(id);
    }
    result = await publishCarousel(igUserId, igAccessToken, containerIds, caption);
  } else {
    // 단일 이미지 게시
    result = await publishSingle(igUserId, igAccessToken, imageUrls[0], caption);
  }

  // 스토리 게시 — 메인 게시 완료 후 비동기로 처리 (응답 지연 방지)
  if (item.storyEnabled) {
    publishStory(igUserId, igAccessToken, imageUrls[0])
      .then(() => console.log('[lumi] 스토리 게시 완료'))
      .catch(e => console.error('[lumi] 스토리 게시 실패:', e.message));
  }

  return result;
}

// ── 캡션 히스토리 저장 (save-caption 로직 인라인) ──

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

// ── 메인 핸들러 ──

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // Body 파싱
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Bad Request: 잘못된 JSON' }) };
  }

  const { reservationKey, captionIndex, email, secret } = body;

  // 인증
  if (secret !== process.env.LUMI_SECRET) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증 실패' }) };
  }

  // 필수 파라미터 검증
  if (!reservationKey) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'reservationKey 필수' }) };
  }
  if (captionIndex === undefined || captionIndex === null || ![0, 1, 2].includes(Number(captionIndex))) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'captionIndex는 0, 1, 2 중 하나여야 합니다' }) };
  }

  const idx = Number(captionIndex);

  try {
    const reserveStore = getBlobStore('reservations');
    const tempStore = getBlobStore('temp-images');

    // 1. Blobs에서 예약 데이터 조회
    const raw = await reserveStore.get(reservationKey);
    if (!raw) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '예약 데이터 없음' }) };
    }
    const item = JSON.parse(raw);

    // 이미 게시된 경우 중복 방지
    if (item.isSent || item.captionStatus === 'posted') {
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: '이미 게시된 예약입니다' }) };
    }

    // 2. captions[captionIndex] 가져오기
    const captions = item.captions;
    if (!captions || !captions[idx]) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `captionIndex ${idx}에 해당하는 캡션 없음` }) };
    }
    const selectedCaption = captions[idx];

    // 이미지 URL — process-and-post가 저장한 imageUrls 직접 사용, 없으면 imageKeys로 생성
    const imageUrls = item.imageUrls && item.imageUrls.length
      ? item.imageUrls
      : (item.imageKeys || item.tempKeys || []).map(k =>
          `${SITE_URL}/.netlify/functions/serve-image?key=${encodeURIComponent(k)}`
        );
    if (!imageUrls.length) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '게시할 이미지가 없습니다' }) };
    }

    console.log(`[select-caption] 캡션 선택: ${reservationKey}, captionIndex=${idx}`);

    // 3. 선택 상태 저장 (게시 중 표시)
    item.selectedCaptionIndex = idx;
    item.captionStatus = 'posting';
    await reserveStore.set(reservationKey, JSON.stringify(item));

    // 4. Background Function에 실제 게시 위임 (await으로 트리거 확인)
    const ownerEmail = email || item.storeProfile?.ownerEmail;
    const triggerRes = await fetch('https://lumi.it.kr/.netlify/functions/select-and-post-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reservationKey, captionIndex: idx, email: ownerEmail }),
    });
    console.log('[select-caption] select-and-post-background 트리거:', triggerRes.status);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, status: 'posting' }),
    };

  } catch (err) {
    console.error('[select-caption] 오류:', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '게시 요청 실패', detail: err.message }),
    };
  }
};
