const crypto = require('crypto');

function checkSecret(provided) {
  const secret = process.env.LUMI_SECRET;
  if (!secret) return false;
  try { return crypto.timingSafeEqual(Buffer.from(provided || ''), Buffer.from(secret)); }
  catch { return false; }
}

const API_KEY = process.env.SOLAPI_API_KEY;
const API_SECRET = process.env.SOLAPI_API_SECRET;
const CHANNEL_ID = 'KA01PF26032219112677567W26lSNGQj';

// 솔라피 템플릿 (templateId: 긴 ID, code: 짧은 코드)
const TEMPLATES = {
  welcome:      { id: 'KA01TP260322191640813tM8YzoqdCss', code: 'HMttBoUZVq' },  // 회원가입 환영 (승인)
  upload:       { id: 'KA01TP260322191753216QJdWJqLkCrZ', code: '5XY1oOgtXW' },  // 업로드 알림 (승인)
  schedule:     { id: 'KA01TP260322191942267zoXVvaI7xav', code: '1EQHbXgF4t' },  // 데일리 스케줄 (승인완료)
  captionReady: { id: '', code: '' },  // 캡션 준비 완료 (솔라피 검수 후 ID 입력)
  postComplete: { id: '', code: '' },  // 게시 완료 (솔라피 검수 후 ID 입력)
  postFailed:   { id: '', code: '' }   // 게시 실패 (솔라피 검수 후 ID 입력)
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
    templateId: templateCode.id,
    variables: variables
  };

  const body = {
    message: {
      to,
      from: CHANNEL_ID,
      type: 'ATA',
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
  if (!checkSecret(secret)) {
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

  // S4 (2026-05-15): recipient 검증 — `to` 가 실제 sellers.phone 인지 확인.
  // 이전엔 LUMI_SECRET 만 가지면 임의 번호로 발송 가능 → 스팸 도구화 + SMS 비용 사장님 부담.
  // 인증된 호출자라도 등록된 셀러 phone 으로만 발송.
  try {
    const phoneNormalized = String(to).replace(/[^0-9]/g, '');
    if (!phoneNormalized || phoneNormalized.length < 9 || phoneNormalized.length > 13) {
      return { statusCode: 400, body: JSON.stringify({ error: '잘못된 전화번호 형식' }) };
    }
    const { getAdminClient } = require('./_shared/supabase-admin');
    const admin = getAdminClient();
    // sellers.phone 은 다양한 포맷일 수 있어 숫자만 비교.
    // RPC 또는 SQL LIKE 가 더 안전하지만 단순 select + filter 로 충분.
    const { data: rows, error } = await admin
      .from('sellers')
      .select('id, phone')
      .ilike('phone', `%${phoneNormalized.slice(-8)}%`)
      .limit(5);
    if (error) {
      console.warn('[send-kakao] phone 검증 query 실패:', error.message);
      return { statusCode: 500, body: JSON.stringify({ error: '발송 검증 실패' }) };
    }
    const matched = (rows || []).some((r) => String(r.phone || '').replace(/[^0-9]/g, '') === phoneNormalized);
    if (!matched) {
      console.warn('[send-kakao] recipient 미등록 셀러 — 차단:', phoneNormalized.slice(0, 3) + '***');
      return { statusCode: 403, body: JSON.stringify({ error: '등록되지 않은 수신자' }) };
    }
  } catch (vErr) {
    console.error('[send-kakao] recipient 검증 예외:', vErr.message);
    return { statusCode: 500, body: JSON.stringify({ error: '발송 검증 예외' }) };
  }

  const template = TEMPLATES[type];
  if (!template) {
    return { statusCode: 400, body: JSON.stringify({ error: '알 수 없는 템플릿 타입' }) };
  }

  try {
    let result;
    // 템플릿 ID가 없으면 SMS fallback (솔라피 검수 전 임시)
    if (!template.id) {
      const smsBody = {
        message: {
          to,
          from: process.env.SOLAPI_SENDER || '01064246284',
          type: 'SMS',
          text: variables.text || `[lumi] ${type} 알림`
        }
      };
      const smsRes = await fetch('https://api.solapi.com/messages/v4/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': getAuthHeader() },
        body: JSON.stringify(smsBody)
      });
      result = await smsRes.json();
      console.log('[lumi] SMS fallback 발송:', JSON.stringify(result));
    } else {
      result = await sendAlimtalk(to, template, variables || {});
    }
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, result })
    };
  } catch(e) {
    console.error('[lumi] 알림톡 발송 오류:', e);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: '알림톡 발송 중 오류가 발생했습니다.' })
    };
  }
};
