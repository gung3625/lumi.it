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
  // S7 (2026-05-15): access_token 을 URL query 가 아닌 Authorization 헤더로.
  // 이전엔 ?access_token=... 로 GET → Netlify access log / 중간 proxy / browser referrer
  // 에 토큰 평문 잔존. POST body 패턴 (createMediaContainer/publishMedia) 과 일관성도 회복.
  for (let i = 0; i < maxRetries; i++) {
    await sleep(2000);
    try {
      const res = await fetch(`${GRAPH_BASE}/${containerId}?fields=status_code`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
      const data = await res.json();
      if (data.status_code === 'FINISHED') return true;
      if (data.status_code === 'ERROR') return false;
    } catch (e) { /* 다음 retry */ }
  }
  // C2 (2026-05-15): timeout 시 fail-closed (false). 이전엔 true 반환해서 IN_PROGRESS
  // 상태에서 publish 시도 → 빈 게시물 / 잘못된 게시 위험. STORIES 분기와 일관성도 회복.
  return false;
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
    const carouselReady = await waitForContainer(cData.id, igAccessToken);
    if (!carouselReady) throw new Error('CAROUSEL 컨테이너 처리 실패');
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
    const imgReady = await waitForContainer(d.id, igAccessToken);
    if (!imgReady) throw new Error('IMAGE 컨테이너 처리 실패');
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
        console.error('[ig-publish] 스토리 컨테이너 생성 실패:', sData.error.message || sData.error);
      } else {
        const stReady = await waitForContainer(sData.id, storyToken);
        if (!stReady) {
          console.error('[ig-publish] 이미지 스토리 컨테이너 status=ERROR/timeout — publish skip');
        } else {
          const sPub = await publishMedia(igUserId, storyToken, sData.id);
          if (sPub && sPub.error) {
            console.error('[ig-publish] 이미지 스토리 publish 실패:', sPub.error.message || JSON.stringify(sPub.error));
          } else {
            console.log('[ig-publish] 스토리 게시 완료, story_id=', sPub && sPub.id);
          }
        }
      }
    } catch (e) { console.error('[ig-publish] 스토리 예외:', e.message); }
  }

  return postId;
}

// IG 토큰 만료 패턴 — Graph error message 가 다양해서 5개 패턴 매칭.
// select-and-post + retry-channel-post 동일 매칭이라 헬퍼로 추출 (Important D, 2026-05-20).
function isIgTokenExpiredMessage(msg) {
  const s = String(msg || '');
  return (
    /code["']?\s*:\s*190/i.test(s) ||
    /OAuthException/i.test(s) ||
    /session has expired/i.test(s) ||
    /access token.*(expired|invalid)/i.test(s) ||
    /Invalid OAuth/i.test(s)
  );
}

/**
 * postToInstagram + 토큰 자동 갱신 1회 재시도.
 *
 * Important D (2026-05-20): scheduled-ig-token-refresh 가 매일 06:00 KST 만 돈다.
 * 그 사이 24h 안에 토큰 expire 되면 발행 stuck (현재는 caption_status='failed' +
 * 사장님 재연동 요구). 본 wrapper 는 401/code 190 받은 즉시 refreshIgTokenForSeller
 * 호출 후 새 토큰으로 1회 재시도. 사장님 무인지 복구.
 *
 * 주의: REELS 의 경우 첫 fetch (container 생성) 가 401 받고 죽으면 retry 안전 —
 * 중복 container 안 만들어짐. 만약 container 생성 후 publish 단계에서 401 받으면
 * (희박) retry 가 새 container 만들어 게시 → 결과적으로 양쪽 다 OK (orphan container
 * 는 24h 후 자동 만료).
 *
 * @param {object} ctx              - postToInstagram 의 첫 인자 (igUserId, igAccessToken 등)
 * @param {string} caption
 * @param {string[]} imageUrls
 * @param {object} refreshOpts      - { sellerId, supabase } — refresh 에 필요한 컨텍스트
 * @returns {Promise<string>}        - IG media id
 */
async function postToInstagramWithRefresh(ctx, caption, imageUrls, { sellerId, supabase }) {
  try {
    return await postToInstagram(ctx, caption, imageUrls);
  } catch (err) {
    if (!isIgTokenExpiredMessage(err && err.message)) throw err;
    if (!sellerId || !supabase) throw err;  // refresh 컨텍스트 없으면 그대로 throw

    console.log(`[ig-publish] 토큰 만료 감지 — 자동 갱신 시도 (seller=${String(sellerId).slice(0, 8)})`);
    const { refreshIgTokenForSeller } = require('./ig-graph');
    const refreshed = await refreshIgTokenForSeller(sellerId, supabase);
    if (!refreshed || !refreshed.accessToken) {
      console.warn('[ig-publish] 토큰 갱신 실패 — 원래 에러 throw');
      throw err;
    }

    console.log('[ig-publish] 토큰 갱신 성공 — 게시 1회 재시도');
    return await postToInstagram(
      { ...ctx, igAccessToken: refreshed.accessToken },
      caption,
      imageUrls,
    );
  }
}

module.exports = {
  sleep,
  waitForContainer,
  createMediaContainer,
  publishMedia,
  postToInstagram,
  postToInstagramWithRefresh,
  isIgTokenExpiredMessage,
};
