const { corsHeaders, getOrigin } = require('./_shared/auth');
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');


exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'POST 전용' }) };
  }

  const token = extractBearerToken(event);
  if (!token) {
    return { statusCode: 401, headers: headers, body: JSON.stringify({ error: '인증 필요' }) };
  }
  const { user, error: authError } = await verifyBearerToken(token);
  if (authError || !user) {
    return { statusCode: 401, headers: headers, body: JSON.stringify({ error: '유효하지 않은 토큰' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: '잘못된 JSON' }) };
  }

  const { reservation_id, rating } = body;
  if (!reservation_id || typeof reservation_id !== 'number') {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'reservation_id 필수 (number)' }) };
  }
  if (!['like', 'dislike', 'skip'].includes(rating)) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'rating은 like | dislike | skip 중 하나' }) };
  }

  try {
    const admin = getAdminClient();

    // IDOR 방지: 예약이 해당 user 소유인지 확인
    const { data: reservation, error: resErr } = await admin
      .from('reservations')
      .select('id, user_id, captions, selected_caption_index, caption')
      .eq('id', reservation_id)
      .maybeSingle();

    if (resErr || !reservation) {
      return { statusCode: 404, headers: headers, body: JSON.stringify({ error: '예약을 찾을 수 없습니다' }) };
    }
    if (reservation.user_id !== user.id) {
      return { statusCode: 403, headers: headers, body: JSON.stringify({ error: '접근 권한 없음' }) };
    }

    // like / dislike 이면 tone_feedback insert (20개 롤링)
    if (rating === 'like' || rating === 'dislike') {
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

      try {
        // 20개 롤링: 오래된 행 삭제 후 insert
        const { data: existingFeedback } = await admin
          .from('tone_feedback')
          .select('id, created_at')
          .eq('user_id', user.id)
          .eq('kind', rating)
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
          kind: rating,
          caption: captionText,
          reservation_id: reservation.id,
          created_at: new Date().toISOString(),
        });
      } catch (e) {
        console.warn('[rate-caption] tone_feedback 저장 실패:', e.message);
      }
    }

    // 모든 경우: tone_rated = true로 업데이트
    const { error: updateErr } = await admin
      .from('reservations')
      .update({ tone_rated: true })
      .eq('id', reservation_id)
      .eq('user_id', user.id);

    if (updateErr) {
      console.error('[rate-caption] tone_rated 업데이트 실패:', updateErr.message);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '평가 저장 실패' }) };
    }

    console.log(`[rate-caption] 평가 완료: reservation_id=${reservation_id}, rating=${rating}`);
    return { statusCode: 200, headers: headers, body: JSON.stringify({ success: true }) };

  } catch (err) {
    console.error('[rate-caption] 예외:', err.message);
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
