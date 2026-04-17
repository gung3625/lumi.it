const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  // 인증: 헤더로만 받음 (URL 쿼리 파라미터 금지 — 로그 노출 방지)
  const token = event.headers['x-admin-token'] || event.headers['authorization']?.replace('Bearer ', '');
  if (!process.env.LUMI_SECRET || token !== process.env.LUMI_SECRET) {
    // IP 기반 rate limit (Blobs에 실패 횟수 기록)
    const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || 'unknown');
    try {
      const rlStore = getStore({ name: 'rate-limit', consistency: 'strong' });
      const rlKey = 'admin-fail:' + ip;
      const rlRaw = await rlStore.get(rlKey).catch(() => null);
      const rl = rlRaw ? JSON.parse(rlRaw) : { count: 0, firstAt: Date.now() };
      rl.count++;
      await rlStore.set(rlKey, JSON.stringify(rl));
      // 10분 내 5회 이상 실패 시 차단
      if (rl.count >= 5 && (Date.now() - rl.firstAt) < 600000) {
        return { statusCode: 429, headers, body: JSON.stringify({ error: '너무 많은 시도입니다. 잠시 후 다시 시도해주세요.' }) };
      }
    } catch(e) {}
    return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 실패' }) };
  }

  const store = getStore({
    name: 'beta-applicants',
    consistency: 'strong'
  });
  const list = await store.list();

  const applicants = await Promise.all(
    list.blobs.map(async (b) => {
      try { return await store.get(b.key, { type: 'json' }); }
      catch { return null; }
    })
  );

  const valid = applicants.filter(Boolean).sort((a, b) =>
    new Date(b.appliedAt) - new Date(a.appliedAt)
  );

  return {
    statusCode: 200, headers,
    body: JSON.stringify({ count: valid.length, max: 20, applicants: valid }),
  };
};
