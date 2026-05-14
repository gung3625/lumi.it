// 사장님 단위 Netlify Blobs 캐시 통합 무효화 헬퍼.
// 호출처: ig-oauth · threads-oauth · disconnect-ig · disconnect-threads.
// 사장님이 인스타·쓰레드 connect/disconnect 한 시점에 관련 모든 cache 를 일괄 삭제해
// dashboard·settings UI 가 즉시 새 상태 반영하도록 한다.
const { getStore } = require('@netlify/blobs');

function siteParams() {
  return {
    siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
    token: process.env.NETLIFY_TOKEN,
    consistency: 'eventual',
  };
}

/**
 * 사장님 한 명의 모든 channel-state 의존 cache 삭제.
 * - comments: `sellers/{userId}.json` (igConnected/threadsConnected/items)
 * - insights/weekly: `weekly/{userId}` (IG·Threads 인사이트 7일)
 * - insights/monthly: `monthly/{userId}` (IG·Threads 인사이트 30일)
 * 단건 미디어 캐시(`media/{channel}/{mediaId}`) 는 미디어 단위라 영향 X — skip.
 *
 * @param {string} userId — sellers.id (= auth.users.id = ig_accounts.user_id)
 * @returns {Promise<{ deleted: string[], failed: string[] }>}
 */
async function invalidateSellerChannelCaches(userId) {
  if (!userId) return { deleted: [], failed: [] };
  const deleted = [];
  const failed = [];

  const tasks = [
    { store: 'comments', key: `sellers/${userId}.json` },
    { store: 'insights', key: `weekly/${userId}` },
    { store: 'insights', key: `monthly/${userId}` },
  ];

  for (const { store: name, key } of tasks) {
    try {
      const store = getStore({ name, ...siteParams() });
      await store.delete(key);
      deleted.push(`${name}/${key}`);
    } catch (e) {
      failed.push(`${name}/${key}: ${e && e.message}`);
    }
  }

  return { deleted, failed };
}

module.exports = { invalidateSellerChannelCaches };
