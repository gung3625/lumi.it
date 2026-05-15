// _shared/ig-publish.js — Instagram 게시 헬퍼 (single image / carousel / REELS + story)
//
// select-and-post-background 의 IG 게시 흐름을 추출. retry-channel-post 가
// 같은 흐름으로 한 채널만 재게시 가능하도록 공유.
//
// 의도:
//   IG Graph 호출 패턴이 4가지 분기 (REELS / CAROUSEL / 단일 IMAGE + 각각의
//   STORIES 옵션) 라 인라인 분산. 한 함수에 모아두고 *호출자가 reservation
//   data 만 넘기면* 게시 흐름 그대로 재현.

'use strict';

const { toProxyUrl } = require('./ig-image-url');

const GRAPH_BASE = 'https://graph.facebook.com/v25.0';

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// IG 컨테이너 status 폴링 — 5초 × maxRetries 회.
// D 옵션 (2026-05-15): polling interval 5초 → 2초.
// 평균 5~10초 단축 (REELS+STORIES 둘 다 폴링하므로 2배 효과).
// maxRetries default 6 → 18 (5×6=30초 → 2×18=36초 — 동일 cap 유지).
// 호출자가 maxRetries 명시한 케이스 (REELS=24, STORIES=12) 도 cycle 변경 의도 반영해
// 자동 2.5배 (REELS 60, STORIES 30) — 본 함수에서 override 하지 않고 호출처에서 새 값 명시.
async function waitForContainer(containerId, accessToken, maxRetries = 18) {
  for (let i = 0; i < maxRetries; i++) {
    await sleep(2000);
    try {
      const res = await fetch(`${GRAPH_BASE}/${containerId}?fields=status_code&access_token=${accessToken}`);
      const data = await res.json();
      if (data.status_code === 'FINISHED') return true;
      if (data.status_code === 'ERROR') return false;
    } catch (e) { /* 다음 retry */ }
  }
  return true;
}

async function createMediaContainer(igUserId, igAccessToken, imageUrl, isCarousel) {
  const params = new URLSearchParams({ image_url: imageUrl, access_token: igAccessToken });
  if (isCarousel) params.set('is_carousel_item', 'true');
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 60_000);
  let res;
  try {
    res = await fetch(`${GRAPH_BASE}/${igUserId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(tid);
  }
  const data = await res.json();
  if (data.error) throw new Error(`IG container error: ${data.error.message || 'unknown'}`);
  return data.id;
}

async function publishMedia(igUserId, igAccessToken, creationId) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 60_000);
  let res;
  try {
    res = await fetch(`${GRAPH_BASE}/${igUserId}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ creation_id: creationId, access_token: igAccessToken }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(tid);
  }
  return res.json();
}

/**
 * Instagram 게시 — REELS / CAROUSEL / 단일 IMAGE + STORIES 옵션.
 *
 * @param {object} ctx
 * @param {string} ctx.igUserId
 * @param {string} ctx.igAccessToken         - page_access_token 우선
 * @param {string} ctx.igUserAccessToken     - 유저 액세스 토큰 (STORIES 전용)
 * @param {boolean} ctx.storyEnabled         - reservation.story_enabled
 * @param {string} ctx.mediaType             - 'REELS' | 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM'
 * @param {string} [ctx.videoUrl]            - REELS 일 때
 * @param {string} caption
 * @param {string[]} imageUrls
 * @returns {Promise<string>} - IG media id (게시된 post)
 */
async function postToInstagram({ igUserId, igAccessToken, igUserAccessToken, storyEnabled, mediaType, videoUrl }, caption, imageUrls) {
  if (!igUserId || !igAccessToken) throw new Error('Instagram 연동 정보 없음');
  imageUrls = Array.isArray(imageUrls) ? imageUrls.map(toProxyUrl) : imageUrls;
  let postId;

  // REELS 게시 (영상)
  if (mediaType === 'REELS') {
    if (!videoUrl) throw new Error('Reels 영상 URL 없음');
    const params = new URLSearchParams({
      media_type: 'REELS',
      video_url: videoUrl,
      caption,
      access_token: igAccessToken,
    });
    const reelsCtrl = new AbortController();
    const reelsTid = setTimeout(() => reelsCtrl.abort(), 90_000);
    let res;
    try {
      res = await fetch(`${GRAPH_BASE}/${igUserId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
        signal: reelsCtrl.signal,
      });
    } finally {
      clearTimeout(reelsTid);
    }
    const d = await res.json();
    if (d.error) throw new Error(d.error.message || 'Reels 컨테이너 생성 실패');
    const ready = await waitForContainer(d.id, igAccessToken, 60);
    if (!ready) throw new Error('Reels 컨테이너 처리 시간 초과');
    const pData = await publishMedia(igUserId, igAccessToken, d.id);
    if (pData.error) throw new Error(pData.error.message || 'Reels publish 실패');
    postId = pData.id;

    // 영상 스토리
    if (storyEnabled && videoUrl) {
      try {
        const storyToken = igUserAccessToken || igAccessToken;
        await sleep(3000);
        const sCtrl = new AbortController();
        const sTid = setTimeout(() => sCtrl.abort(), 60_000);
        let sRes;
        try {
          sRes = await fetch(`${GRAPH_BASE}/${igUserId}/media`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ media_type: 'STORIES', video_url: videoUrl, access_token: storyToken }),
            signal: sCtrl.signal,
          });
        } finally {
          clearTimeout(sTid);
        }
        const sData = await sRes.json();
        if (sData.error) {
          console.error('[ig-publish] REELS 스토리 컨테이너 생성 실패:', sData.error.message || sData.error);
        } else {
          // waitForContainer 결과 검증 — false 면 status=ERROR, publish skip.
          // STORIES 영상 처리는 30초 부족할 수 있어 maxRetries 12 (총 60초) 로 확대.
          const storyReady = await waitForContainer(sData.id, storyToken, 30);
          if (!storyReady) {
            console.error('[ig-publish] REELS 스토리 컨테이너 status=ERROR — publish skip');
          } else {
            const sPub = await publishMedia(igUserId, storyToken, sData.id);
            if (sPub && sPub.error) {
              console.error('[ig-publish] REELS 스토리 publish 실패:', sPub.error.message || JSON.stringify(sPub.error));
            } else {
              console.log('[ig-publish] REELS 스토리 게시 완료, story_id=', sPub && sPub.id);
            }
          }
        }
      } catch (e) { console.error('[ig-publish] REELS 스토리 예외:', e.message); }
    }
    return postId;
  }

  // CAROUSEL
  if (imageUrls.length > 1) {
    const containerIds = await Promise.all(imageUrls.map((url) => createMediaContainer(igUserId, igAccessToken, url, true)));
    const cCtrl = new AbortController();
    const cTid = setTimeout(() => cCtrl.abort(), 60_000);
    let cRes;
    try {
      cRes = await fetch(`${GRAPH_BASE}/${igUserId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          media_type: 'CAROUSEL',
          children: containerIds.join(','),
          caption,
          access_token: igAccessToken,
        }),
        signal: cCtrl.signal,
      });
    } finally {
      clearTimeout(cTid);
    }
    const cData = await cRes.json();
    if (cData.error) throw new Error(cData.error.message);
    await waitForContainer(cData.id, igAccessToken);
    const pData = await publishMedia(igUserId, igAccessToken, cData.id);
    if (pData.error) throw new Error(pData.error.message);
    postId = pData.id;
  } else {
    // 단일 IMAGE
    const imgCtrl = new AbortController();
    const imgTid = setTimeout(() => imgCtrl.abort(), 60_000);
    let res;
    try {
      res = await fetch(`${GRAPH_BASE}/${igUserId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ image_url: imageUrls[0], caption, access_token: igAccessToken }),
        signal: imgCtrl.signal,
      });
    } finally {
      clearTimeout(imgTid);
    }
    const d = await res.json();
    if (d.error) throw new Error(d.error.message);
    await waitForContainer(d.id, igAccessToken);
    const pData = await publishMedia(igUserId, igAccessToken, d.id);
    if (pData.error) throw new Error(pData.error.message);
    postId = pData.id;
  }

  // STORIES (image)
  if (storyEnabled && imageUrls[0]) {
    try {
      const storyToken = igUserAccessToken || igAccessToken;
      await sleep(3000);
      const stCtrl = new AbortController();
      const stTid = setTimeout(() => stCtrl.abort(), 60_000);
      let sRes;
      try {
        sRes = await fetch(`${GRAPH_BASE}/${igUserId}/media`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ image_url: imageUrls[0], media_type: 'STORIES', access_token: storyToken }),
          signal: stCtrl.signal,
        });
      } finally {
        clearTimeout(stTid);
      }
      const sData = await sRes.json();
      if (sData.error) {
        console.error('[ig-publish] 스토리 컨테이너 생성 실패');
      } else {
        await waitForContainer(sData.id, storyToken);
        await publishMedia(igUserId, storyToken, sData.id);
        console.log('[ig-publish] 스토리 게시 완료');
      }
    } catch (e) { console.error('[ig-publish] 스토리 예외:', e.message); }
  }

  return postId;
}

module.exports = {
  sleep,
  waitForContainer,
  createMediaContainer,
  publishMedia,
  postToInstagram,
};
