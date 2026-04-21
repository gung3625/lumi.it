const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'GET 전용' }) };
  }

  const token = extractBearerToken(event);
  if (!token) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증 필요' }) };
  }
  const { user, error: authError } = await verifyBearerToken(token);
  if (authError || !user) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '유효하지 않은 토큰' }) };
  }

  try {
    const admin = getAdminClient();

    // 게시 완료 + 미평가 예약 중 가장 최근 1건
    const { data: reservation, error: resErr } = await admin
      .from('reservations')
      .select('id, caption, captions, selected_caption_index, image_urls, image_keys, created_at')
      .eq('user_id', user.id)
      .eq('caption_status', 'posted')
      .eq('is_sent', true)
      .eq('tone_rated', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (resErr) {
      console.error('[pending-caption-rating] 조회 실패:', resErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '조회 실패' }) };
    }

    if (!reservation) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ pending: false }) };
    }

    // 캡션 텍스트 추출
    let captionText = '';
    if (reservation.caption) {
      captionText = reservation.caption;
    } else if (Array.isArray(reservation.captions) && reservation.captions.length > 0) {
      const idx = typeof reservation.selected_caption_index === 'number'
        ? reservation.selected_caption_index
        : 0;
      const raw = reservation.captions[idx] || reservation.captions[0];
      captionText = typeof raw === 'string' ? raw : JSON.stringify(raw);
    }

    // 이미지 URL
    let imageUrl = '';
    if (Array.isArray(reservation.image_urls) && reservation.image_urls.length > 0) {
      imageUrl = reservation.image_urls[0];
    } else if (Array.isArray(reservation.image_keys) && reservation.image_keys.length > 0) {
      const k = reservation.image_keys[0];
      const b64 = Buffer.from(k).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      imageUrl = `https://lumi.it.kr/ig-img/${b64}.jpg`;
    }

    // 매장명
    let storeName = '';
    try {
      const { data: profile } = await admin
        .from('profiles')
        .select('store_name')
        .eq('id', user.id)
        .maybeSingle();
      if (profile && profile.store_name) storeName = profile.store_name;
    } catch (e) { console.warn('[pending-caption-rating] store_name 조회 실패:', e.message); }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        pending: true,
        reservation_id: reservation.id,
        caption: captionText,
        image_url: imageUrl,
        store_name: storeName,
        posted_at: reservation.created_at,
      }),
    };
  } catch (err) {
    console.error('[pending-caption-rating] 예외:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
