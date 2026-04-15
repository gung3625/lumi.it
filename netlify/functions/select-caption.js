const { getStore } = require('@netlify/blobs');

function getBlobStore(name) {
  return getStore({
    name,
    consistency: 'strong',
    siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
    token: process.env.NETLIFY_TOKEN,
  });
}

const CORS = {
  'Access-Control-Allow-Origin': 'https://lumi.it.kr',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const SITE_URL = process.env.URL || 'https://lumi.it.kr';

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

  const { reservationKey, captionIndex, email, editedCaption } = body;

  // 인증: Bearer 토큰 또는 LUMI_SECRET (헤더로만)
  const authHeader = event.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const hasSecret = event.headers['x-lumi-secret'] === process.env.LUMI_SECRET;
  if (!bearerToken && !hasSecret) {
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

    // 2. captions[captionIndex] 가져오기 (editedCaption이 있으면 편집본 우선)
    const captions = item.captions;
    if (!captions || !captions[idx]) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `captionIndex ${idx}에 해당하는 캡션 없음` }) };
    }
    // 사용자가 편집한 캡션이 있으면 Blob에 반영 후 사용
    const selectedCaption = (editedCaption && typeof editedCaption === 'string' && editedCaption.trim())
      ? editedCaption.trim()
      : captions[idx];
    if (editedCaption && editedCaption.trim()) {
      item.captions[idx] = selectedCaption;
    }

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
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.LUMI_SECRET}` },
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
