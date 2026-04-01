const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  console.log('[test-bg] 실행됨!', event.body);
  try {
    const store = getStore({
      name: 'reservations',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_TOKEN,
    });
    await store.set('test-bg-ran', new Date().toISOString());
    console.log('[test-bg] 저장 완료');
  } catch(e) {
    console.error('[test-bg] 오류:', e.message);
  }
};
