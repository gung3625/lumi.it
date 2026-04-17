const { getStore } = require('@netlify/blobs');

function getBlobStore(name) {
  return getStore({
    name,
    consistency: 'strong'
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

// ── editedCaption 안전성 검수 ──
async function moderateCaption(text) {
  try {
    const res = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY },
      body: JSON.stringify({ input: text }),
    });
    if (!res.ok) { console.warn('[moderation] API 응답 오류:', res.status); return true; }
    const data = await res.json();
    return !data.results?.[0]?.flagged;
  } catch (e) { console.warn('[moderation] 실패, 통과:', e.message); return true; }
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

  const { reservationKey, captionIndex, editedCaption } = body;

  // 인증: Bearer 토큰 또는 LUMI_SECRET (헤더로만)
  const authHeader = event.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const hasSecret = event.headers['x-lumi-secret'] === process.env.LUMI_SECRET;
  if (!bearerToken && !hasSecret) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증 실패' }) };
  }

  // C2/H2: 토큰에서 email 추출 + 만료 체크
  let tokenEmail = null;
  if (bearerToken && !hasSecret) {
    const userStore = getBlobStore('users');
    const tokenRaw = await userStore.get('token:' + bearerToken).catch(() => null);
    if (!tokenRaw) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '유효하지 않은 토큰' }) };
    }
    const tokenData = JSON.parse(tokenRaw);
    if (tokenData.expiresAt && Date.now() > tokenData.expiresAt) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '토큰이 만료되었습니다.' }) };
    }
    tokenEmail = tokenData.email || null;
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

    // C2: IDOR 방지 — Bearer 토큰 사용자는 자신의 예약만 선택 가능
    if (tokenEmail && item.storeProfile?.ownerEmail && tokenEmail !== item.storeProfile.ownerEmail) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: '접근 권한이 없습니다.' }) };
    }

    // 이미 게시된 경우 중복 방지
    if (item.isSent || item.captionStatus === 'posted') {
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: '이미 게시된 예약입니다' }) };
    }

    // 2. captions[captionIndex] 가져오기 (editedCaption이 있으면 편집본 우선)
    const captions = item.captions;
    if (!captions || !captions[idx]) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `captionIndex ${idx}에 해당하는 캡션 없음` }) };
    }
    // 사용자가 편집한 캡션이 있으면 길이 제한 + Moderation 검수 후 Blob에 반영
    if (editedCaption && typeof editedCaption === 'string' && editedCaption.trim()) {
      if (editedCaption.length > 2200) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '캡션은 2,200자를 초과할 수 없습니다.' }) };
      }
      const safe = await moderateCaption(editedCaption);
      if (!safe) {
        return { statusCode: 422, headers: CORS, body: JSON.stringify({ error: '캡션이 안전성 검수를 통과하지 못했습니다.' }) };
      }
    }
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
          `${SITE_URL}/ig-img/${Buffer.from(k).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')}.jpg`
        );
    if (!imageUrls.length) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '게시할 이미지가 없습니다' }) };
    }

    console.log(`[select-caption] 캡션 선택: ${reservationKey}, captionIndex=${idx}`);

    // 3. postMode 확인: immediate만 즉시 게시, 나머지는 scheduler 대기
    const postMode = item.postMode || 'immediate';
    const ownerEmail = tokenEmail || item.storeProfile?.ownerEmail;

    if (postMode === 'immediate') {
      // 즉시 게시: 선택 상태 저장 후 Background Function 트리거
      item.selectedCaptionIndex = idx;
      item.captionStatus = 'posting';
      await reserveStore.set(reservationKey, JSON.stringify(item));

      let triggerOk = false;
      try {
        const triggerRes = await fetch('https://lumi.it.kr/.netlify/functions/select-and-post-background', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.LUMI_SECRET}` },
          body: JSON.stringify({ reservationKey, captionIndex: idx, email: ownerEmail }),
        });
        console.log('[select-caption] select-and-post-background 트리거:', triggerRes.status);
        triggerOk = triggerRes.ok || triggerRes.status === 202;
      } catch (triggerErr) {
        console.error('[select-caption] select-and-post-background 트리거 실패:', triggerErr.message);
      }

      if (!triggerOk) {
        // 트리거 실패 — captionStatus를 ready로 롤백해 사용자가 재시도 가능하게 함
        item.captionStatus = 'ready';
        await reserveStore.set(reservationKey, JSON.stringify(item));
        return {
          statusCode: 500,
          headers: CORS,
          body: JSON.stringify({ error: '게시 요청 중 오류가 발생했습니다. 다시 시도해주세요.' }),
        };
      }

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ success: true, status: 'posting' }),
      };
    } else {
      // 예약 게시 (best-time / scheduled): 캡션 선택만 저장, scheduler가 나중에 처리
      item.selectedCaptionIndex = idx;
      item.captionStatus = 'scheduled';
      await reserveStore.set(reservationKey, JSON.stringify(item));
      console.log(`[select-caption] 예약 저장 완료 (postMode=${postMode}): ${reservationKey}, scheduledAt=${item.scheduledAt}`);

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ success: true, status: 'scheduled', scheduledAt: item.scheduledAt }),
      };
    }

  } catch (err) {
    console.error('[select-caption] 오류:', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '게시 요청 실패' }),
    };
  }
};
