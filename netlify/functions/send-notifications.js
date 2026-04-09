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
  console.log('[lumi] 알림톡 발송 완료:', templateId, res.status);
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

// === 리텐션 이메일 시스템 ===

// HMAC 토큰 생성 (수신거부 링크용)
function generateUnsubToken(email) {
  return crypto.createHmac('sha256', process.env.LUMI_SECRET).update(email).digest('hex');
}

// 리텐션 이메일 HTML 빌드
function buildRetentionHtml({ heading, body, ctaText, ctaUrl, userName, email }) {
  const unsubToken = generateUnsubToken(email);
  const unsubUrl = `https://lumi.it.kr/api/unsubscribe-retention?email=${encodeURIComponent(email)}&token=${unsubToken}`;
  return `<!DOCTYPE html>
<html lang="ko">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9f9f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;">
  <tr><td style="background:#FF6B9D;padding:32px;text-align:center;">
    <span style="font-size:28px;font-weight:800;color:#fff;letter-spacing:-0.5px;">lumi</span>
  </td></tr>
  <tr><td style="padding:40px 32px;">
    <p style="margin:0 0 8px;font-size:14px;color:#666;">${userName || '대표'}님께</p>
    <h1 style="margin:0 0 20px;font-size:22px;color:#191F28;line-height:1.4;">${heading}</h1>
    <p style="margin:0 0 32px;font-size:15px;color:#4E5968;line-height:1.7;">${body}</p>
    ${ctaText && ctaUrl ? `<a href="${ctaUrl}" style="display:inline-block;padding:14px 32px;background:#FF6B9D;color:#fff;text-decoration:none;border-radius:10px;font-size:15px;font-weight:600;">${ctaText}</a>` : ''}
  </td></tr>
  <tr><td style="padding:24px 32px;border-top:1px solid #eee;font-size:12px;color:#999;line-height:1.6;">
    <p style="margin:0;">본 메일은 lumi 서비스에 마케팅 수신 동의한 회원에게 발송됩니다.</p>
    <p style="margin:4px 0 0;">발신: 루미(lumi) | 서울특별시 | 문의: help@lumi.it.kr</p>
    <p style="margin:8px 0 0;"><a href="${unsubUrl}" style="color:#999;text-decoration:underline;">수신거부</a></p>
  </td></tr>
</table>
</body></html>`;
}

// Resend로 이메일 발송
async function sendRetentionEmail(resend, to, subject, htmlContent) {
  const result = await resend.emails.send({
    from: 'lumi <noreply@lumi.it.kr>',
    to: [to],
    subject: `(광고) ${subject}`,
    html: htmlContent
  });
  return result;
}

// 활성화 시퀀스: trial + postCount === 0
async function sendActivationSequence(store, user, blobKey, resend) {
  if (user.plan !== 'trial') return null;
  if ((user.postCount || 0) > 0) return null;

  const now = new Date();
  const createdAt = new Date(user.createdAt);
  const diffDays = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));
  const sent = user.retentionEmailsSent || {};
  const userName = user.name || user.storeName;
  const email = user.email;
  let sentKey = null;

  const storeName = user.storeName || '';
  const biz = user.bizCategory || 'cafe';
  const bizExamples = {
    cafe: '☕ "오늘처럼 흐린 날엔 따뜻한 라떼 한 잔이 답이에요. 창가 자리에서 여유로운 오후, 어때요?"',
    food: '🍽️ "점심 메뉴 고민 끝! 오늘의 특선은 직접 끓인 된장찌개. 집밥이 그리울 때 오세요."',
    bakery: '🧁 "갓 구운 크루아상, 버터 향이 매장 가득. 출근길에 하나 들고 가세요!"',
    beauty: '💇 "이번 시즌 인기 컬러는 애쉬브라운! 자연스러운 톤다운으로 분위기 체인지."',
    flower: '💐 "오늘의 꽃: 프리지아. 달콤한 향기로 봄을 선물하세요."',
    fitness: '🏋️ "오늘도 한 세트 더! 꾸준함이 만드는 변화, 함께 만들어가요."'
  };
  const captionExample = bizExamples[biz] || bizExamples.cafe;
  const storeGreeting = storeName ? `${storeName} 사장님` : (userName || '사장님');

  const sequences = [
    {
      day: 1, key: 'activation_d1',
      heading: `${storeGreeting}, 첫 캡션을 만들어보세요 📸`,
      body: `사진 한 장만 올리면, lumi가 이런 캡션을 만들어 드려요.\n\n${captionExample}\n\n우리 매장 사진으로 하면 훨씬 더 잘 나와요. 지금 한번 해보세요!`,
      ctaText: '첫 사진 올리기',
    },
    {
      day: 3, key: 'activation_d3',
      heading: `${storeGreeting}, 아직 한번도 안 써보셨네요`,
      body: `매일 인스타에 뭘 쓸지 고민하는 시간, 37분이래요. lumi는 사진만 올리면 1분이면 끝나요.\n\n다른 사장님들은 벌써 캡션 받아보고 있어요. ${storeName ? storeName + '도' : '우리 매장도'} 시작해볼까요?`,
      ctaText: '캡션 예시 보러 가기',
    },
    {
      day: 5, key: 'activation_d5',
      heading: '무료 체험 2일 남았어요!',
      body: `체험 기간이 곧 끝나요. 딱 1분이면 첫 게시물을 만들 수 있어요.\n\n한 번도 안 써보고 끝나면 아깝잖아요. ${storeName ? storeName + ' 사진' : '매장 사진'} 한 장이면 충분해요!`,
      ctaText: '마지막 기회 — 지금 시작하기',
    }
  ];

  const match = sequences.find(s => s.day === diffDays);
  if (!match) return null;
  if (sent[match.key]) return null;

  const html = buildRetentionHtml({
    heading: match.heading,
    body: match.body,
    ctaText: match.ctaText,
    ctaUrl: 'https://lumi.it.kr/dashboard.html',
    userName: storeGreeting,
    email
  });

  await sendRetentionEmail(resend, email, match.heading, html);

  sent[match.key] = new Date().toISOString();
  user.retentionEmailsSent = sent;
  await store.set(blobKey, JSON.stringify(user));
  return { sent: match.key };
}

// Trial→유료 업셀 시퀀스: trial + postCount >= 1 + D5 (만료 2일 전)
async function sendTrialUpsellEmail(store, user, blobKey, resend) {
  if (user.plan !== 'trial') return null;
  if ((user.postCount || 0) < 1) return null; // 써본 적 있는 사람만

  const now = new Date();
  const createdAt = new Date(user.createdAt);
  const diffDays = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));
  if (diffDays !== 5) return null; // 가입 5일째 (만료 2일 전)

  const sent = user.retentionEmailsSent || {};
  if (sent['upsell_d5']) return null;

  const storeName = user.storeName || '';
  const storeGreeting = storeName ? `${storeName} 사장님` : (user.name || '사장님');
  const postCount = user.postCount || 0;

  const html = buildRetentionHtml({
    heading: `${storeGreeting}, 체험 기간이 거의 끝나요`,
    body: `지금까지 lumi로 ${postCount}개의 게시물을 올리셨어요.\n\n체험이 끝나면 이 기능들을 쓸 수 없게 돼요:\n• 무제한 캡션 생성\n• 날씨·트렌드 반영\n• 예약 게시\n• 말투 학습\n\n월 1.9만원부터, 대행사 비용의 1/10이에요.`,
    ctaText: '구독 시작하기',
    ctaUrl: 'https://lumi.it.kr/subscribe',
    userName: storeGreeting,
    email: user.email
  });

  await sendRetentionEmail(resend, user.email, `${storeGreeting}, 체험 기간이 거의 끝나요`, html);

  sent['upsell_d5'] = new Date().toISOString();
  user.retentionEmailsSent = sent;
  await store.set(blobKey, JSON.stringify(user));
  return { sent: 'upsell_d5' };
}

// 휴면 시퀀스: standard/pro + postCount >= 1 + 마지막 게시 후 3/7/14일
async function sendDormantSequence(store, user, blobKey, resend) {
  if (!user.plan || user.plan === 'trial') return null;
  if ((user.postCount || 0) < 1) return null;
  if (!user.lastPostedAt) return null;

  const now = new Date();
  const lastPosted = new Date(user.lastPostedAt);
  const diffDays = Math.floor((now - lastPosted) / (1000 * 60 * 60 * 24));
  const sent = user.retentionEmailsSent || {};
  const userName = user.name || user.storeName;
  const email = user.email;

  const sequences = [
    { day: 3, key: 'dormant_d3', heading: '요즘 게시물이 뜸하시네요', body: '마지막 게시 후 3일이 지났어요. 꾸준한 게시가 인스타그램 노출의 핵심이에요. 오늘 사진 한 장 올려보시는 건 어떨까요?' },
    { day: 7, key: 'dormant_d7', heading: '일주일째 조용하시네요 🤔', body: '게시물을 올리지 않으면 인스타그램 알고리즘이 가게를 덜 노출시켜요. lumi가 캡션과 해시태그를 자동으로 만들어 드리니, 사진만 찍어주세요!' },
    { day: 14, key: 'dormant_d14', heading: '가게 홍보, 다시 시작해볼까요?', body: '2주간 게시물이 없으셨어요. 경쟁 가게들은 매주 2~3회 게시하고 있어요. lumi와 함께 다시 시작해보세요. 1분이면 충분합니다.' }
  ];

  const match = sequences.find(s => s.day === diffDays);
  if (!match) return null;

  // 이전에 발송했더라도 lastPostedAt이 발송 이후이면 재발송 허용
  if (sent[match.key]) {
    const sentAt = new Date(sent[match.key]);
    if (lastPosted <= sentAt) return null;
  }

  const html = buildRetentionHtml({
    heading: match.heading,
    body: match.body,
    ctaText: '게시물 만들기',
    ctaUrl: 'https://lumi.it.kr/dashboard.html',
    userName,
    email
  });

  await sendRetentionEmail(resend, email, match.heading, html);

  sent[match.key] = new Date().toISOString();
  user.retentionEmailsSent = sent;
  await store.set(blobKey, JSON.stringify(user));
  return { sent: match.key };
}

// 주간 팁: 매주 월요일, standard/pro, 직전 주 게시 1회 이상
async function sendWeeklyTip(store, user, blobKey, resend) {
  const now = new Date();
  if (now.getDay() !== 1) return null; // 월요일만

  if (!user.plan || user.plan === 'trial') return null;
  if (!user.lastPostedAt) return null;

  const lastPosted = new Date(user.lastPostedAt);
  const daysSincePost = Math.floor((now - lastPosted) / (1000 * 60 * 60 * 24));
  if (daysSincePost > 7) return null; // 직전 주 게시 없음

  const sent = user.retentionEmailsSent || {};
  const weekKey = `weekly_${now.getFullYear()}_W${Math.ceil(((now - new Date(now.getFullYear(), 0, 1)) / 86400000 + new Date(now.getFullYear(), 0, 1).getDay() + 1) / 7)}`;
  if (sent[weekKey]) return null;

  const userName = user.name || user.storeName;
  const email = user.email;
  const tips = [
    '이번 주는 "비하인드 컷"을 올려보세요. 준비 과정이나 주방 모습은 고객에게 진정성을 전달해요.',
    '메뉴 클로즈업 사진은 항상 반응이 좋아요. 자연광에서 찍으면 더 맛있어 보입니다!',
    '고객 후기를 리포스트해보세요. 신뢰도가 올라가고 새 고객 유입에 효과적이에요.',
    '직원 소개 게시물을 올려보세요. 사람이 보이는 가게에 고객이 더 친근감을 느껴요.',
    '오늘의 추천 메뉴를 스토리로 올려보세요. 매일 다른 메뉴를 소개하면 팔로워가 매일 확인해요.'
  ];
  const tip = tips[Math.floor(Math.random() * tips.length)];

  const html = buildRetentionHtml({
    heading: '이번 주 게시물 추천 💡',
    body: tip,
    ctaText: '게시물 만들기',
    ctaUrl: 'https://lumi.it.kr/dashboard.html',
    userName,
    email
  });

  await sendRetentionEmail(resend, email, '이번 주 추천 게시 주제', html);

  sent[weekKey] = new Date().toISOString();
  user.retentionEmailsSent = sent;
  await store.set(blobKey, JSON.stringify(user));
  return { sent: weekKey };
}

// NPS 만족도 자동 수집: 첫 게시 3일 후
async function sendNpsSurveyEmail(store, user, blobKey, resend) {
  if ((user.postCount || 0) < 1) return null;
  if (!user.firstPostedAt && !user.lastPostedAt) return null;

  const firstPost = new Date(user.firstPostedAt || user.lastPostedAt);
  const now = new Date();
  const diffDays = Math.floor((now - firstPost) / (1000 * 60 * 60 * 24));
  if (diffDays !== 3) return null;

  const sent = user.retentionEmailsSent || {};
  if (sent['nps_d3']) return null;

  const storeName = user.storeName || '';
  const storeGreeting = storeName ? `${storeName} 사장님` : (user.name || '사장님');

  const html = buildRetentionHtml({
    heading: `${storeGreeting}, lumi 어떠세요?`,
    body: `게시물을 올려보신 지 며칠 됐는데, 어떠셨어요?\n\n솔직한 피드백 한 줄이면 충분해요. 사장님의 한마디가 lumi를 더 좋게 만들어요.`,
    ctaText: '피드백 남기기 (30초)',
    ctaUrl: 'https://lumi.it.kr/support#inquiry-form',
    userName: storeGreeting,
    email: user.email
  });

  await sendRetentionEmail(resend, user.email, `${storeGreeting}, lumi 사용해보니 어때요?`, html);

  sent['nps_d3'] = new Date().toISOString();
  user.retentionEmailsSent = sent;
  await store.set(blobKey, JSON.stringify(user));
  return { sent: 'nps_d3' };
}

// 리텐션 이메일 전체 실행
async function runRetentionEmails(userStore) {
  if (!process.env.RESEND_API_KEY) return { skipped: true, reason: 'RESEND_API_KEY 미설정' };

  const resend = new Resend(process.env.RESEND_API_KEY);
  const { blobs } = await userStore.list({ prefix: 'user:' });
  const results = { activation: 0, dormant: 0, weeklyTip: 0, upsell: 0, nps: 0, skipped: 0 };

  for (const blob of blobs) {
    try {
      const raw = await userStore.get(blob.key);
      if (!raw) continue;
      const user = JSON.parse(raw);
      if (!user.email) continue;

      // 마케팅 미동의 또는 수신거부 시 스킵
      if (!user.agreeMarketing) { results.skipped++; continue; }
      if (user.retentionUnsubscribed) { results.skipped++; continue; }

      const a = await sendActivationSequence(userStore, user, blob.key, resend);
      if (a) results.activation++;

      const d = await sendDormantSequence(userStore, user, blob.key, resend);
      if (d) results.dormant++;

      const w = await sendWeeklyTip(userStore, user, blob.key, resend);
      if (w) results.weeklyTip++;

      const u = await sendTrialUpsellEmail(userStore, user, blob.key, resend);
      if (u) results.upsell++;

      const n = await sendNpsSurveyEmail(userStore, user, blob.key, resend);
      if (n) results.nps++;

      await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      console.error('[retention] 발송 실패:', blob.key, e.message);
    }
  }
  return results;
}

exports.handler = async (event) => {
  // 스케줄 함수 또는 수동 호출
  const isScheduled = !event.httpMethod && !event.headers;
  if (!isScheduled) {
    const secret = event.headers?.['x-lumi-secret'];
    if (secret !== process.env.LUMI_SECRET) {
      return { statusCode: 401, body: JSON.stringify({ error: '인증 실패' }) };
    }
  }

  try {
    const userStore = getStore({
      name: 'users',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN
    });

    // 기존 알림 먼저 실행 (user 객체 write 포함)
    const [monthly, season, firstPost, expiry] = await Promise.all([
      sendMonthlyReport(userStore),
      sendSeasonEventAlert(userStore),
      sendFirstPostCoaching(userStore),
      sendExpiryAlert(userStore)
    ]);
    // 리텐션 이메일은 순차 실행 (race condition 방지)
    const retention = await runRetentionEmails(userStore);

    // 운영자 일일 리포트 SMS
    try {
      const { blobs: allUsers } = await userStore.list({ prefix: 'user:' });
      let totalUsers = 0, activeToday = 0, totalPosts = 0, trialUsers = 0, paidUsers = 0;
      const today = new Date().toISOString().slice(0, 10);
      for (const b of allUsers) {
        try {
          const u = JSON.parse(await userStore.get(b.key));
          totalUsers++;
          if (u.plan === 'trial') trialUsers++;
          else if (u.plan) paidUsers++;
          totalPosts += (u.postCount || 0);
          if (u.lastPostedAt && u.lastPostedAt.slice(0, 10) === today) activeToday++;
        } catch(e) {}
      }
      const betaStore = getStore({ name: 'beta-applicants', consistency: 'strong', siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc', token: process.env.NETLIFY_TOKEN });
      const betaList = await betaStore.list();
      const betaCount = betaList.blobs.length;

      const reportText = `[lumi 일일 리포트]\n베타 신청: ${betaCount}/20명\n가입자: ${totalUsers}명 (체험 ${trialUsers} / 유료 ${paidUsers})\n오늘 활성: ${activeToday}명\n총 게시물: ${totalPosts}건`;

      const now = new Date().toISOString();
      const salt = `report_${Date.now()}`;
      const crypto = require('crypto');
      const sig = crypto.createHmac('sha256', process.env.SOLAPI_API_SECRET).update(`${now}${salt}`).digest('hex');
      await fetch('https://api.solapi.com/messages/v4/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `HMAC-SHA256 ApiKey=${process.env.SOLAPI_API_KEY}, Date=${now}, Salt=${salt}, Signature=${sig}`,
        },
        body: JSON.stringify({ message: { to: '01064246284', from: '01064246284', text: reportText } }),
      });
    } catch(e) { console.log('일일 리포트 실패:', e.message); }

    console.log('[lumi] 알림 발송 완료:', { monthly, season, firstPost, expiry, retention });
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, monthly, season, firstPost, expiry, retention })
    };
  } catch(err) {
    console.error('send-notifications error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
