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

      return {
        statusCode: 200, headers,
        body: JSON.stringify({ success: true, remaining: 20 - list.blobs.length - 1 }),
      };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
