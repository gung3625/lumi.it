// 업종별 인스타그램 최적 게시 시간 (고정 데이터 기반)
// 추후 메타 Graph API insights로 업그레이드 예정

const BEST_TIMES = {
  cafe: {
    slots: [
      { time: '07:30', reason: '출근 전 모닝커피 탐색 피크' },
      { time: '12:00', reason: '점심시간 카페 검색 집중' },
      { time: '19:30', reason: '퇴근 후 저녁 카페 탐방' }
    ],
    tip: '주말은 10시~12시가 가장 높아요.'
  },
  food: {
    slots: [
      { time: '11:00', reason: '점심 메뉴 탐색 시작' },
      { time: '17:30', reason: '저녁 식당 검색 피크' },
      { time: '20:00', reason: '야식 및 다음날 계획' }
    ],
    tip: '음식 사진은 밝은 낮 시간대 업로드가 반응이 좋아요.'
  },
  beauty: {
    slots: [
      { time: '11:00', reason: '오전 여유 시간 뷰티 탐색' },
      { time: '19:00', reason: '퇴근 후 예약 문의 집중' },
      { time: '21:00', reason: '밤 시간 뷰티 콘텐츠 소비 피크' }
    ],
    tip: '화요일~목요일 저녁 예약 문의가 가장 많아요.'
  },
  other: {
    slots: [
      { time: '09:00', reason: '오전 활동 시작 시간' },
      { time: '12:30', reason: '점심시간 SNS 탐색' },
      { time: '19:00', reason: '저녁 여가 시간' }
    ],
    tip: '꾸준한 업로드 주기가 알고리즘에 가장 유리해요.'
  }
};

// 오늘 요일 기반으로 가장 추천 시간 1개 반환
function getTodayBestSlot(category) {
  const data = BEST_TIMES[category] || BEST_TIMES.other;
  const day = new Date().getDay(); // 0=일, 1=월 ... 6=토

  let slotIndex = 0;
  // 주말은 두 번째 슬롯 (낮 시간대) 추천
  if (day === 0 || day === 6) slotIndex = 1;
  // 평일 저녁은 세 번째 슬롯
  else if (day >= 2 && day <= 4) slotIndex = 2;

  return {
    time: data.slots[slotIndex].time,
    reason: data.slots[slotIndex].reason,
    tip: data.tip,
    allSlots: data.slots
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: '잘못된 요청' }) };
  }

  const { category } = body;
  const cat = category || 'other';
  const result = getTodayBestSlot(cat);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category: cat,
      bestTime: result.time,
      reason: result.reason,
      tip: result.tip,
      allSlots: result.allSlots
    })
  };
};

// 다른 함수에서 직접 import해서 쓸 수 있도록 export
module.exports.getTodayBestSlot = getTodayBestSlot;
module.exports.BEST_TIMES = BEST_TIMES;
