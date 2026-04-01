const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');
const { Resend } = require('resend');

// 솔라피 설정
const API_KEY = process.env.SOLAPI_API_KEY;
const API_SECRET = process.env.SOLAPI_API_SECRET;
const CHANNEL_ID = 'KA01PF26032219112677567W26lSNGQj';

// 알림 타입별 템플릿 (솔라피에 등록 후 ID 업데이트 필요)
const TEMPLATES = {
  monthly_report:   { id: 'KA01TP_MONTHLY_REPORT' },   // 월간 리포트
  season_event:     { id: 'KA01TP_SEASON_EVENT' },     // 시즌/이벤트 알림
  first_post_coach: { id: 'KA01TP_FIRST_POST' },       // 첫 게시물 코칭
  expiry_d7:        { id: 'KA01TP_EXPIRY_D7' }         // 구독 만료 D-7
};

// 솔라피 HMAC 인증 헤더
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
async function sendAlimtalk(to, templateId, variables) {
  const body = {
    message: {
      to,
      from: CHANNEL_ID,
      type: 'ATA',
      kakaoOptions: {
        pfId: CHANNEL_ID,
        templateId,
        variables
      }
    }
  };

  const res = await fetch('https://api.solapi.com/messages/v4/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': getAuthHeader()
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  console.log('[lumi] 알림톡 발송:', to, templateId, JSON.stringify(data));
  return data;
}

// 한국 주요 시즌/이벤트 캘린더
const SEASON_EVENTS = [
  { month: 1, day: 1,  name: '신정',        tip: '새해 첫날 특별 메뉴나 이벤트를 미리 준비해보세요!' },
  { month: 1, day: 24, name: '설날',         tip: '명절 연휴 전후 영업 안내 게시물을 미리 올려두세요.' },
  { month: 2, day: 14, name: '발렌타인데이', tip: '초콜릿, 커플, 선물 테마 게시물이 반응이 좋아요.' },
  { month: 3, day: 1,  name: '삼일절',       tip: '봄 시즌 개막! 봄 신메뉴나 봄 분위기 사진을 준비해보세요.' },
  { month: 3, day: 14, name: '화이트데이',   tip: '달콤한 선물 테마 콘텐츠로 팔로워 반응을 높여보세요.' },
  { month: 4, day: 5,  name: '식목일',       tip: '자연, 그린, 봄꽃 테마 사진이 인기 많아요.' },
  { month: 5, day: 5,  name: '어린이날',     tip: '가족 고객을 겨냥한 어린이날 특별 이벤트를 알려보세요.' },
  { month: 5, day: 8,  name: '어버이날',     tip: '카네이션, 감사, 가족 테마 게시물을 준비해보세요.' },
  { month: 6, day: 6,  name: '현충일',       tip: '조용하고 감성적인 분위기의 게시물이 어울려요.' },
  { month: 7, day: 15, name: '여름 휴가철',  tip: '여름 특별 메뉴, 시원한 음료 사진이 반응 폭발이에요!' },
  { month: 8, day: 15, name: '광복절',       tip: '시즌 이벤트나 특별 할인 소식을 알려보세요.' },
  { month: 9, day: 17, name: '추석',         tip: '명절 연휴 영업 안내와 선물 세트 게시물을 미리 준비해보세요.' },
  { month: 10, day: 3, name: '개천절',       tip: '가을 시즌 신메뉴나 가을 감성 사진을 올려보세요.' },
  { month: 10, day: 31, name: '할로윈',      tip: '핼러윈 테마 데코나 시즌 메뉴를 게시해보세요.' },
  { month: 11, day: 11, name: '빼빼로데이', tip: '빼빼로 테마 디저트, 선물 콘텐츠가 인기예요.' },
  { month: 12, day: 25, name: '크리스마스', tip: '크리스마스 분위기 사진과 특별 이벤트를 미리 알려보세요.' },
  { month: 12, day: 31, name: '연말',        tip: '한 해 마무리 감사 인사와 새해 계획을 공유해보세요.' }
];

// 오늘로부터 7일 후 이벤트 찾기
function getUpcomingEvent() {
  const now = new Date();
  const target = new Date(now);
  target.setDate(target.getDate() + 7);

  return SEASON_EVENTS.find(e => {
    const eventDate = new Date(target.getFullYear(), e.month - 1, e.day);
    const diffDays = Math.round((eventDate - now) / (1000 * 60 * 60 * 24));
    return diffDays >= 6 && diffDays <= 8;
  }) || null;
}

// 월간 리포트 발송 (매월 1일)
async function sendMonthlyReport(userStore) {
  const now = new Date();
  if (now.getDate() !== 1) return { skipped: true, reason: '월 1일이 아님' };

  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthStr = `${lastMonth.getFullYear()}-${lastMonth.getMonth() + 1}`;

  const { blobs } = await userStore.list({ prefix: 'user:' });
  let sent = 0;

  for (const blob of blobs) {
    try {
      const raw = await userStore.get(blob.key);
      if (!raw) continue;
      const user = JSON.parse(raw);
      if (!user.phone || !user.plan || user.plan === 'trial') continue;

      const planLimitMap = { standard: 16, pro: 20 };
      const limit = planLimitMap[user.plan] || 16;
      const used = user.postCountMonth === lastMonthStr ? (user.postCount || 0) : 0;
      const remaining = Math.max(0, limit - used);

      // 다음 결제일 계산
      let nextBillingStr = '갱신일 미정';
      if (user.subscriptionStart) {
        const nextBilling = new Date(user.subscriptionStart);
        nextBilling.setMonth(nextBilling.getMonth() + 1);
        nextBillingStr = `${nextBilling.getMonth() + 1}월 ${nextBilling.getDate()}일`;
      }

      await sendAlimtalk(user.phone, TEMPLATES.monthly_report.id, {
        '#{이름}': user.name || user.storeName || '대표님',
        '#{지난달}': `${lastMonth.getMonth() + 1}월`,
        '#{게시횟수}': String(used),
        '#{남은횟수}': String(remaining),
        '#{다음결제일}': nextBillingStr
      });
      sent++;
      await new Promise(r => setTimeout(r, 200));
    } catch(e) {
      console.error('[monthly_report] 발송 실패:', blob.key, e.message);
    }
  }
  return { sent };
}

// 시즌/이벤트 D-7 알림
async function sendSeasonEventAlert(userStore) {
  const event = getUpcomingEvent();
  if (!event) return { skipped: true, reason: '7일 내 이벤트 없음' };

  const { blobs } = await userStore.list({ prefix: 'user:' });
  let sent = 0;

  for (const blob of blobs) {
    try {
      const raw = await userStore.get(blob.key);
      if (!raw) continue;
      const user = JSON.parse(raw);
      if (!user.phone) continue; // trial 포함 전체 발송

      await sendAlimtalk(user.phone, TEMPLATES.season_event.id, {
        '#{이름}': user.name || user.storeName || '대표님',
        '#{이벤트}': event.name,
        '#{팁}': event.tip
      });
      sent++;
      await new Promise(r => setTimeout(r, 200));
    } catch(e) {
      console.error('[season_event] 발송 실패:', blob.key, e.message);
    }
  }
  return { sent, event: event.name };
}

// 첫 게시물 코칭 (가입 후 3일 미업로드)
async function sendFirstPostCoaching(userStore) {
  const now = new Date();
  const { blobs } = await userStore.list({ prefix: 'user:' });
  let sent = 0;

  for (const blob of blobs) {
    try {
      const raw = await userStore.get(blob.key);
      if (!raw) continue;
      const user = JSON.parse(raw);
      if (!user.phone) continue;

      const createdAt = new Date(user.createdAt);
      const diffDays = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));

      // 가입 후 정확히 3일째이고 게시물이 없는 경우
      if (diffDays !== 3) continue;
      if ((user.postCount || 0) > 0) continue;
      // 이미 코칭 발송했으면 스킵
      if (user.firstPostCoachSent) continue;

      await sendAlimtalk(user.phone, TEMPLATES.first_post_coach.id, {
        '#{이름}': user.name || user.storeName || '대표님'
      });

      // 발송 기록
      user.firstPostCoachSent = true;
      await userStore.set(blob.key.replace('user:', 'user:'), JSON.stringify(user));
      sent++;
      await new Promise(r => setTimeout(r, 200));
    } catch(e) {
      console.error('[first_post_coach] 발송 실패:', blob.key, e.message);
    }
  }
  return { sent };
}

// 구독 만료 D-7 알림
async function sendExpiryAlert(userStore) {
  const now = new Date();
  const targetDate = new Date(now);
  targetDate.setDate(targetDate.getDate() + 7);
  const { blobs } = await userStore.list({ prefix: 'user:' });
  let sent = 0;

  for (const blob of blobs) {
    try {
      const raw = await userStore.get(blob.key);
      if (!raw) continue;
      const user = JSON.parse(raw);
      if (!user.phone || !user.subscriptionEnd) continue;
      if (user.plan === 'trial') continue;
      if (user.autoRenew === true) continue; // 자동갱신이면 스킵

      const expiryDate = new Date(user.subscriptionEnd);
      const diffDays = Math.floor((expiryDate - now) / (1000 * 60 * 60 * 24));
      if (diffDays !== 7) continue;

      const expiryStr = `${expiryDate.getMonth() + 1}월 ${expiryDate.getDate()}일`;

      await sendAlimtalk(user.phone, TEMPLATES.expiry_d7.id, {
        '#{이름}': user.name || user.storeName || '대표님',
        '#{만료일}': expiryStr,
        '#{플랜}': user.plan === 'pro' ? '프로' : '스탠다드'
      });
      sent++;
      await new Promise(r => setTimeout(r, 200));
    } catch(e) {
      console.error('[expiry_d7] 발송 실패:', blob.key, e.message);
    }
  }
  return { sent };
}

exports.handler = async (event) => {
  // 스케줄 함수 또는 수동 호출
  const isScheduled = !event.httpMethod;
  if (!isScheduled) {
    const secret = event.headers?.['x-lumi-secret'];
    if (secret !== process.env.LUMI_SECRET) {
      return { statusCode: 401, body: JSON.stringify({ error: '인증 실패' }) };
    }
  }

  try {
    const userStore = getStore({
      name: 'users',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN
    });

    const [monthly, season, firstPost, expiry] = await Promise.all([
      sendMonthlyReport(userStore),
      sendSeasonEventAlert(userStore),
      sendFirstPostCoaching(userStore),
      sendExpiryAlert(userStore)
    ]);

    console.log('[lumi] 알림 발송 완료:', { monthly, season, firstPost, expiry });
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, monthly, season, firstPost, expiry })
    };
  } catch(err) {
    console.error('send-notifications error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
