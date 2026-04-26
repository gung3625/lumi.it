// 매일 아침 데일리 알림톡 — Supabase 기반 (Blobs 완전 제거)
// - public.users 에서 유료 플랜(standard/pro) + phone 보유자 조회
// - public.trends 에서 업종별 키워드 조회
// - 유저별 최적 시간 + 트렌드 안내를 Solapi 알림톡으로 발송
const crypto = require('crypto');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { getAdminClient } = require('./_shared/supabase-admin');
const { getSeedSlot } = require('./get-best-time');

const API_KEY = process.env.SOLAPI_API_KEY;
const API_SECRET = process.env.SOLAPI_API_SECRET;
const CHANNEL_ID = 'KA01PF26032219112677567W26lSNGQj';
const SCHEDULE_TEMPLATE_ID = 'KA01TP260322191942267zoXVvaI7xav';


function checkSecret(provided) {
  const secret = process.env.LUMI_SECRET;
  if (!secret) return false;
  try { return crypto.timingSafeEqual(Buffer.from(provided || ''), Buffer.from(secret)); }
  catch { return false; }
}

function getAuthHeader() {
  const date = new Date().toISOString();
  const salt = Math.random().toString(36).substring(2, 12);
  const signature = crypto
    .createHmac('sha256', API_SECRET)
    .update(date + salt)
    .digest('hex');
  return `HMAC-SHA256 apiKey=${API_KEY}, date=${date}, salt=${salt}, signature=${signature}`;
}

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

function getWeatherGuide(status) {
  if (!status) return '오늘도 매장의 특별한 순간을 담아보세요!';
  const s = status.toLowerCase();
  if (s.includes('맑') || s.includes('clear')) return '자연광을 최대한 활용해보세요. 채광 좋은 자리에서 찍은 사진이 반응이 좋아요.';
  if (s.includes('비') || s.includes('rain')) return '창가 조명을 활용해보세요. 빗소리와 함께하는 아늑한 무드 사진이 공감을 많이 받아요.';
  if (s.includes('눈') || s.includes('snow')) return '따뜻한 김이 모락모락 나는 메뉴 사진이 딱이에요. 겨울 감성 물씬 풍기는 사진을 올려보세요.';
  if (s.includes('흐') || s.includes('cloud')) return '부드러운 조명과 따뜻한 분위기로 매장의 편안함을 담아보세요.';
  return '오늘도 매장의 특별한 순간을 담아보세요!';
}

function normalizeBizCategory(cat) {
  if (!cat) return 'other';
  const c = cat.toLowerCase();
  if (['cafe', 'bakery', 'dessert', 'juice'].includes(c)) return 'cafe';
  if (['restaurant', 'korean', 'chinese', 'japanese', 'western', 'fastfood', 'bar', 'chicken', 'food'].includes(c)) return 'food';
  if (['beauty', 'hair', 'nail', 'skincare', 'makeup', 'massage'].includes(c)) return 'beauty';
  return 'other';
}

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  // 스케줄 함수(Netlify 자동 실행) 또는 수동 호출 모두 허용
  const isScheduled = !event.httpMethod && !event.headers;
  if (!isScheduled) {
    const secret = event.headers?.['x-lumi-secret'];
    if (!checkSecret(secret)) {
      return { statusCode: 401, headers: headers, body: JSON.stringify({ error: '인증 실패' }) };
    }
  }

  try {
    const supabase = getAdminClient();

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
    } catch (e) { console.log('날씨 조회 실패:', e.message); }

    // 유료 플랜 구독자 조회: plan in ('standard','pro') + phone NOT NULL
    const { data: users, error: userErr } = await supabase
      .from('users')
      .select('id, name, store_name, phone, biz_category, plan')
      .in('plan', ['standard', 'pro'])
      .not('phone', 'is', null);

    if (userErr) {
      console.error('[send-daily-schedule] users 조회 실패:', userErr.message);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '조회 실패' }) };
    }

    // 업종별 트렌드 캐시 로드 (한 번만)
    const trendCache = {};
    try {
      const { data: trendRows } = await supabase
        .from('trends')
        .select('category, keywords')
        .in('category', ['trends:cafe', 'trends:food', 'trends:beauty', 'trends:other']);
      if (trendRows) {
        for (const r of trendRows) {
          const cat = r.category.replace(/^trends:/, '');
          const keywords = r.keywords;
          const tags = Array.isArray(keywords) ? keywords : (keywords?.tags || keywords?.keywords);
          if (Array.isArray(tags) && tags.length > 0) {
            trendCache[cat] = tags.slice(0, 5).map(t => typeof t === 'string' ? t : (t.tag || t.keyword || '')).filter(Boolean).join(' ');
          }
        }
      }
    } catch (e) { console.log('트렌드 캐시 로드 실패:', e.message); }

    let sent = 0;
    let failed = 0;

    for (const user of (users || [])) {
      try {
        if (!user.phone) continue;

        const normalizedCat = normalizeBizCategory(user.biz_category);
        const bestTimeData = getSeedSlot(normalizedCat);
        const bestTimeStr = `오늘 최적 시간: ${bestTimeData.time} (${bestTimeData.reason})`;
        const userTrendStr = trendCache[normalizedCat] || defaultTrends[normalizedCat] || defaultTrends.other;

        const trendGuide = `${guideStr} ${bestTimeStr} 위 인기태그를 주제로 사진을 찍어 올리면 더 많은 사람에게 노출돼요!`;

        const variables = {
          '#{이름}': user.name || user.store_name || '대표님',
          '#{날씨}': weatherStr,
          '#{트렌드}': userTrendStr,
          '#{가이드}': trendGuide
        };

        await sendAlimtalk(user.phone, variables);
        sent++;

        // 솔라피 API 과부하 방지
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        console.error('발송 실패:', user.id, e.message);
        failed++;
      }
    }

    console.log(`데일리 알림톡 완료: 성공 ${sent}건, 실패 ${failed}건`);
    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ success: true, sent, failed })
    };

  } catch (err) {
    console.error('send-daily-schedule error:', err.message);
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '처리 중 오류가 발생했습니다.' }) };
  }
};
