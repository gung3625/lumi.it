// Background Function — 캡션 선택 후 실제 Instagram 게시 처리
const { getStore } = require('@netlify/blobs');
const { createHmac } = require('crypto');

function getBlobStore(name) {
  return getStore({
    name,
    consistency: 'strong',
    siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
    token: process.env.NETLIFY_TOKEN,
  });
}

function getTempImageStore() {
  return getStore({
    name: 'temp-images',
    consistency: 'strong',
    siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
    token: process.env.NETLIFY_TOKEN,
  });
}

async function cleanupTempImages(keys) {
  if (!keys || !keys.length) return;
  const imgStore = getTempImageStore();
  for (const key of keys) {
    try { await imgStore.delete(key); } catch (e) {}
  }
}

const SITE_URL = 'https://lumi.it.kr';

async function createMediaContainer(igUserId, igAccessToken, imageUrl, isCarousel) {
  const params = new URLSearchParams({ image_url: imageUrl, access_token: igAccessToken });
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

async function publishMedia(igUserId, igAccessToken, creationId) {
  const res = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ creation_id: creationId, access_token: igAccessToken }),
  });
  return res.json();
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForContainer(containerId, accessToken, maxRetries = 6) {
  for (let i = 0; i < maxRetries; i++) {
    await sleep(1000);
    try {
      const res = await fetch(`https://graph.facebook.com/v25.0/${containerId}?fields=status_code&access_token=${accessToken}`);
      const data = await res.json();
      if (data.status_code === 'FINISHED') return true;
      if (data.status_code === 'ERROR') return false;
    } catch(e) {}
  }
  return true;
}

async function postToInstagram(item, caption, imageUrls) {
  const igUserId = item.igUserId;
  const igAccessToken = item.igPageAccessToken || item.igAccessToken;
  if (!igUserId || !igAccessToken) throw new Error('Instagram 연동 정보 없음');

  let postId;

  if (imageUrls.length > 1) {
    // 캐러셀 아이템 컨테이너 병렬 생성
    const containerIds = await Promise.all(imageUrls.map(url =>
      createMediaContainer(igUserId, igAccessToken, url, true)
    ));
    const cRes = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ media_type: 'CAROUSEL', children: containerIds.join(','), caption, access_token: igAccessToken }),
    });
    const cData = await cRes.json();
    if (cData.error) throw new Error(cData.error.message);
    await waitForContainer(cData.id, igAccessToken);
    const pData = await publishMedia(igUserId, igAccessToken, cData.id);
    if (pData.error) throw new Error(pData.error.message);
    postId = pData.id;
  } else {
    const res = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ image_url: imageUrls[0], media_type: 'IMAGE', caption, access_token: igAccessToken }),
    });
    const d = await res.json();
    if (d.error) throw new Error(d.error.message);
    await waitForContainer(d.id, igAccessToken);
    const pData = await publishMedia(igUserId, igAccessToken, d.id);
    if (pData.error) throw new Error(pData.error.message);
    postId = pData.id;
  }

  // 스토리 — 유저 액세스 토큰만 사용 (pageAccessToken은 스토리 권한 없음)
  if (item.storyEnabled && imageUrls[0]) {
    try {
      const storyToken = item.igAccessToken; // 유저 토큰 명시적 사용
      await sleep(3000); // 피드 게시 후 잠시 대기
      const sRes = await fetch(`https://graph.facebook.com/v25.0/${igUserId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ image_url: imageUrls[0], media_type: 'STORIES', access_token: storyToken }),
      });
      const sData = await sRes.json();
      if (sData.error) {
        console.error('[select-and-post] 스토리 컨테이너 생성 실패:', JSON.stringify(sData.error));
      } else {
        await waitForContainer(sData.id, storyToken);
        await publishMedia(igUserId, storyToken, sData.id);
        console.log('[select-and-post] 스토리 게시 완료');
      }
    } catch (e) { console.error('[select-and-post] 스토리 예외:', e.message); }
  }

  return postId;
}

async function postToThreads(caption, imageUrl) {
  const userId = process.env.THREADS_USER_ID;
  const token = process.env.THREADS_ACCESS_TOKEN;
  if (!userId || !token) throw new Error('Threads 환경변수 없음');

  // Step 1: Container 생성
  const createRes = await fetch(`https://graph.threads.net/v1.0/${userId}/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_type: 'IMAGE', image_url: imageUrl, text: caption, access_token: token }),
  });
  const createData = await createRes.json();
  if (createData.error) throw new Error(`Threads container error: ${JSON.stringify(createData.error)}`);
  const creationId = createData.id;

  // Step 2: 30초 대기
  await sleep(30000);

  // Step 3: Publish
  const pubRes = await fetch(`https://graph.threads.net/v1.0/${userId}/threads_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: creationId, access_token: token }),
  });
  return await pubRes.json();
}

async function saveCaptionHistory(email, caption) {
  try {
    const store = getBlobStore('users');
    let history = [];
    const raw = await store.get('caption-history:' + email).catch(() => null);
    if (raw) history = JSON.parse(raw);
    history.unshift({ id: Date.now(), caption: caption.trim(), createdAt: new Date().toISOString(), feedback: null });
    if (history.length > 20) history = history.slice(0, 20);
    await store.set('caption-history:' + email, JSON.stringify(history));
  } catch (e) { console.error('[select-and-post] 캡션 히스토리 저장 실패:', e.message); }
}

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
  } catch (e) { console.error('[select-and-post] 알림톡 실패:', e.message); }
}

exports.handler = async (event) => {
  // 내부 호출 인증
  const authHeader = (event.headers['authorization'] || '').replace('Bearer ', '');
  if (authHeader !== process.env.LUMI_SECRET) {
    console.error('[select-and-post] 인증 실패');
    return { statusCode: 401 };
  }

  let reservationKey = null;
  try {
    const body = JSON.parse(event.body || '{}');
    reservationKey = body.reservationKey;
    const captionIndex = Number(body.captionIndex);
    if (!reservationKey) return;

    const reserveStore = getBlobStore('reservations');
    const raw = await reserveStore.get(reservationKey);
    if (!raw) return;

    const item = JSON.parse(raw);
    if (item.isSent) { console.log('[select-and-post] 이미 게시됨'); return; }

    // 중복 호출 방지: 게시 진행 중 상태로 먼저 저장
    if (item.captionStatus !== 'posting') {
      item.captionStatus = 'posting';
      await reserveStore.set(reservationKey, JSON.stringify(item));
    }

    const captions = item.captions || item.generatedCaptions || [];
    const selectedCaption = captions[captionIndex];
    if (!selectedCaption) { console.error('[select-and-post] 캡션 없음'); return; }

    const imageUrls = item.imageUrls && item.imageUrls.length
      ? item.imageUrls
      : (item.imageKeys || item.tempKeys || []).map(k =>
          `${SITE_URL}/.netlify/functions/serve-image?key=${encodeURIComponent(k)}`
        );
    if (!imageUrls.length) { console.error('[select-and-post] 이미지 없음'); return; }

    console.log(`[select-and-post] 게시 시작: ${reservationKey}, captionIndex=${captionIndex}`);
    const postId = await postToInstagram(item, selectedCaption, imageUrls);
    console.log('[select-and-post] Instagram 게시 완료:', postId);

    // Threads 게시 (postToThread 플래그 확인)
    if (item.postToThread && imageUrls[0]) {
      try {
        console.log('[select-and-post] Threads 게시 시작');
        const threadsResult = await postToThreads(selectedCaption, imageUrls[0]);
        if (threadsResult.error) {
          console.error('[select-and-post] Threads 게시 실패:', JSON.stringify(threadsResult.error));
        } else {
          console.log('[select-and-post] Threads 게시 완료:', threadsResult.id);
        }
      } catch (te) {
        console.error('[select-and-post] Threads 예외:', te.message);
      }
    }

    // 완료 상태 저장
    item.isSent = true;
    item.sentAt = new Date().toISOString();
    item.captionStatus = 'posted';
    item.instagramPostId = postId;
    item.selectedCaptionIndex = captionIndex;
    item.postedCaption = selectedCaption;
    await reserveStore.set(reservationKey, JSON.stringify(item));

    // 게시 성공 후 임시 이미지 삭제
    const tempKeysToDelete = item.imageKeys || item.tempKeys || [];
    await cleanupTempImages(tempKeysToDelete);

    // 캡션 히스토리 저장
    const email = body.email || item.storeProfile?.ownerEmail;
    if (email) await saveCaptionHistory(email, selectedCaption);

    // 완료 알림톡
    const phone = item.storeProfile?.phone || item.storeProfile?.ownerPhone;
    const sp = item.storeProfile || {};
    if (phone) {
      await sendAlimtalk(phone, `[lumi] 인스타그램에 게시됐어요! 📸\n\n${sp.name || '매장'} 게시물이 올라갔어요.\n인스타그램에서 확인해보세요!`);
    }

  } catch (err) {
    console.error('[select-and-post] 에러:', err.message);
    // 에러 상태 저장
    if (reservationKey) {
      try {
        const store = getBlobStore('reservations');
        const raw = await store.get(reservationKey);
        if (raw) {
          const item = JSON.parse(raw);
          item.postError = err.message;
          item.postErrorAt = new Date().toISOString();
          item.captionStatus = 'failed';
          await store.set(reservationKey, JSON.stringify(item));
        }
      } catch (_) {}
    }
  }
};
