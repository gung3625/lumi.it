const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');

const CORS = {
  'Access-Control-Allow-Origin': 'https://lumi.it.kr',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const SITE_URL = process.env.URL || 'https://lumi.it.kr';

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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Bad Request: 잘못된 JSON' }) };
  }

  const { reservationKey, captionIndex, editedCaption } = body;

  // Bearer 토큰 검증
  const token = extractBearerToken(event);
  if (!token) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증 실패' }) };
  }
  const { user, error: authError } = await verifyBearerToken(token);
  if (authError || !user) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '유효하지 않은 토큰' }) };
  }

  // 필수 파라미터 검증
  if (!reservationKey) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'reservationKey 필수' }) };
  }
  if (captionIndex === undefined || captionIndex === null || ![0, 1, 2].includes(Number(captionIndex))) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'captionIndex는 0, 1, 2 중 하나여야 합니다' }) };
  }

  const idx = Number(captionIndex);
  const admin = getAdminClient();

  try {
    // 1. 예약 조회 + user_id 검증 (IDOR 방지)
    const { data: reservation, error: resErr } = await admin
      .from('reservations')
      .select('*')
      .eq('reserve_key', reservationKey)
      .eq('user_id', user.id)
      .single();

    if (resErr || !reservation) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '예약 데이터 없음' }) };
    }

    // 이미 게시된 경우 중복 방지
    if (reservation.is_sent || reservation.caption_status === 'posted') {
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: '이미 게시된 예약입니다' }) };
    }

    // 2. 캡션 가져오기 (editedCaption 있으면 우선)
    const captions = Array.isArray(reservation.captions) ? reservation.captions : [];
    if (!captions[idx]) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `captionIndex ${idx}에 해당하는 캡션 없음` }) };
    }

    // editedCaption 검증
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

    // editedCaption이 있으면 captions 배열 업데이트
    let updatedCaptions = captions;
    if (editedCaption && editedCaption.trim()) {
      updatedCaptions = [...captions];
      updatedCaptions[idx] = selectedCaption;
    }

    // 이미지 URL 구성
    const imageUrls = reservation.image_urls && reservation.image_urls.length
      ? reservation.image_urls
      : (reservation.image_keys || []).map(k =>
          `${SITE_URL}/ig-img/${Buffer.from(k).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')}.jpg`
        );
    if (!imageUrls.length) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '게시할 이미지가 없습니다' }) };
    }

    console.log(`[select-caption] 캡션 선택: ${reservationKey}, captionIndex=${idx}`);

    // 3. 말투 피드백 저장: 선택한 캡션 → like (20개 롤링)
    try {
      const { data: existingFeedback } = await admin
        .from('tone_feedback')
        .select('id, created_at')
        .eq('user_id', user.id)
        .eq('kind', 'like')
        .order('created_at', { ascending: true });

      const totalAfterInsert = (existingFeedback ? existingFeedback.length : 0) + 1;
      if (totalAfterInsert > 20) {
        const deleteCount = totalAfterInsert - 20;
        const idsToDelete = (existingFeedback || []).slice(0, deleteCount).map(r => r.id);
        if (idsToDelete.length > 0) {
          await admin.from('tone_feedback').delete().in('id', idsToDelete);
        }
      }

      await admin.from('tone_feedback').insert({
        user_id: user.id,
        kind: 'like',
        caption: selectedCaption,
        reservation_id: reservation.id,
        created_at: new Date().toISOString(),
      });
    } catch (e) { console.warn('[tone-learn] like 저장 실패:', e.message); }

    // 4. postMode 확인
    const postMode = reservation.post_mode || 'immediate';

    if (postMode === 'immediate') {
      // 즉시 게시: 선택 상태 저장 후 Background Function 트리거
      const { error: updateErr } = await admin
        .from('reservations')
        .update({
          selected_caption_index: idx,
          captions: updatedCaptions,
          caption_status: 'posting',
        })
        .eq('reserve_key', reservationKey)
        .eq('user_id', user.id);

      if (updateErr) {
        console.error('[select-caption] 업데이트 실패:', updateErr.message);
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '게시 요청 실패' }) };
      }

      let triggerOk = false;
      try {
        const triggerRes = await fetch('https://lumi.it.kr/.netlify/functions/select-and-post-background', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.LUMI_SECRET}` },
          body: JSON.stringify({ reservationKey, captionIndex: idx, userId: user.id }),
        });
        console.log('[select-caption] select-and-post-background 트리거:', triggerRes.status);
        triggerOk = triggerRes.ok || triggerRes.status === 202;
      } catch (triggerErr) {
        console.error('[select-caption] select-and-post-background 트리거 실패:', triggerErr.message);
      }

      if (!triggerOk) {
        // 트리거 실패 — caption_status 롤백
        await admin
          .from('reservations')
          .update({ caption_status: 'ready' })
          .eq('reserve_key', reservationKey)
          .eq('user_id', user.id);
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
      // 예약 게시: 캡션 선택만 저장, scheduler가 나중에 처리
      const { error: updateErr } = await admin
        .from('reservations')
        .update({
          selected_caption_index: idx,
          captions: updatedCaptions,
          caption_status: 'scheduled',
        })
        .eq('reserve_key', reservationKey)
        .eq('user_id', user.id);

      if (updateErr) {
        console.error('[select-caption] 예약 저장 실패:', updateErr.message);
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '게시 요청 실패' }) };
      }

      console.log(`[select-caption] 예약 저장 완료 (postMode=${postMode}): ${reservationKey}, scheduledAt=${reservation.scheduled_at}`);

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ success: true, status: 'scheduled', scheduledAt: reservation.scheduled_at }),
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
