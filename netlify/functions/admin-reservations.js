const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function checkSecret(provided) {
  const secret = process.env.LUMI_SECRET;
  if (!secret) return false;
  try { return crypto.timingSafeEqual(Buffer.from(provided || ''), Buffer.from(secret)); }
  catch { return false; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };

  const token = (event.headers['authorization'] || '').replace('Bearer ', '').trim()
    || event.headers['x-admin-token'] || '';

  if (!checkSecret(token)) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증 실패' }) };
  }

  try {
    const store = getStore({
      name: 'reservations',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN,
    });

    const params = event.queryStringParameters || {};
    const limit = Math.min(parseInt(params.limit || '10', 10), 50);

    const list = await store.list();
    const keys = list.blobs
      .map(b => b.key)
      .filter(k => k.startsWith('reserve:'))
      .sort((a, b) => {
        const ta = parseInt(a.split(':')[1]) || 0;
        const tb = parseInt(b.split(':')[1]) || 0;
        return tb - ta;
      })
      .slice(0, limit);

    const items = await Promise.all(keys.map(async (key) => {
      try {
        const raw = await store.get(key);
        if (!raw) return null;
        const item = JSON.parse(raw);
        return {
          reservationKey: key,
          createdAt: new Date(parseInt(key.split(':')[1])).toISOString(),
          captionsGeneratedAt: item.captionsGeneratedAt || null,
          captionStatus: item.captionStatus || null,
          isSent: item.isSent || false,
          bizCategory: item.bizCategory || item.storeProfile?.category || null,
          photoCount: Array.isArray(item.photos) ? item.photos.length : 0,
          imageAnalysis: item.imageAnalysis || null,
          generatedCaptions: item.generatedCaptions || null,
          captionError: item.captionError || null,
        };
      } catch (e) {
        return { reservationKey: key, error: e.message };
      }
    }));

    const valid = items.filter(Boolean);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ count: valid.length, items: valid }),
    };
  } catch (err) {
    console.error('[admin-reservations] 에러:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '오류가 발생했습니다.' }) };
  }
};
