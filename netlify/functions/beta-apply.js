const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const store = getStore({ name: 'beta-applicants', consistency: 'strong' });

  // GET: 현재 신청자 수 조회
  if (event.httpMethod === 'GET') {
    try {
      const list = await store.list();
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ count: list.blobs.length, max: 20 }),
      };
    } catch {
      return { statusCode: 200, headers, body: JSON.stringify({ count: 0, max: 20 }) };
    }
  }

  // POST: 신청 저장
  if (event.httpMethod === 'POST') {
    try {
      const { name, store: storeName, type, phone, insta } = JSON.parse(event.body);
      if (!name || !storeName || !type || !phone) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: '필수 항목 누락' }) };
      }

      const list = await store.list();
      if (list.blobs.length >= 20) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: '마감', waitlist: true }) };
      }

      const id = `applicant_${Date.now()}`;
      await store.setJSON(id, {
        id, name, store: storeName, type, phone,
        insta: insta || '', appliedAt: new Date().toISOString(),
      });

      // 운영자 알림톡 발송
      const remaining = 20 - list.blobs.length - 1;
      try {
        await fetch('https://api.solapi.com/messages/v4/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `HMAC-SHA256 ApiKey=${process.env.SOLAPI_API_KEY}, Date=${new Date().toISOString()}, Salt=${id}, Signature=${require('crypto').createHmac('sha256', process.env.SOLAPI_API_SECRET).update(`${new Date().toISOString()}${id}`).digest('hex')}`,
          },
          body: JSON.stringify({
            message: {
              to: '01064246284',
              from: '01064246284',
              text: `[lumi 베타 신청]\n이름: ${name}\n매장: ${storeName}\n업종: ${type}\n연락처: ${phone}\n인스타: ${insta || '미입력'}\n\n잔여: ${remaining}명`,
            },
          }),
        });
      } catch(e) { console.log('알림톡 실패:', e.message); }

      return {
        statusCode: 200, headers,
        body: JSON.stringify({ success: true, remaining }),
      };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
