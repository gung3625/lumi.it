/**
 * Instagram Graph API 공유 헬퍼
 */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function igFetch(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await res.json();
  if (data.error) {
    const msg = data.error.message || JSON.stringify(data.error);
    const err = new Error(`Instagram API: ${msg}`);
    err.igError = data.error;
    throw err;
  }
  return data;
}

async function postToInstagram({ igUserId, igAccessToken, imageUrls, caption, storyEnabled }) {
  const apiBase = `https://graph.facebook.com/v25.0/${igUserId}`;
  const photoCount = imageUrls.length;
  let postId;

  if (photoCount === 1) {
    // 단일 이미지 게시
    const container = await igFetch(`${apiBase}/media`, {
      image_url: imageUrls[0],
      caption,
      access_token: igAccessToken,
    });
    await sleep(10000);
    const pub = await igFetch(`${apiBase}/media_publish`, {
      creation_id: container.id,
      access_token: igAccessToken,
    });
    postId = pub.id;
  } else {
    // 캐러셀 게시
    const childrenIds = [];
    for (const url of imageUrls) {
      const child = await igFetch(`${apiBase}/media`, {
        image_url: url,
        is_carousel_item: 'true',
        access_token: igAccessToken,
      });
      childrenIds.push(child.id);
    }

    const carousel = await igFetch(`${apiBase}/media`, {
      media_type: 'CAROUSEL',
      children: childrenIds.join(','),
      caption,
      access_token: igAccessToken,
    });
    await sleep(10000);
    const pub = await igFetch(`${apiBase}/media_publish`, {
      creation_id: carousel.id,
      access_token: igAccessToken,
    });
    postId = pub.id;
  }

  // 스토리 게시
  if (storyEnabled) {
    try {
      const story = await igFetch(`${apiBase}/media`, {
        image_url: imageUrls[0],
        media_type: 'STORIES',
        access_token: igAccessToken,
      });
      await sleep(5000);
      await igFetch(`${apiBase}/media_publish`, {
        creation_id: story.id,
        access_token: igAccessToken,
      });
      console.log('[lumi] 스토리 게시 완료');
    } catch (err) {
      console.error('[lumi] 스토리 게시 실패 (피드는 성공):', err.message);
    }
  }

  return postId;
}

module.exports = { postToInstagram, sleep };
