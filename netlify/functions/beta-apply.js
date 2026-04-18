const { getAdminClient } = require('./_shared/supabase-admin');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  let supa;
  try {
    supa = getAdminClient();
  } catch(e) {
    console.error('[beta-apply] Supabase 초기화 실패:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류가 발생했어요. 잠시 후 다시 시도해주세요.' }) };
  }

  // GET: 현재 신청자 수 조회
  if (event.httpMethod === 'GET') {
    try {
      const { count, error } = await supa
        .from('beta_applicants')
        .select('*', { count: 'exact', head: true });
      if (error) throw error;
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ count: count || 0, max: 20 }),
      };
    } catch(e) {
      return { statusCode: 200, headers, body: JSON.stringify({ count: 0, max: 20 }) };
    }
  }

  // POST: 신청 저장
  if (event.httpMethod === 'POST') {
    try {
      const { name, store: storeName, type, phone, insta, referral, utm } = JSON.parse(event.body);
      if (!name || !storeName || !type || !phone) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: '필수 항목 누락' }) };
      }

      // 현재 신청자 수 확인
      const { count: applicantCount, error: countErr } = await supa
        .from('beta_applicants')
        .select('*', { count: 'exact', head: true });
      if (countErr) throw countErr;

      const currentCount = applicantCount || 0;

      if (currentCount >= 20) {
        // 대기 명단에 저장
        const { error: waitErr } = await supa.from('beta_waitlist').insert({
          name,
          store_name: storeName,
          store_type: type,
          phone,
          insta: insta || null,
          referral: referral || null,
          utm: utm ? (typeof utm === 'object' ? utm : { raw: utm }) : null,
        });
        if (waitErr) throw waitErr;
        return { statusCode: 400, headers, body: JSON.stringify({ error: '마감', waitlist: true }) };
      }

      // 신청자 저장
      const { error: insertErr } = await supa.from('beta_applicants').insert({
        name,
        store_name: storeName,
        store_type: type,
        phone,
        insta: insta || null,
        referral: referral || null,
        utm: utm ? (typeof utm === 'object' ? utm : { raw: utm }) : null,
      });
      if (insertErr) throw insertErr;

      const remaining = 20 - currentCount - 1;

      // 운영자 알림톡 발송
      try {
        const msgId = `apply_${Date.now()}`;
        const now = new Date().toISOString();
        const signature = require('crypto').createHmac('sha256', process.env.SOLAPI_API_SECRET).update(`${now}${msgId}`).digest('hex');
        await fetch('https://api.solapi.com/messages/v4/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `HMAC-SHA256 ApiKey=${process.env.SOLAPI_API_KEY}, Date=${now}, Salt=${msgId}, Signature=${signature}`,
          },
          body: JSON.stringify({
            message: {
              to: '01064246284',
              from: '01064246284',
              text: `[lumi 베타 신청]\n이름: ${name}\n매장: ${storeName}\n업종: ${type}\n연락처: ${phone}\n인스타: ${insta || '미입력'}\n유입: ${referral || (utm && utm.source) || '미입력'}\n\n잔여: ${remaining}명`,
            },
          }),
        });
      } catch(e) { console.log('[beta-apply] 운영자 알림 실패:', e.message); }

      // 신청자에게 자동 응답 SMS
      try {
        const now2 = new Date().toISOString();
        const salt2 = `reply_${Date.now()}`;
        const sig2 = require('crypto').createHmac('sha256', process.env.SOLAPI_API_SECRET).update(`${now2}${salt2}`).digest('hex');
        await fetch('https://api.solapi.com/messages/v4/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `HMAC-SHA256 ApiKey=${process.env.SOLAPI_API_KEY}, Date=${now2}, Salt=${salt2}, Signature=${sig2}`,
          },
          body: JSON.stringify({
            message: {
              to: phone,
              from: '01064246284',
              text: `[lumi] ${name}님, 베타 테스터 신청이 완료됐어요!\n\n24시간 내로 카카오톡으로 안내드릴게요. 조금만 기다려주세요 :)\n\nlumi.it.kr`,
            },
          }),
        });
      } catch(e) { console.log('[beta-apply] 신청자 응답 SMS 실패:', e.message); }

      console.log('[beta-apply] 신청 처리 완료');
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ success: true, remaining }),
      };
    } catch (e) {
      console.error('[beta-apply] error:', e.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: '처리 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.' }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
