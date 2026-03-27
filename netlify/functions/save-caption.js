const { getStore } = require('@netlify/blobs');

// Make.com에서 캡션 생성 후 호출하는 콜백 함수
// 캡션을 caption-history에 저장 → 다음 접속 시 피드백 UI에 표시

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  const { email, caption, secret } = body;

  // 시크릿 검증
  if (secret !== process.env.LUMI_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: '인증 실패' }) };
  }

  if (!email || !caption) {
    return { statusCode: 400, body: JSON.stringify({ error: 'email, caption 필수' }) };
  }

  try {
    const store = getStore({
      name: 'users',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN
    });

    // 1. 기존 caption-history 불러오기
    let history = [];
    try {
      const raw = await store.get('caption-history:' + email);
      if (raw) history = JSON.parse(raw);
    } catch { history = []; }

    // 2. 새 캡션 추가 (최대 20개 유지, 피드백 대기 상태로)
    const newEntry = {
      id: Date.now(),
      caption,
      createdAt: new Date().toISOString(),
      feedback: null  // null = 미응답, 'like' = 👍, 'dislike' = 👎
    };
    history.unshift(newEntry);
    if (history.length > 20) history = history.slice(0, 20);

    await store.set('caption-history:' + email, JSON.stringify(history));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, captionId: newEntry.id })
    };
  } catch (err) {
    console.error('save-caption error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: '저장 실패', detail: err.message }) };
  }
};
