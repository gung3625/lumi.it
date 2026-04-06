const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');
const { getTodayBestSlot } = require('./get-best-time');

const API_KEY = process.env.SOLAPI_API_KEY;
const API_SECRET = process.env.SOLAPI_API_SECRET;
const CHANNEL_ID = 'KA01PF26032219112677567W26lSNGQj';
const SCHEDULE_TEMPLATE_ID = 'KA01TP260322191942267zoXVvaI7xav';

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
async function sendAlimtalk(to, variables) {
  const body = {
    message: {
      to,
      from: CHANNEL_ID,
      type: 'ATA',
      kakaoOptions: {
        pfId: CHANNEL_ID,
        templateId: SCHEDULE_TEMPLATE_ID,
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
  console.log('[lumi] 데일리 알림톡 발송 완료:', res.status);
  return data;
}

// 날씨 상태 → 한국어 가이드
function getWeatherGuide(status) {
  if (!status) return '오늘도 매장의 특별한 순간을 담아보세요!';
  const s = status.toLowerCase();
  if (s.includes('맑') || s.includes('clear')) return '자연광을 최대한 활용해보세요. 채광 좋은 자리에서 찍은 사진이 반응이 좋아요.';
  if (s.includes('비') || s.includes('rain')) return '창가 조명을 활용해보세요. 빗소리와 함께하는 아늑한 무드 사진이 공감을 많이 받아요.';
  if (s.includes('눈') || s.includes('snow')) return '따뜻한 김이 모락모락 나는 메뉴 사진이 딱이에요. 겨울 감성 물씬 풍기는 사진을 올려보세요.';
  if (s.includes('흐') || s.includes('cloud')) return '부드러운 조명과 따뜻한 분위기로 매장의 편안함을 담아보세요.';
  return '오늘도 매장의 특별한 순간을 담아보세요!';
}

// 업종 카테고리 정규화 (다양한 업종 → 4개 카테고리)
function normalizeBizCategory(cat) {
  if (!cat) return 'other';
  const c = cat.toLowerCase();
  if (['cafe', 'bakery', 'dessert', 'juice'].includes(c)) return 'cafe';
  if (['restaurant', 'korean', 'chinese', 'japanese', 'western', 'fastfood', 'bar', 'chicken', 'food'].includes(c)) return 'food';
  if (['beauty', 'hair', 'nail', 'skincare', 'makeup', 'massage'].includes(c)) return 'beauty';
  return 'other';
}

exports.handler = async (event) => {
  // 스케줄 함수(Netlify 자동 실행) 또는 수동 호출 모두 허용
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
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_TOKEN
    });

    // 트렌드 기본값 (업종별)
    const defaultTrends = {
      cafe: '#카페 #오늘의커피 #카페스타그램 #라떼아트 #디저트',
      food: '#오늘뭐먹지 #맛스타그램 #맛집탐방 #점심메뉴 #저녁메뉴',
      beauty: '#뷰티스타그램 #오늘의네일 #헤어스타일 #피부관리 #셀카',
      other: '#일상 #소상공인 #오늘의사진 #인스타그램 #감성사진'
    };

    // 현재 날씨 (KMA API 직접 호출)
    let weatherStr = '맑음';
    let guideStr = getWeatherGuide('맑음');
    try {
      const weatherRes = await fetch(
        'https://lumi.it.kr/.netlify/functions/get-weather-kma?sido=%EC%84%9C%EC%9A%B8'
      );
      if (weatherRes.ok) {
        const w = await weatherRes.json();
        weatherStr = w.state || w.status || '맑음';
        guideStr = getWeatherGuide(weatherStr);
      }
    } catch(e) { console.log('날씨 조회 실패:', e.message); }

    // 프로 플랜 구독자 목록 가져오기
    const { blobs: userBlobs } = await userStore.list({ prefix: 'user:' });
    let sent = 0;
    let failed = 0;

    for (const blob of userBlobs) {
      try {
        const raw = await userStore.get(blob.key);
        if (!raw) continue;
        const user = JSON.parse(raw);

        // 유료 플랜(standard) 이상만 발송
        if (user.plan !== 'standard' && user.plan !== 'pro') continue;
        if (!user.phone) continue;

        // 구독 만료 체크
        if (user.subscriptionEnd && new Date(user.subscriptionEnd) < new Date()) continue;

        // 해당 고객 업종에 맞는 최적 시간 + 트렌드
        const normalizedCat = normalizeBizCategory(user.bizCategory);
        const bestTimeData = getTodayBestSlot(normalizedCat);
        const bestTimeStr = `오늘 최적 시간: ${bestTimeData.time} (${bestTimeData.reason})`;

        // 업종별 트렌드 가져오기
        let userTrendStr = defaultTrends[normalizedCat] || defaultTrends.other;
        try {
          const trendStore = getStore({ name: 'trends', consistency: 'strong', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_TOKEN });
          const trendRaw = await trendStore.get('trends:' + normalizedCat);
          if (trendRaw) {
            const parsed = JSON.parse(trendRaw);
            const tags = parsed.tags || parsed;
            if (Array.isArray(tags) && tags.length > 0) {
              userTrendStr = tags.slice(0, 5).join(' ');
            }
          }
        } catch(e) { /* 기본값 사용 */ }

        // 트렌드 태그는 사진 주제 추천용임을 가이드에 명시
        const trendGuide = `${guideStr} ${bestTimeStr} 위 인기태그를 주제로 사진을 찍어 올리면 더 많은 사람에게 노출돼요!`;

        const variables = {
          '#{이름}': user.name || user.storeName || '대표님',
          '#{날씨}': weatherStr,
          '#{트렌드}': userTrendStr,
          '#{가이드}': trendGuide
        };

        await sendAlimtalk(user.phone, variables);
        sent++;

        // 솔라피 API 과부하 방지
        await new Promise(r => setTimeout(r, 200));
      } catch(e) {
        console.error('발송 실패:', blob.key, e.message);
        failed++;
      }
    }

    console.log(`데일리 알림톡 완료: 성공 ${sent}건, 실패 ${failed}건`);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, sent, failed })
    };

  } catch (err) {
    console.error('send-daily-schedule error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
