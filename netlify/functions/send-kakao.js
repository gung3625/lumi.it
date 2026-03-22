const crypto = require('crypto');

const API_KEY = process.env.SOLAPI_API_KEY;
const API_SECRET = process.env.SOLAPI_API_SECRET;
const CHANNEL_ID = process.env.SOLAPI_CHANNEL_ID || 'lumi_it';

// 솔라피 템플릿 코드
const TEMPLATES = {
  welcome: 'HMttBoUZVq',      // 회원가입 환영
  upload: '5XY1oOgtXW',       // 업로드 알림
  schedule: '1EQHbXgF4t'      // 데일리 스케줄 가이드
};

// 솔라피 HMAC 인증 헤더 생성
function getAuthHeader() {
  const date = new Date().toISOString();
  const salt = Math.random().toString(36).substring(2, 12);
  const signature = crypto
    .createHmac('sha256', API_SECRET)
    .update(date + salt)
    .digest('hex');
  return `HMAC-SHA256 apiKey=${API_KEY}, date=${date}, salt=${salt}, signature=${signature}`;
}

// 알림톡 발송
async function sendAlimtalk(to, templateCode, variables) {
  const url = 'https://api.solapi.com/messages/v4/send';

  // 변수를 #{변수명} 형태로 치환
  const kakaoOptions = {
    pfId: CHANNEL_ID,
    templateId: templateCode,
    variables: variables
  };

  const body = {
    message: {
      to,
      from: CHANNEL_ID,
      kakaoOptions
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': getAuthHeader()
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  console.log('[lumi] 알림톡 발송 결과:', JSON.stringify(data));
  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // LUMI_SECRET 인증
  const secret = event.headers['x-lumi-secret'];
  if (secret !== process.env.LUMI_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: '인증 실패' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bad Request' }) };
  }

  const { type, to, variables } = body;

  if (!type || !to) {
    return { statusCode: 400, body: JSON.stringify({ error: 'type, to 필수' }) };
  }

  const templateCode = TEMPLATES[type];
  if (!templateCode) {
    return { statusCode: 400, body: JSON.stringify({ error: '알 수 없는 템플릿 타입' }) };
  }

  try {
    const result = await sendAlimtalk(to, templateCode, variables || {});
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, result })
    };
  } catch(e) {
    console.error('[lumi] 알림톡 발송 오류:', e.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: '발송 실패', message: e.message })
    };
  }
};
