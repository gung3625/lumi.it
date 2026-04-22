// 관리자 전용 홍보 게시 — 공개 이미지 URL 배열 + 캡션 → 관리자 IG 피드에 게시(단일 또는 캐러셀).
// 인증: Authorization: Bearer ${LUMI_SECRET}. 토큰/이메일/이름 절대 노출 금지.
const { getAdminClient } = require('./_shared/supabase-admin');
const { toProxyUrl } = require('./_shared/ig-image-url');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const GRAPH = 'https://graph.facebook.com/v25.0';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function createImageContainer(igUserId, igAccessToken, imageUrl, isCarousel) {
  const params = new URLSearchParams({ image_url: imageUrl, access_token: igAccessToken });
  if (isCarousel) params.set('is_carousel_item', 'true');
  const res = await fetch(`${GRAPH}/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || '컨테이너 생성 실패');
  return data.id;
}

async function createCarouselContainer(igUserId, igAccessToken, childIds, caption) {
  const res = await fetch(`${GRAPH}/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      media_type: 'CAROUSEL',
      children: childIds.join(','),
      caption,
      access_token: igAccessToken,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || '캐러셀 컨테이너 생성 실패');
  return data.id;
}

async function createSingleImageContainer(igUserId, igAccessToken, imageUrl, caption) {
  const res = await fetch(`${GRAPH}/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      image_url: imageUrl,
      media_type: 'IMAGE',
      caption,
      access_token: igAccessToken,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || '이미지 컨테이너 생성 실패');
  return data.id;
}

// status_code 체크 — FINISHED=성공, ERROR=실패. 5초 × 최대 6회.
async function waitForContainer(containerId, accessToken, maxRetries = 6) {
  for (let i = 0; i < maxRetries; i++) {
    await sleep(5000);
    try {
      const res = await fetch(`${GRAPH}/${containerId}?fields=status_code&access_token=${accessToken}`);
      const data = await res.json();
      if (data.status_code === 'FINISHED') return true;
      if (data.status_code === 'ERROR') return false;
    } catch (_) { /* 다음 retry */ }
  }
  return true;
}

async function publishMedia(igUserId, igAccessToken, creationId) {
  const res = await fetch(`${GRAPH}/${igUserId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ creation_id: creationId, access_token: igAccessToken }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || '게시 실패');
  return data.id;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST 전용 엔드포인트입니다.' }) };
  }

  const authHeader = (event.headers.authorization || event.headers.Authorization || '').replace('Bearer ', '');
  if (!process.env.LUMI_SECRET || authHeader !== process.env.LUMI_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 실패' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { imageUrls, caption } = body;

    if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'imageUrls(배열)가 필요합니다.' }) };
    }
    if (imageUrls.length > 10) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '캐러셀은 최대 10장까지 가능합니다.' }) };
    }
    if (typeof caption !== 'string') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'caption(문자열)이 필요합니다.' }) };
    }

    const supabase = getAdminClient();

    // 1) 관리자 계정 조회
    const { data: adminRow, error: adminErr } = await supabase
      .from('users')
      .select('id')
      .eq('is_admin', true)
      .limit(1)
      .maybeSingle();
    if (adminErr || !adminRow) {
      console.error('[admin-promo-publish] 관리자 조회 실패:', adminErr?.message || 'not found');
      return { statusCode: 500, headers, body: JSON.stringify({ error: '관리자 계정 없음' }) };
    }

    // 2) IG 토큰 조회 (Vault 복호화 뷰)
    const { data: igRow, error: igErr } = await supabase
      .from('ig_accounts_decrypted')
      .select('ig_user_id, access_token, page_access_token')
      .eq('user_id', adminRow.id)
      .maybeSingle();
    if (igErr || !igRow || !igRow.ig_user_id || !igRow.access_token) {
      console.error('[admin-promo-publish] IG 토큰 조회 실패');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'IG 연동 정보 없음' }) };
    }

    const igUserId = igRow.ig_user_id;
    const igAccessToken = igRow.page_access_token || igRow.access_token;

    console.log(`[admin-promo-publish] 게시 시작: imageCount=${imageUrls.length}`);

    // IG crawler가 Supabase 도메인 fetch 못하므로 lumi.it.kr 프록시 URL로 변환
    const proxiedUrls = imageUrls.map(toProxyUrl);

    let creationId;
    if (proxiedUrls.length === 1) {
      creationId = await createSingleImageContainer(igUserId, igAccessToken, proxiedUrls[0], caption);
    } else {
      const childIds = [];
      for (const url of proxiedUrls) {
        const id = await createImageContainer(igUserId, igAccessToken, url, true);
        childIds.push(id);
      }
      creationId = await createCarouselContainer(igUserId, igAccessToken, childIds, caption);
    }

    const ready = await waitForContainer(creationId, igAccessToken);
    if (!ready) {
      console.error('[admin-promo-publish] 컨테이너 처리 실패');
      return { statusCode: 500, headers, body: JSON.stringify({ error: '이미지 처리에 실패했습니다.' }) };
    }

    const postId = await publishMedia(igUserId, igAccessToken, creationId);
    console.log('[admin-promo-publish] 게시 완료:', postId);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, postId: String(postId), permalink: null }),
    };
  } catch (err) {
    console.error('[admin-promo-publish] 예외:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || '게시 중 오류가 발생했습니다.' }) };
  }
};

exports.headers = headers;
