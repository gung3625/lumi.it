// 자동응답 로그 평가 — 👍/👎 + 선택적 수정 답변
// POST /api/rate-auto-reply — Bearer 토큰 인증 필수
// 👎 + 수정 답변이 있으면 auto_reply_corrections에도 추가 (few-shot 학습 샘플)
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // 1. Bearer 토큰 검증
  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  // 2. body 파싱
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const logId = Number(body.log_id);
  const rating = Number(body.rating);
  const correctedReply = typeof body.corrected_reply === 'string' ? body.corrected_reply : null;
  const feedbackNote = typeof body.feedback_note === 'string' ? body.feedback_note : null;

  if (!Number.isFinite(logId) || logId <= 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'log_id가 필요합니다.' }) };
  }
  if (rating !== 1 && rating !== -1) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'rating은 1 또는 -1이어야 해요.' }) };
  }

  const admin = getAdminClient();

  try {
    // 3. 로그 소유권 확인
    const { data: log, error: logErr } = await admin
      .from('auto_reply_log')
      .select('id, user_id, category, received_text')
      .eq('id', logId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (logErr) {
      console.error('[rate-auto-reply] 로그 조회 오류:', logErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '로그 조회 실패' }) };
    }
    if (!log) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: '로그를 찾을 수 없어요.' }) };
    }

    // 4. auto_reply_log 업데이트
    const nowIso = new Date().toISOString();
    const { error: updateErr } = await admin
      .from('auto_reply_log')
      .update({
        rating,
        corrected_reply: correctedReply || null,
        feedback_note: feedbackNote || null,
        rated_at: nowIso,
      })
      .eq('id', logId)
      .eq('user_id', user.id);

    if (updateErr) {
      console.error('[rate-auto-reply] 로그 업데이트 오류:', updateErr.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '평가 저장 실패' }) };
    }

    // 5. 👎 + 수정 답변이 충분하면 auto_reply_corrections에도 학습 샘플로 추가
    let learned = false;
    const trimmedCorrection = (correctedReply || '').trim();
    const customerMessage = (log.received_text || '').trim();

    if (
      rating === -1 &&
      trimmedCorrection.length >= 2 &&
      customerMessage.length > 0
    ) {
      // 중복 체크: 같은 user + customer_message + correct_reply
      const { data: existing, error: dupErr } = await admin
        .from('auto_reply_corrections')
        .select('id')
        .eq('user_id', user.id)
        .eq('customer_message', customerMessage)
        .eq('correct_reply', trimmedCorrection)
        .limit(1)
        .maybeSingle();

      if (dupErr) {
        console.error('[rate-auto-reply] 중복 체크 오류:', dupErr.message);
      }

      if (!existing) {
        const { error: insertErr } = await admin
          .from('auto_reply_corrections')
          .insert({
            user_id: user.id,
            category: log.category || null,
            customer_message: customerMessage,
            correct_reply: trimmedCorrection,
          });

        if (insertErr) {
          console.error('[rate-auto-reply] corrections insert 오류:', insertErr.message);
        } else {
          learned = true;
        }
      }
    }

    console.log(`[rate-auto-reply] user=${user.id} log_id=${logId} rating=${rating} learned=${learned}`);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, log_id: logId, learned }),
    };
  } catch (err) {
    console.error('[rate-auto-reply] 예외:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message || '서버 오류' }) };
  }
};
