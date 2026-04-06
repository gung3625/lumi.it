const { getStore } = require('@netlify/blobs');
const busboy = require('busboy');

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const headers = event.headers;
  const isBase64Encoded = event.isBase64Encoded;
  const bodyBuffer = Buffer.from(event.body, isBase64Encoded ? 'base64' : 'utf8');

  return new Promise((resolve) => {
    const bb = busboy({ headers });
    const fields = {};
    const photos = [];

    bb.on('file', (name, file, info) => {
      const chunks = [];
      file.on('data', (d) => chunks.push(d));
      file.on('end', () => {
        photos.push({
          fileName: info.filename,
          mimeType: info.mimeType,
          base64: Buffer.concat(chunks).toString('base64')
        });
      });
    });

    bb.on('field', (name, val) => { fields[name] = val; });

    bb.on('finish', async () => {
      if (photos.length === 0) {
        return resolve({ statusCode: 400, body: JSON.stringify({ error: '사진이 없습니다.' }) });
      }
      if (!fields.scheduledAt) {
        return resolve({ statusCode: 400, body: JSON.stringify({ error: '예약 시간이 없습니다.' }) });
      }

      try {
        let weather = {};
        let trends = [];
        let storeProfile = {};
        try { weather = JSON.parse(fields.weather || '{}'); } catch(e) {}
        try { trends = JSON.parse(fields.trends || '[]'); } catch(e) {}
        try { storeProfile = JSON.parse(fields.storeProfile || '{}'); } catch(e) {}

        const reservationId = 'reserve:' + Date.now() + ':' + Math.random().toString(36).substr(2, 6);

        const item = {
          id: reservationId,
          photos,
          photoCount: photos.length,
          userMessage: fields.userMessage || '',
          bizCategory: fields.bizCategory || 'cafe',
          captionTone: fields.captionTone || '',
          tagStyle: fields.tagStyle || 'mid',
          weather,
          trends,
          storeProfile,
          submittedAt: fields.submittedAt || new Date().toISOString(),
          scheduledAt: fields.scheduledAt,
          isSent: false
        };

        const store = getStore({
          name: 'reservations', consistency: 'strong',
          siteID: process.env.NETLIFY_SITE_ID,
          token: process.env.NETLIFY_TOKEN
        });

        await store.set(reservationId, JSON.stringify(item));

        resolve({
          statusCode: 200,
          headers: CORS,
          body: JSON.stringify({ success: true, id: reservationId, scheduledAt: fields.scheduledAt })
        });

      } catch(err) {
        console.error('save-reservation error:', err);
        resolve({ statusCode: 500, headers: CORS, body: JSON.stringify({ error: '예약 저장 중 오류가 발생했습니다.' }) });
      }
    });

    bb.end(bodyBuffer);
  });
};
