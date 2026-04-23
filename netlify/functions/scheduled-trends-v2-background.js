// scheduled-trends-v2-background.js — Trend Hub v2 Phase 1
// Lumi 지원 업종 (9개): cafe, food, beauty, hair, nail, flower, fashion, fitness, pet
// 제거됨: education, interior, studio (2026-04-23, 소상공인 인스타 SaaS 타깃 불일치)
// 변경 사항 (v1 대비):
//   - gpt-4o 전환 (분류·예측·스토리 전부), 전처리만 mini 폴백 가능
//   - 크로스 소스 검증: 2+ 소스 → signal_tier='real', 1소스 → 'weak'
//   - Velocity 스코어링: 전 주 대비 mention 증가율 (%)
//   - 소스별 가중치: datalab=3 / blog=1 / youtube=2 / ig=2 / google=1
//   - 신조어 감지: 지난 90일 trend_keywords에 없던 키워드 → is_new=true
//   - 레거시 키 6종 그대로 유지 (프론트 호환)
//   - runGuarded + heartbeat 키 'scheduled-trends' 그대로
//   - 카나리 전략: TREND_V2_CANARY_CATS env ('all' or comma-separated)

const { getAdminClient } = require('./_shared/supabase-admin');
const { runGuarded } = require('./_shared/cron-guard');
const https = require('https');

// ─────────────────────────────────────────────
// Phase 2: 4축 분할 대상 카테고리
// ─────────────────────────────────────────────
const AXIS_CATEGORIES = ['cafe', 'food', 'flower', 'fashion', 'pet'];

// ─────────────────────────────────────────────
// 소스 가중치
// ─────────────────────────────────────────────
const SOURCE_WEIGHTS = {
  datalab: 3,
  blog: 1,
  youtube: 2,
  ig: 2,
  google: 1,
};

// ─────────────────────────────────────────────
// 필터
// ─────────────────────────────────────────────
const BLACKLIST = [
  '맛집', '핫플레이스', '브런치', '카페', '맛집추천', '카페추천',
  '뷰티', '네일', '헤어', '피부관리', '다이어트', '화장품',
  '인스타', '인스타그램', '팔로우', '좋아요',
  '일상', '데일리', '오늘', '주말',
  '서울', '강남', '홍대', '이태원', '성수',
  '맛있는', '예쁜', '좋은', '추천', '인기',
  '소통', '선팔', '맞팔', '팔로워',
  '먹스타그램', '카페스타그램', '맛스타그램', '뷰티스타그램', '일상스타그램',
  '푸드', '디저트', '음식', '요리',
  '패션', '코디', '스타일', '옷',
  '운동', '헬스', '피트니스',
  '반려동물', '강아지', '고양이',
  '꽃', '플라워', '꽃집',
  '동네맛집', '밀면맛집', '소자본창업', '뷰티샵창업', '이벤트', '체험이벤트',
  '중앙일보', '조선일보', '동아일보', '한겨레', '경향신문', '매일경제', '한국경제',
  '푸드투데이', '뉴시스', '연합뉴스', '노컷뉴스', '머니투데이', '헤럴드경제',
  '코스모폴리탄', '보그', '얼루어', '하퍼스바자', '마리끌레르',
  'jtbc', 'kbs', 'sbs', 'mbc', 'tvn',
  '스타벅스', '이디야커피', '이디야', '투썸플레이스', '투썸', '메가커피', '컴포즈커피',
  '빽다방', '할리스', '엔제리너스', '폴바셋', '블루보틀', '파스쿠찌',
  'coffee', 'cafe', 'desserts', 'dessert', 'menu', 'food', 'world', 'new', 'best',
  'love', 'like', 'good', 'free', 'sale', 'shop', 'store', 'day', 'time', 'news',
];

const FILLER_WORDS = [
  '아이디어', '방법', '추천', '정보', '모음', '리스트', '팁', '가이드',
  '비교', '순위', '종류', '차이', '후기', '리뷰', '장단점', '선택',
  '입문', '초보', '기초', '필수', '인기', '베스트', '총정리',
  '유행하는', '유행중', '트렌드는', '트렌드가', '트렌드의', '뜨는', '떠오르는',
  '화제', '화제의', '주목', '주목받는', '밝혀', '밝혔다', '공개',
  '라고', '이라고', '이라는', '라는', '했다', '이다', '된다',
  '관계자', '업계', '전문가', '시민', '네티즌',
];

function isBadKeyword(raw) {
  const kw = (raw || '').replace(/^#/, '').trim().toLowerCase();
  if (!kw) return true;
  if (kw.length < 2 || kw.length > 25) return true;
  if (BLACKLIST.includes(kw)) return true;
  if (FILLER_WORDS.some(fw => kw.includes(fw))) return true;
  if ((kw.match(/\s/g) || []).length >= 2) return true;
  if (/[?!,.]/.test(kw)) return true;
  return false;
}

function normalize(raw) {
  return (raw || '').replace(/^#/, '').replace(/\s+/g, '').trim();
}

// ─────────────────────────────────────────────
// Fallback 기본값
// ─────────────────────────────────────────────
const DEFAULT_TRENDS = {
  cafe: ['말차라떼', '크로플', '핸드드립', '시즌음료', '디저트플레이팅', '에스프레소바', '바닐라라떼', '케이크'],
  food: ['오마카세', '파스타', '한식주점', '수제버거', '베이글', '스몰디쉬', '구이전문점', '와인바'],
  beauty: ['글로우메이크업', '립틴트', '속눈썹펌', '피부장벽크림', '비건쿠션', '선크림', '아이섀도팔레트', '클렌징밤'],
  nail: ['젤네일', '큐빅네일', '오로라네일', '글리터젤', '봄컬러네일', '프렌치네일', '플라워네일아트', '그라데이션네일'],
  hair: ['볼륨펌', '뿌리염색', '레이어드컷', '두피스케일링', '매직스트레이트', '컬링아이롱', '앞머리펌', '단발컷'],
  flower: ['수국드라이플라워', '팜파스그라스', '유칼립투스리스', '목화솜부케', '라넌큘러스', '프리지어', '샴페인장미', '버드나무가지'],
  fashion: ['오버핏블레이저', 'Y2K패션', '셔츠워머', '롱스커트', '와이드팬츠', '카라니트', '청재킷', '레이어드룩'],
  fitness: ['크로스핏박스', '필라테스리포머', '맨몸운동루틴', '짐복합운동', '케틀벨스윙', '힙쓰러스트', '폼롤러스트레칭', '요가플로우'],
  pet: ['생식사료', '수제간식', '강아지유산균', '고양이캣타워', '반려견수영', '펫보험', '노즈워크', '슬링백'],
};

// ─────────────────────────────────────────────
// 계절 헬퍼
// ─────────────────────────────────────────────
function getCurrentSeason() {
  const month = new Date().getMonth() + 1;
  if (month >= 3 && month <= 5) return '봄';
  if (month >= 6 && month <= 8) return '여름';
  if (month >= 9 && month <= 11) return '가을';
  return '겨울';
}

function expandBlogSeedsWithSeason(baseSeeds, seasonalKeywords) {
  const season = getCurrentSeason();
  const expanded = [...baseSeeds];
  for (const kw of seasonalKeywords) {
    expanded.push(`${season} ${kw}`);
  }
  return expanded;
}

// ─────────────────────────────────────────────
// 업종별 시드
// ─────────────────────────────────────────────
const NAVER_KEYWORDS = {
  cafe: [
    { groupName: '신상카페음료', keywords: ['신상카페', '요즘카페', '핫한카페'] },
    { groupName: '디저트', keywords: ['시그니처디저트', '신상디저트', '카페디저트'] },
    { groupName: '음료신메뉴', keywords: ['신메뉴음료', '시그니처음료', '한정음료'] },
    { groupName: '베이커리', keywords: ['신상베이커리', '빵집추천', '소금빵'] },
    { groupName: '컨셉카페', keywords: ['컨셉카페', '감성카페', '루프탑카페'] },
    { groupName: '스페셜티', keywords: ['스페셜티커피', '핸드드립커피', '싱글오리진'] }
  ],
  food: [
    { groupName: '요즘맛집', keywords: ['신상맛집', '요즘뜨는맛집', '핫한식당'] },
    { groupName: '혼밥브런치', keywords: ['혼밥메뉴', '브런치메뉴', '점심메뉴추천'] },
    { groupName: '데이트회식', keywords: ['데이트맛집', '회식장소', '저녁맛집'] },
    { groupName: '요리트렌드', keywords: ['오마카세', '수제버거', '마라탕'] },
    { groupName: '주류안주', keywords: ['와인바안주', '한식주점메뉴', '이자카야'] },
    { groupName: '연령별맛집', keywords: ['20대맛집', '30대맛집', '가족외식'] }
  ],
  beauty: [
    { groupName: '남자스킨케어', keywords: ['남자스킨케어', '남자피부관리', '남자기초화장품'] },
    { groupName: '여자스킨케어', keywords: ['여자스킨케어', '피부장벽케어', '수분크림추천'] },
    { groupName: '메이크업트렌드', keywords: ['요즘메이크업', '신상파운데이션', '립트렌드'] },
    { groupName: '선케어', keywords: ['선크림추천', '자외선차단제', '선스틱'] },
    { groupName: '안티에이징', keywords: ['30대피부관리', '40대안티에이징', '탄력크림'] },
    { groupName: '클렌징', keywords: ['클렌징밤', '저자극클렌저', '이중세안'] }
  ],
  hair: [
    { groupName: '남자헤어', keywords: ['남자머리', '남자커트', '남자헤어스타일'] },
    { groupName: '여자헤어', keywords: ['여자머리', '여자컷추천', '여자헤어스타일'] },
    { groupName: '남자염색', keywords: ['남자염색', '남자컬러링', '남자탈색'] },
    { groupName: '여자염색', keywords: ['여자염색', '여자컬러추천', '발레아쥬'] },
    { groupName: '펌종류', keywords: ['볼륨펌', '매직스트레이트', '디지털펌'] },
    { groupName: '두피케어', keywords: ['두피스케일링', '탈모케어', '헤어클리닉'] }
  ],
  nail: [
    { groupName: '젤네일디자인', keywords: ['젤네일디자인', '요즘네일', '핫한네일'] },
    { groupName: '네일아트', keywords: ['플라워네일아트', '오로라네일', '큐빅네일'] },
    { groupName: '컬러네일', keywords: ['누드네일', '글리터젤', '프렌치네일'] },
    { groupName: '네일케어', keywords: ['페디큐어', '손발관리', '큐티클케어'] },
    { groupName: '이벤트네일', keywords: ['웨딩네일', '파티네일', '기념일네일'] }
  ],
  flower: [
    { groupName: '꽃다발부케', keywords: ['꽃다발추천', '웨딩부케', '생일꽃다발'] },
    { groupName: '드라이플라워', keywords: ['드라이플라워리스', '팜파스그라스', '유칼립투스'] },
    { groupName: '이벤트꽃', keywords: ['어버이날꽃', '졸업식꽃다발', '발렌타인꽃'] },
    { groupName: '플라워클래스', keywords: ['플라워원데이클래스', '꽃꽂이수업', '화환제작'] },
    { groupName: '계절꽃', keywords: ['수국', '라넌큘러스', '프리지어'] }
  ],
  fashion: [
    { groupName: '여성패션트렌드', keywords: ['요즘여자옷', '여성트렌드룩', '신상원피스'] },
    { groupName: '남성패션트렌드', keywords: ['요즘남자옷', '남성트렌드룩', '남자코디추천'] },
    { groupName: '20대패션', keywords: ['20대여자코디', '20대남자코디', '대학생패션'] },
    { groupName: '30대패션', keywords: ['30대여자코디', '30대직장인룩', '미니멀패션'] },
    { groupName: '아이템트렌드', keywords: ['오버핏블레이저', '와이드팬츠', '롱스커트'] },
    { groupName: '스타일분류', keywords: ['스트릿패션', '오피스룩', '빈티지스타일'] }
  ],
  fitness: [
    { groupName: '여성필라테스', keywords: ['필라테스추천', '기구필라테스', '리포머운동'] },
    { groupName: '남성헬스', keywords: ['헬스루틴', '근력운동', '바디프로필준비'] },
    { groupName: '홈트운동', keywords: ['홈트레이닝', '맨몸운동루틴', '요가플로우'] },
    { groupName: '목적별운동', keywords: ['다이어트운동', '체형교정', '코어강화'] },
    { groupName: '그룹운동', keywords: ['크로스핏', '스피닝클래스', '댄스피트니스'] }
  ],
  pet: [
    { groupName: '강아지용품', keywords: ['강아지사료추천', '강아지간식', '강아지장난감'] },
    { groupName: '고양이용품', keywords: ['고양이사료', '캣타워추천', '고양이장난감'] },
    { groupName: '반려동물건강', keywords: ['펫보험', '강아지건강검진', '고양이영양제'] },
    { groupName: '반려동물미용', keywords: ['강아지미용', '반려견스타일', '펫그루밍'] },
    { groupName: '펫서비스', keywords: ['펫호텔', '반려견유치원', '도그카페'] }
  ],
};

const BLOG_SEARCH_SEEDS_BASE = {
  cafe: [
    '신상 카페 추천', '요즘 뜨는 카페',
    '시그니처 디저트 카페', '신메뉴 음료 추천',
    '스페셜티 핸드드립 카페', '소금빵 베이커리',
    '컨셉 카페 추천', '감성 카페 인테리어',
    '루프탑 카페', '비건 베이커리',
    '한정 음료 신메뉴', '카페 시그니처 메뉴',
    '크로플 카페', '말차 디저트 카페',
    '브런치 카페 추천', '케이크 맛집 카페',
  ],
  food: [
    '신상 맛집 추천', '요즘 뜨는 맛집',
    '혼밥 메뉴 추천', '브런치 메뉴 추천',
    '점심 맛집 추천', '저녁 데이트 맛집',
    '20대 맛집', '30대 회식 장소',
    '오마카세 추천', '수제버거 맛집',
    '와인바 안주 메뉴', '한식주점 메뉴',
    '신상 음식 트렌드', '마라탕 맛집',
    '이자카야 안주 추천', '가성비 맛집',
    '혼술 안주 추천', '요즘 핫한 음식',
    '파스타 맛집', '오늘뭐먹지 추천',
  ],
  beauty: [
    '남자 스킨케어 추천', '여자 스킨케어 루틴',
    '남자 기초 화장품', '여자 수분크림 추천',
    '20대 피부 관리', '30대 안티에이징 관리',
    '피부 장벽 크림 추천', '선크림 추천',
    '요즘 메이크업 트렌드', '신상 파운데이션',
    '립 메이크업 트렌드', '클렌징밤 추천',
    '비건 화장품', '저자극 스킨케어',
    '속눈썹펌 후기', '왁싱 관리 추천',
    '남자 피부과 시술', '여자 피부과 추천',
    '토너 패드 추천', '40대 피부 관리',
  ],
  hair: [
    '남자 머리스타일 추천', '여자 머리스타일 트렌드',
    '남자 염색 컬러 추천', '여자 염색 추천',
    '20대 헤어스타일', '30대 헤어 추천',
    '볼륨펌 후기', '매직스트레이트 관리',
    '단발 추천 스타일', '장발 스타일링',
    '얼굴형별 헤어 추천', '탈모 커버 스타일',
    '요즘 뜨는 헤어 트렌드', '미용실 추천 시술',
    '남자 투블록 스타일', '여자 레이어드컷',
    '두피 스케일링 후기', '발레아쥬 염색',
  ],
  nail: [
    '요즘 네일 트렌드', '젤네일 디자인 추천',
    '플라워 네일아트', '오로라 네일 디자인',
    '누드네일 오피스룩', '글리터 젤 파티네일',
    '큐빅 네일 추천', '프렌치네일 스타일',
    '페디큐어 관리법', '셀프 네일 팁',
    '웨딩 네일 추천', '네일 유지 기간',
    '그라데이션 네일', '네일아트 디자인 모음',
    '남자 네일 케어', '젤 제거 방법',
  ],
  flower: [
    '꽃다발 추천', '생일 꽃다발',
    '웨딩 부케 추천', '드라이플라워 리스 만들기',
    '팜파스 그라스 인테리어', '유칼립투스 화환',
    '어버이날 꽃 추천', '졸업식 꽃다발',
    '플라워 원데이클래스', '꽃꽂이 수업 후기',
    '수국 꽃다발', '라넌큘러스 꽃집',
    '드라이플라워 인테리어', '꽃 선물 추천',
    '반려식물 인테리어', '꽃집 추천',
  ],
  fashion: [
    '요즘 여자 옷 추천', '요즘 남자 옷 추천',
    '20대 여자 코디', '20대 남자 코디',
    '30대 여자 패션', '30대 직장인 룩',
    '오버핏 블레이저 코디', '와이드 팬츠 스타일',
    '롱스커트 코디 추천', '미니멀 패션',
    '스트릿 패션 코디', '오피스 룩 추천',
    '빈티지 스타일 코디', '캐주얼 데일리룩',
    '신상 아이템 추천', '요즘 핫한 브랜드',
    '레이어드 코디', '패션 트렌드 핫템',
  ],
  fitness: [
    '필라테스 추천', '리포머 필라테스 후기',
    '여성 홈트레이닝 루틴', '남성 헬스 운동 루틴',
    '바디프로필 준비 식단', '다이어트 운동 추천',
    '케틀벨 스윙 루틴', '맨몸운동 홈트',
    '코어 강화 운동', '체형 교정 스트레칭',
    '크로스핏 입문', '스피닝 클래스 후기',
    '요가 플로우 자세', 'PT 트레이닝 추천',
    '그룹 운동 추천', '복근 운동 루틴',
    '기구 필라테스 입문', '댄스 피트니스',
  ],
  pet: [
    '강아지 사료 추천', '고양이 사료 추천',
    '강아지 간식 브랜드', '고양이 간식 추천',
    '반려견 노즈워크 매트', '캣타워 추천',
    '펫 보험 추천', '강아지 건강 관리',
    '고양이 영양제 추천', '반려견 미용 스타일',
    '강아지 수제간식 만들기', '펫 호텔 후기',
    '반려동물 용품 추천', '강아지 훈련법',
    '고양이 행동 이해', '반려견 산책 용품',
    '이색 반려동물 키우기', '펫 브이로그',
  ],
};

// 계절 동적 확장 시드 (업종별 계절 키워드)
const SEASONAL_EXTENSIONS = {
  cafe: ['카페 음료', '디저트', '카페 메뉴'],
  food: ['메뉴', '음식', '맛집'],
  beauty: ['피부 관리', '메이크업'],
  hair: ['헤어 스타일', '헤어 컬러'],
  nail: ['네일 디자인', '네일 컬러'],
  flower: ['꽃다발', '플라워 인테리어'],
  fashion: ['코디', '패션 아이템'],
  fitness: ['운동', '다이어트'],
  pet: ['반려동물 용품'],
};

const BLOG_SEARCH_SEEDS = Object.fromEntries(
  Object.entries(BLOG_SEARCH_SEEDS_BASE).map(([cat, seeds]) => [
    cat,
    expandBlogSeedsWithSeason(seeds, SEASONAL_EXTENSIONS[cat] || [])
  ])
);

const YOUTUBE_SEEDS_KR = {
  cafe: [
    '카페 신메뉴 리뷰', '디저트 카페 브이로그',
    '신상 카페 투어', '스페셜티 커피 리뷰',
    '베이커리 카페 먹방', '컨셉 카페 소개',
    '카페 브이로그', '시그니처 음료 리뷰',
  ],
  food: [
    '맛집 브이로그', '오마카세 리뷰',
    '신상 맛집 먹방', '혼밥 메뉴 추천',
    '요즘 뜨는 음식 트렌드', '데이트 맛집 추천',
    '수제버거 리뷰', '한식주점 안주 먹방',
  ],
  beauty: [
    '남자 스킨케어 루틴', '여자 스킨케어 리뷰',
    '요즘 메이크업 튜토리얼', '신상 화장품 리뷰',
    '피부과 시술 후기', '선크림 추천 리뷰',
    '뷰티 하울', '기초 스킨케어 추천',
  ],
  hair: [
    '남자 헤어 스타일링 튜토리얼', '여자 헤어 스타일링',
    '염색 시술 후기', '펌 시술 과정',
    '홈케어 헤어 팁', '미용실 시술 리뷰',
    '헤어 트렌드', '두피 케어 방법',
    '남자 셀프 커트', '발레아쥬 염색 후기',
  ],
  nail: [
    '요즘 네일 트렌드', '셀프 네일 튜토리얼',
    '네일샵 시술 후기', '젤네일 디자인 모음',
    '오로라 네일 만들기', '네일아트 강좌',
    '웨딩 네일 추천', '페디큐어 관리 팁',
  ],
  flower: [
    '플라워 원데이클래스 브이로그', '드라이플라워 리스 만들기',
    '꽃다발 만들기 튜토리얼', '웨딩 부케 제작',
    '꽃집 창업 브이로그', '플라워 인테리어 DIY',
    '계절 꽃 소개', '꽃꽂이 기초 강좌',
  ],
  fashion: [
    '요즘 여자 코디 브이로그', '요즘 남자 코디',
    '신상 패션 하울', '스타일링 팁 영상',
    '오버핏 코디 추천', '계절 패션 아이템',
    '빈티지 패션 하울', '오피스룩 코디',
  ],
  fitness: [
    '필라테스 리포머 운동 영상', '크로스핏 홈트 브이로그',
    '바디프로필 준비 식단', '맨몸운동 루틴',
    '여성 홈트 루틴', '남성 헬스 루틴',
    '다이어트 운동 영상', '요가 플로우 튜토리얼',
  ],
  pet: [
    '강아지 일상 브이로그', '고양이 일상 영상',
    '반려견 수제간식 만들기', '고양이 용품 리뷰',
    '강아지 훈련 방법', '펫 호텔 후기',
    '반려동물 미용 브이로그', '이색 반려동물 소개',
  ],
};

const CATEGORY_KO = {
  cafe: '카페/베이커리',
  food: '음식점/맛집',
  beauty: '뷰티/헤어/네일',
  nail: '네일',
  hair: '헤어',
  flower: '꽃집/플라워샵',
  fashion: '패션/의류',
  fitness: '피트니스/헬스',
  pet: '반려동물',
};

// ─────────────────────────────────────────────
// HTTP 헬퍼
// ─────────────────────────────────────────────
function httpsPost(hostname, path, headers, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname, path, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: responseData }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function httpsGetRaw(urlOrOptions, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlOrOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
  });
}

function httpsGet(url, timeoutMs = 10000) {
  return httpsGetRaw(url, timeoutMs);
}

function httpsGetWithHeaders(hostname, path, headers, timeoutMs = 10000) {
  return httpsGetRaw({ hostname, path, method: 'GET', headers }, timeoutMs);
}

// ─────────────────────────────────────────────
// 소스 수집 함수 (v1과 동일)
// ─────────────────────────────────────────────
async function fetchNaverDatalab(category) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return [];

  const today = new Date();
  const endDate = today.toISOString().slice(0, 10);
  const startDate = new Date(today - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const keywordGroups = NAVER_KEYWORDS[category] || NAVER_KEYWORDS.cafe;

  try {
    const result = await httpsPost(
      'openapi.naver.com',
      '/v1/datalab/search',
      {
        'Content-Type': 'application/json',
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret
      },
      { startDate, endDate, timeUnit: 'week', keywordGroups, device: 'mo', ages: ['2', '3', '4', '5'], gender: 'f' }
    );
    if (result.status !== 200) return [];
    const data = JSON.parse(result.body);
    if (!data.results || data.results.length === 0) return [];
    const sorted = data.results.sort((a, b) => {
      const aAvg = a.data.reduce((s, d) => s + d.ratio, 0) / a.data.length;
      const bAvg = b.data.reduce((s, d) => s + d.ratio, 0) / b.data.length;
      return bAvg - aAvg;
    });
    const titleToKeywords = new Map(
      (keywordGroups || []).map(g => [g.groupName, g.keywords || []])
    );
    const ordered = [];
    for (const g of sorted) {
      const kws = titleToKeywords.get(g.title) || [];
      for (const kw of kws) if (kw) ordered.push(kw);
    }
    return ordered;
  } catch(e) {
    console.error('[naver-datalab]', category, 'error:', e.message);
    return [];
  }
}

async function fetchNaverBlogs(category) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return [];

  const seeds = BLOG_SEARCH_SEEDS[category] || BLOG_SEARCH_SEEDS.cafe;
  const texts = [];
  for (const query of seeds) {
    try {
      const path = `/v1/search/blog.json?query=${encodeURIComponent(query)}&display=15&sort=date`;
      const result = await httpsGetWithHeaders(
        'openapi.naver.com',
        path,
        { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret },
        10000
      );
      if (result.status !== 200) continue;
      const data = JSON.parse(result.body);
      if (!data.items) continue;
      for (const item of data.items) {
        const title = (item.title || '').replace(/<[^>]+>/g, '').trim();
        const desc = (item.description || '').replace(/<[^>]+>/g, '').trim();
        if (title) texts.push(title);
        if (desc) texts.push(desc.slice(0, 120));
      }
      await new Promise(r => setTimeout(r, 200));
    } catch(e) {
      console.error('[naver-blog]', category, query, 'error:', e.message);
    }
  }
  return texts;
}

async function fetchGoogleTrendsLib(geo) {
  try {
    const googleTrends = require('google-trends-api');
    const raw = await Promise.race([
      googleTrends.dailyTrends({ trendDate: new Date(), geo }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
    ]);
    const parsed = JSON.parse(raw);
    const days = parsed?.default?.trendingSearchesDays || [];
    const titles = [];
    for (const day of days) {
      for (const ts of (day.trendingSearches || [])) {
        const t = ts?.title?.query;
        if (t) titles.push(t);
        for (const rel of (ts.relatedQueries || [])) {
          if (rel?.query) titles.push(rel.query);
        }
      }
    }
    return titles.slice(0, 40);
  } catch(e) {
    console.error(`[google-${geo}] lib 실패, RSS fallback:`, e.message);
    return fetchGoogleRSS(geo);
  }
}

async function fetchGoogleRSS(geo) {
  try {
    const url = `https://trends.google.com/trends/trendingsearches/daily/rss?geo=${geo}`;
    const result = await httpsGet(url);
    if (result.status !== 200) return [];
    const titles = [];
    const matches = result.body.matchAll(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/g);
    for (const match of matches) {
      const title = match[1].trim();
      if (title && title !== 'Google Trends' && titles.length < 40) {
        titles.push(title);
      }
    }
    return titles;
  } catch(e) {
    console.error(`[google-rss-${geo}]`, e.message);
    return [];
  }
}

async function fetchYouTube(category) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return [];

  const seeds = YOUTUBE_SEEDS_KR[category] || YOUTUBE_SEEDS_KR.cafe;
  const titles = [];

  for (const query of seeds) {
    try {
      const searchPath = `/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=10` +
        `&regionCode=KR` +
        `&publishedAfter=${encodeURIComponent(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())}` +
        `&q=${encodeURIComponent(query)}` +
        `&key=${apiKey}`;
      const result = await httpsGetRaw({
        hostname: 'www.googleapis.com',
        path: searchPath,
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      }, 10000);
      if (result.status !== 200) {
        console.error('[youtube] search status:', result.status, category, query);
        continue;
      }
      const data = JSON.parse(result.body);
      for (const item of (data.items || [])) {
        const title = item?.snippet?.title;
        if (title) titles.push(title);
      }
      await new Promise(r => setTimeout(r, 200));
    } catch(e) {
      console.error('[youtube]', category, query, 'error:', e.message);
    }
  }
  return titles;
}

async function fetchInstagram(supa, category) {
  try {
    const { data, error } = await supa
      .from('trends')
      .select('keywords, collected_at')
      .eq('category', `ig-hashtag-cache:${category}`)
      .maybeSingle();
    if (error || !data || !data.keywords) return [];
    const captions = Array.isArray(data.keywords.captions) ? data.keywords.captions : [];
    return captions;
  } catch (e) {
    console.error('[instagram-cache]', category, 'skip:', e.message);
    return [];
  }
}

// ─────────────────────────────────────────────
// GPT 호출 헬퍼 (gpt-4o 우선, 실패 시 gpt-4o-mini 폴백)
// ─────────────────────────────────────────────
async function callGPT({ prompt, maxTokens = 1200, temperature = 0.2, preferMini = false }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const models = preferMini
    ? ['gpt-4o-mini']
    : ['gpt-4o', 'gpt-4o-mini'];

  for (const model of models) {
    try {
      const result = await httpsPost(
        'api.openai.com',
        '/v1/responses',
        {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        {
          model,
          input: prompt,
          temperature,
          max_output_tokens: maxTokens,
          store: false,
        },
        45000
      );

      if (result.status !== 200) {
        console.error(`[gpt] ${model} status:`, result.status);
        continue;
      }

      const data = JSON.parse(result.body);
      let content = (data.output_text || '').trim();
      if (!content && Array.isArray(data.output)) {
        for (const item of data.output) {
          for (const part of (item?.content || [])) {
            if (part?.text) content += part.text;
          }
        }
        content = content.trim();
      }

      if (content) {
        console.log(`[gpt] ${model} 호출 성공`);
        return content;
      }
    } catch(e) {
      console.error(`[gpt] ${model} 실패:`, e.message);
    }
  }

  return null;
}

// ─────────────────────────────────────────────
// Phase 2: 4축 분할 (6 제품 중심 카테고리)
// ─────────────────────────────────────────────
const AXIS_EXAMPLES = {
  cafe: {
    menu: '말차라떼, 크로플, 시즌음료',
    interior: '원목테이블, 빈티지체어, 무드조명',
    goods: '로고텀블러, 에코백, 키링',
    experience: '팝업스토어, 브루잉클래스, 원데이클래스',
  },
  food: {
    menu: '흑임자파스타, 수제버거, 코스요리',
    interior: '오픈키친, 한옥인테리어, 테라스석',
    goods: '밀키트, 소스패키지, 굿즈',
    experience: '셰프테이블, 쿠킹클래스, 런치세트',
  },
  flower: {
    menu: '수국부케, 라넌큘러스, 팜파스',
    interior: '오브제조화, 드라이플라워벽장식, 테이블화병',
    goods: '리스, 화분, 플라워박스',
    experience: '플라워클래스, 원데이부케, 웨딩부케',
  },
  fashion: {
    menu: '오버핏블레이저, 롱스커트, 레이어드룩',
    interior: '피팅룸인테리어, 행거디스플레이, 쇼룸',
    goods: '에코백, 폰케이스, 모자',
    experience: '스타일링상담, 팝업스토어, 트렁크쇼',
  },
  pet: {
    menu: '생식사료, 수제간식, 유산균',
    interior: '캣타워, 펫침대, 노즈워크매트',
    goods: '하네스, 리드줄, 장난감',
    experience: '반려견수영장, 펫호텔, 펫카페',
  },
  interior: {
    menu: '디퓨저향, 캔들, 방향제',
    interior: '원목선반, 버티컬블라인드, 패브릭포스터',
    goods: '미니화분, 빈티지소품, 테이블조명',
    experience: '셀프인테리어클래스, 가구배치상담, 컬러컨설팅',
  },
};

async function splitKeywordsByAxis(keywords, category) {
  if (!keywords || keywords.length === 0) return null;

  const examples = AXIS_EXAMPLES[category] || {};
  const exampleStr = Object.entries(examples)
    .map(([axis, ex]) => `- ${axis}: ${ex}`)
    .join('\n');

  const prompt = `다음은 "${CATEGORY_KO[category] || category}" 업종의 트렌드 키워드 목록입니다.
각 키워드를 아래 4개 축 중 가장 적합한 하나로 분류해 JSON으로 반환하세요.

축 정의:
- menu: 먹는/마시는 제품, 메뉴, 식재료
- interior: 공간 집기, 가구, 소품, 인테리어 요소
- goods: 텀블러, 키링, 굿즈 등 판매 상품
- experience: 컨셉, 이벤트, 클래스, 팝업 등 체험

업종별 예시:
${exampleStr}

키워드 목록: ${keywords.join(', ')}

규칙:
- 애매한 키워드는 menu에 배정
- 각 키워드는 반드시 하나의 축에만 배정
- 출력: JSON 객체만 ({"menu":["..."],"interior":["..."],"goods":["..."],"experience":["..."]})`;

  try {
    const content = await callGPT({ prompt, maxTokens: 600, temperature: 0.1 });
    if (!content) return null;
    const clean = content.replace(/```json|```/g, '').trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    // validate: all 4 axes present as arrays
    const axes = ['menu', 'interior', 'goods', 'experience'];
    for (const ax of axes) {
      if (!Array.isArray(parsed[ax])) parsed[ax] = [];
    }
    return parsed;
  } catch(e) {
    console.error('[axis-split]', category, '실패:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// Phase 2: narrative + origin 통합 GPT-4o 호출
// 모든 키워드 배치 처리 (signal_tier 무관 — 최상위 품질)
// ─────────────────────────────────────────────

// 순수 GPT 호출 함수 — 키워드 목록 → {keyword: {narrative, origin}} 맵 반환
async function callGPTNarrative({ keywords, category, rawTexts }) {
  const contextSnippet = (rawTexts || []).slice(0, 30).join(' | ').slice(0, 2000);
  const keywordList = keywords.map(k => k.keyword);

  const prompt = `당신은 한국 소상공인 인스타그램 트렌드 분석 전문가입니다.
아래 원시 텍스트를 참고해, 각 키워드가 "왜 지금 뜨는가"를 분석하세요.

[수집된 원시 텍스트 (일부)]
${contextSnippet || '없음'}

[분석 대상 키워드]
${keywordList.join(', ')}

각 키워드에 대해 다음을 JSON 배열로 반환하세요:
- keyword: 분석 대상 키워드 (원본 그대로)
- narrative: 왜 뜨는가 3-4줄 한국어 설명 (셀럽/드라마/뉴스 언급 시 출처 명시). 근거 없으면 null
- origin: {
    "firstSeenAt": "YYYY-MM-DD 또는 null",
    "sourceType": "drama|celebrity|news|product|social|null",
    "sourceRef": "구체적 출처 (있는 경우만, 없으면 null)",
    "mediaTitle": "매체명 (있는 경우만, 없으면 null)"
  }

규칙:
- narrative: 추측 아닌 텍스트 근거 기반. 근거 부족 시 null
- origin.firstSeenAt: 텍스트에 날짜 근거 없으면 null (추측 금지)
- origin.sourceType: 명확하지 않으면 null
- 출력: JSON 배열만, 마크다운 없음

예시:
[{"keyword":"말차라떼","narrative":"말차 열풍이 카페 업계 전반으로 확산되며...","origin":{"firstSeenAt":null,"sourceType":"social","sourceRef":null,"mediaTitle":null}}]`;

  const content = await callGPT({ prompt, maxTokens: 1800, temperature: 0.2 });
  if (!content) return {};

  const clean = content.replace(/```json|```/g, '').trim();
  const match = clean.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`JSON 배열 없음 (raw: ${content.slice(0, 200)})`);

  let items;
  try { items = JSON.parse(match[0]); } catch(e) { throw new Error(`JSON 파싱 실패: ${e.message} (raw: ${match[0].slice(0, 200)})`); }
  if (!Array.isArray(items)) throw new Error('응답이 배열 아님');

  const result = {};
  for (const item of items) {
    if (!item || !item.keyword) continue;
    result[item.keyword] = {
      narrative: item.narrative || null,
      origin: item.origin || null,
    };
  }
  return result;
}

async function generateNarrativeAndOriginBatch({ keywords, category, rawTexts }) {
  // keywords: [{keyword, signalTier, ...}, ...]
  // rawTexts: 해당 카테고리 원시 텍스트 배열 (blogData + ytKR + igTexts 등)
  if (!keywords || keywords.length === 0) return {};

  try {
    // 1차: 배치 호출
    const result = await callGPTNarrative({ keywords, category, rawTexts });

    // 실패한 키워드 확인
    const missing = keywords.filter(k => !result[k.keyword] || !result[k.keyword].narrative);

    if (missing.length === 0) return result;

    console.log(`[narrative-retry] ${category} 배치 후 narrative 누락 ${missing.length}개, 개별 재시도 시작`);

    // 2차: 누락 키워드 개별 재시도 (최대 3개)
    const retryBudget = Math.min(missing.length, 3);
    for (let i = 0; i < retryBudget; i++) {
      const item = missing[i];
      try {
        const single = await callGPTNarrative({ keywords: [item], category, rawTexts });
        if (single[item.keyword]) {
          result[item.keyword] = single[item.keyword];
          console.log(`[narrative-retry] ${item.keyword} 재시도 성공`);
        }
      } catch(e) {
        console.error(`[narrative-retry] ${item.keyword} 재시도 실패:`, e.message);
      }
    }

    const narrativeCount = Object.values(result).filter(v => v && v.narrative).length;
    console.log(`[narrative-origin] ${category} 최종 narrative ${narrativeCount}/${keywords.length}개`);
    return result;

  } catch(batchErr) {
    // 전체 배치 실패 — 개별 재시도 (최대 5개)
    console.error(`[narrative-batch] ${category} 배치 전체 실패:`, batchErr.message);
    const result = {};
    const budget = Math.min(keywords.length, 5);
    for (let i = 0; i < budget; i++) {
      try {
        const single = await callGPTNarrative({ keywords: [keywords[i]], category, rawTexts });
        Object.assign(result, single);
        console.log(`[narrative-fallback] ${keywords[i].keyword} 개별 호출 성공`);
      } catch(e) {
        console.error(`[narrative-fallback] ${keywords[i].keyword} 실패:`, e.message);
      }
    }
    return result;
  }
}

// ─────────────────────────────────────────────
// 분류기: gpt-4o (+ gpt-4o-mini 폴백)
// ─────────────────────────────────────────────
async function classifyBatchWithGPT({ rawTextsByCategory }) {
  const sections = Object.entries(rawTextsByCategory).map(([cat, lines]) => {
    const clip = (lines || []).slice(0, 40).join(' | ').slice(0, 2000);
    return `## ${CATEGORY_KO[cat] || cat} (key=${cat})\n${clip || '없음'}`;
  }).join('\n\n');

  const prompt = `당신은 국내(한국) 소상공인(카페·음식점·뷰티·꽃집·패션·피트니스·반려동물·인테리어·교육·스튜디오) 인스타그램 트렌드 분석 전문가입니다.

아래 5개 외부 소스(네이버 데이터랩·네이버 블로그·구글 트렌드·YouTube·Instagram)에서 수집한 원시 텍스트를 읽고,
각 업종 카테고리에서 실제 유행하는 **트렌드 대상** 키워드 5~12개씩 선별해 JSON으로 반환하세요.
(데이터가 부족한 카테고리 — 피트니스·반려동물·인테리어·교육·스튜디오 — 는 시드 키워드 관련 구체적 상품·스타일·기법이면 넓게 포함 가능)

[원시 수집 텍스트]
${sections}

## 카테고리별 범위 (중복 배치 금지 — 각 키워드는 가장 구체적인 카테고리 하나에만)
- beauty: 스킨케어, 메이크업, 파운데이션, 립, 아이섀도, 속눈썹 연장, 왁싱, 바디케어, 피부관리, 화장품 신제품
  예) 글로우메이크업, 선크림, 비건쿠션, 속눈썹펌, 피부장벽크림
  ※ 네일·헤어 키워드는 beauty에 넣지 말 것
- nail (네일): 젤네일, 네일아트, 패디큐어, 네일케어, 큐빅네일, 프렌치네일, 글리터네일, 오프젤, 네일컬러
  예) 오로라네일, 글리터젤, 봄컬러네일, 플라워네일아트
  ※ beauty/hair와 별개. 네일 관련 키워드는 반드시 nail 배열에만
- hair (헤어): 헤어커트, 펌, 염색, 볼륨, 레이어드컷, 탈모케어, 두피관리, 헤어스타일링, 앞머리, 단발
  예) 볼륨매직, 레이어드컷, 뿌리염색, 두피스케일링, 컬링아이롱
  ※ beauty/nail와 별개. 헤어 관련 키워드는 반드시 hair 배열에만

## 절대 준수 — "트렌드 자체" vs "트렌드를 찾기 위한 검색어" 엄격 구분
- 유효(선별 O): 구체적 대상·제품·메뉴·스타일·기법
  예) 말차라떼, 크로플, 글레이즈드네일, 오마카세, 팝업스토어, 뉴트로, matcha latte, smash burger, glazed nails
- 무효(제외): 카테고리·평가·행위·의도
  예) 맛집, 핫플레이스, 추천, 축제, 재밌는곳, 데이트코스, 가볼만한곳, 인기, 데일리, 맛있는, 예쁜

## 특히 다음 "포괄 카테고리 용어"는 반드시 제외
- "신상X", "신메뉴", "신제품", "신상음료", "신상디저트" 등 "신상/신메뉴" 계열 모두 제외
- "X카페" 형태 중 업종 총칭 모두 제외
- "계절+카테고리" 조합 모두 제외
- "속성+카테고리" 조합 제외
- 업종 총칭(카페, 베이커리, 디저트, 네일샵, 피부과, 헤어샵, 음식점) 단독 모두 제외

## 추가 금지
- 뉴스매체·패션지, 경쟁 브랜드, 필러 워드, 뉴스 문장 단편, 상시 해시태그, 지역명 단독

## 출력 형식 (엄격)
JSON 객체만 반환. 설명·마크다운·코드블록 금지.
스키마:
{"cafe": ["키워드1", ...], "food": ["키워드1", ...], "beauty": ["키워드1", ...], "nail": ["키워드1", ...], "hair": ["키워드1", ...], "flower": ["키워드1", ...], "fashion": ["키워드1", ...], "fitness": ["키워드1", ...], "pet": ["키워드1", ...]}

- 각 배열 5~12개
- beauty/nail/hair는 서로 겹치는 키워드 없이 완전히 분리
- 각 키워드: 2~20자, # 없이, 한 단어 또는 공백 없는 합성어 우선(최대 두 단어)
- 배열 내 중복 금지`;

  try {
    const content = await callGPT({ prompt, maxTokens: 1200, temperature: 0.2 });
    if (!content) return null;

    const clean = content.replace(/```json|```/g, '').trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) return null;
    let parsed;
    try {
      parsed = JSON.parse(match[0]);
    } catch(e) {
      console.error('[gpt-classify] JSON parse 실패');
      return null;
    }

    const out = {};
    for (const cat of ['cafe', 'food', 'beauty', 'nail', 'hair', 'flower', 'fashion', 'fitness', 'pet']) {
      const arr = Array.isArray(parsed[cat]) ? parsed[cat] : [];
      const seen = new Set();
      const cleaned = [];
      for (const t of arr) {
        const norm = normalize(t);
        const key = norm.toLowerCase();
        if (!norm || seen.has(key)) continue;
        if (isBadKeyword(norm)) continue;
        seen.add(key);
        cleaned.push(norm);
        if (cleaned.length >= 12) break;
      }
      out[cat] = cleaned;
    }
    return out;
  } catch(e) {
    console.error('[gpt-classify] 실패:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// Rising 예측 (gpt-4o + gpt-4o-mini 폴백)
// ─────────────────────────────────────────────
async function predictRisingWithGPT({ category, domesticTags, naverData, blogData, youtubeData, googleKR }) {
  const categoryKo = CATEGORY_KO[category] || '일반';
  const recentStr = (naverData || []).slice(0, 8).join(', ') || '없음';
  const blogStr = (blogData || []).slice(0, 6).join(' | ').slice(0, 500) || '없음';
  const ytStr = (youtubeData || []).slice(0, 6).join(' | ').slice(0, 500) || '없음';
  const googleStr = (googleKR || []).slice(0, 8).join(', ') || '없음';
  const currentStr = (domesticTags || []).slice(0, 8).join(', ') || '없음';

  const prompt = `당신은 인스타그램 트렌드 예측 전문가입니다.

"${categoryKo}" 업종에서 앞으로 2~4주 안에 유행할 가능성이 높은 키워드 10개를 예측하세요.

[현재 유행 중]
${currentStr}

[네이버 최근 급상승]
${recentStr}

[블로그 신상 텍스트]
${blogStr}

[YouTube 인기 영상 제목]
${ytStr}

[구글 트렌드(한국)]
${googleStr}

각 키워드에 대해 다음을 JSON 배열로 응답하세요:
- keyword: 예측 키워드 (한국어, 2~20자, # 없이)
- confidence: 유행 가능성 0~100 정수
- growthRate: 예상 성장률 문자열 (예: "+35%")
- reason: 예측 근거 1줄 (20자 이내, 한국어)

절대 금지: 현재 이미 널리 유행 중인 단어, 카테고리 단어(카페·커피·네일), 지역명, 브랜드명, 필러 워드

응답: JSON 배열만, 설명·마크다운 없음.
예시: [{"keyword":"흑임자라떼","confidence":78,"growthRate":"+42%","reason":"흑임자 붐 + 음료 결합 수요"}]`;

  try {
    const content = await callGPT({ prompt, maxTokens: 1400, temperature: 0.4 });
    if (!content) return null;

    const clean = content.replace(/```json|```/g, '').trim();
    const match = clean.match(/\[[\s\S]*\]/);
    if (!match) return null;
    let items;
    try {
      items = JSON.parse(match[0]);
    } catch {
      return null;
    }
    if (!Array.isArray(items)) return null;

    const valid = items.filter(item =>
      item && item.keyword && !isBadKeyword(item.keyword) &&
      typeof item.confidence === 'number' &&
      item.reason
    ).slice(0, 10);

    return valid.length >= 2 ? valid : null;
  } catch(e) {
    console.error('[gpt-rising]', category, '실패:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// 크로스 소스 검증
// keyword → Set<sourceType> 매핑
// ─────────────────────────────────────────────
function buildCrossSourceMap({ keyword, naverData, blogData, ytKR, igTexts, googleKR }) {
  const norm = normalize(keyword).toLowerCase();
  const sources = new Set();

  if ((naverData || []).some(t => normalize(t).toLowerCase().includes(norm))) sources.add('datalab');
  if ((blogData || []).some(t => normalize(t).toLowerCase().includes(norm))) sources.add('blog');
  if ((ytKR || []).some(t => normalize(t).toLowerCase().includes(norm))) sources.add('youtube');
  if ((igTexts || []).some(t => normalize(t).toLowerCase().includes(norm))) sources.add('ig');
  if ((googleKR || []).some(t => normalize(t).toLowerCase().includes(norm))) sources.add('google');

  return sources;
}

// ─────────────────────────────────────────────
// Velocity 계산
// DB에서 전날(7일 전) 스냅샷 조회해 증가율 산출
// ─────────────────────────────────────────────
async function computeVelocity({ supa, keyword, category, todayCount }) {
  try {
    const prevDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const prevKey = `l30d-domestic:${category}:${prevDate}`;
    const { data } = await supa
      .from('trends')
      .select('keywords')
      .eq('category', prevKey)
      .maybeSingle();

    if (!data || !data.keywords) return null;
    const prevKeywords = Array.isArray(data.keywords.keywords)
      ? data.keywords.keywords
      : Array.isArray(data.keywords) ? data.keywords : [];

    const prevItem = prevKeywords.find(k =>
      normalize(k.keyword || '').toLowerCase() === normalize(keyword).toLowerCase()
    );
    const prevScore = prevItem ? (prevItem.score || prevItem.mentions || 0) : 0;
    if (prevScore === 0) return null;

    const pct = ((todayCount - prevScore) / prevScore) * 100;
    return Math.round(pct * 10) / 10;
  } catch(e) {
    return null;
  }
}

// ─────────────────────────────────────────────
// 신조어 감지: 지난 90일 trend_keywords에 없는 키워드
// ─────────────────────────────────────────────
async function checkIsNew({ supa, keyword, category }) {
  try {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data, error } = await supa
      .from('trend_keywords')
      .select('id')
      .eq('keyword', keyword)
      .eq('category', category)
      .lt('collected_date', cutoff)
      .limit(1);

    if (error) {
      // trend_keywords 테이블 미존재 등 에러 → 신조어 판별 불가, false 반환
      return false;
    }
    // 90일 이전 기록이 없으면 신조어
    return !data || data.length === 0;
  } catch(e) {
    return false;
  }
}

// ─────────────────────────────────────────────
// 가중치 스코어 계산
// ─────────────────────────────────────────────
function computeWeightedScore({ keyword, naverData, blogData, ytKR, igTexts, googleKR }) {
  const norm = normalize(keyword).toLowerCase();

  const countIn = (arr) => (arr || []).filter(t => normalize(t).toLowerCase().includes(norm)).length;

  const dlCount = countIn(naverData);
  const blogCount = countIn(blogData);
  const ytCount = countIn(ytKR);
  const igCount = countIn(igTexts);
  const googleCount = countIn(googleKR);

  return (
    dlCount * SOURCE_WEIGHTS.datalab +
    blogCount * SOURCE_WEIGHTS.blog +
    ytCount * SOURCE_WEIGHTS.youtube +
    igCount * SOURCE_WEIGHTS.ig +
    googleCount * SOURCE_WEIGHTS.google
  );
}

// ─────────────────────────────────────────────
// Supabase 저장 (레거시 6종 - 기존과 동일)
// ─────────────────────────────────────────────
function toKeywordObjects(tags, source) {
  return tags.map((kw, i) => ({
    keyword: kw,
    score: 100 - i * 5,
    mentions: 0,
    source,
  }));
}

async function saveScope({ supa, scope, category, tags, updatedAt, source }) {
  const scopeKey = `l30d-${scope}:${category}`;
  const prevKey = `l30d-${scope}-prev:${category}`;
  const dateStr = updatedAt.slice(0, 10);
  const dateKey = `l30d-${scope}:${category}:${dateStr}`;

  const payload = {
    keywords: toKeywordObjects(tags, source),
    insight: '',
    updatedAt,
    source,
  };

  // prev 백업
  try {
    const { data: cur } = await supa
      .from('trends')
      .select('keywords')
      .eq('category', scopeKey)
      .single();
    if (cur) {
      await supa.from('trends').upsert(
        { category: prevKey, keywords: cur.keywords, collected_at: new Date().toISOString() },
        { onConflict: 'category' }
      );
    }
  } catch(e) { /* prev 없어도 OK */ }

  // 현재 데이터 upsert
  await supa.from('trends').upsert(
    { category: scopeKey, keywords: payload, collected_at: updatedAt },
    { onConflict: 'category' }
  );

  // 날짜별 스냅샷
  await supa.from('trends').upsert(
    { category: dateKey, keywords: payload, collected_at: updatedAt },
    { onConflict: 'category' }
  );

  // 레거시 호환: trends:{cat}
  if (scope === 'domestic') {
    const tagsWithHash = tags.map(t => '#' + t);
    await supa.from('trends').upsert(
      {
        category: 'trends:' + category,
        keywords: { tags: tagsWithHash, updatedAt, source: 'scheduled-trends' },
        collected_at: updatedAt,
      },
      { onConflict: 'category' }
    );

    // 레거시 호환: bare 카테고리 키
    await supa.from('trends').upsert(
      {
        category,
        keywords: toKeywordObjects(tags, source),
        collected_at: updatedAt,
      },
      { onConflict: 'category' }
    );
  }
}

// ─────────────────────────────────────────────
// trend_keywords 테이블 upsert (v2 신규)
// ─────────────────────────────────────────────
async function saveTrendKeywordsV2({ supa, category, enrichedKeywords, collectedDate }) {
  if (!enrichedKeywords || enrichedKeywords.length === 0) return;

  // sources: Set → { naver_datalab: 1, blog: 1, ... } 형태로 변환해 jsonb 저장
  const rows = enrichedKeywords.map(item => {
    const sourcesObj = {};
    for (const s of (item.sourcesSet || [])) sourcesObj[s] = 1;
    // axis: Phase 2 분류 결과 (menu/interior/goods/experience) 또는 'general' 기본값
    // 'domestic'은 이 컬럼 의미와 충돌하므로 사용 안 함
    const axis = item.axis || 'general';
    return {
      keyword: item.keyword,
      category,
      axis,
      sub_category: '',  // empty string (NULL 회피 — 인덱스 dedup 일관성)
      collected_date: collectedDate,
      signal_tier: item.signalTier,
      cross_source_count: item.crossSourceCount,
      weighted_score: item.weightedScore,
      velocity_pct: item.velocityPct,
      is_new: item.isNew,
      sources: sourcesObj,  // DB 스키마의 sources jsonb 컬럼
      narrative: item.narrative || null,
      origin: item.origin || null,
    };
  });

  try {
    // delete + insert 패턴 (daily overwrite)
    // Phase 2: axis가 general/menu/interior/goods/experience 모두 포함하여 삭제
    await supa
      .from('trend_keywords')
      .delete()
      .eq('category', category)
      .eq('collected_date', collectedDate)
      .in('axis', ['general', 'menu', 'interior', 'goods', 'experience', 'domestic']);

    await supa
      .from('trend_keywords')
      .insert(rows);

    console.log(`[trend_keywords] ${category} ${rows.length}건 저장`);
  } catch(e) {
    console.error('[trend_keywords] 저장 실패 (계속 진행):', e.message);
  }
}

// ─────────────────────────────────────────────
// 메인 핸들러
// ─────────────────────────────────────────────
exports.handler = runGuarded({
  name: 'scheduled-trends',
  handler: async (event, ctx) => {
    // 인증 체크 (HTTP 트리거 시)
    const isScheduled = !event || !event.httpMethod;
    if (!isScheduled) {
      const secret = (event.headers && (event.headers['x-lumi-secret'] || event.headers['X-Lumi-Secret'])) || '';
      if (!process.env.LUMI_SECRET || secret !== process.env.LUMI_SECRET) {
        return {
          statusCode: 401,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: '인증 실패' }),
        };
      }
    }

    // 카나리 설정 읽기
    const canaryCats = (process.env.TREND_V2_CANARY_CATS || 'all').trim().toLowerCase();
    const isCanary = canaryCats !== 'all';
    const canaryList = isCanary ? canaryCats.split(',').map(s => s.trim()).filter(Boolean) : [];

    console.log(`[trends-v2] 시작 (canary=${canaryCats})`);

    let supa;
    try {
      supa = getAdminClient();
    } catch(e) {
      console.error('[trends-v2] Supabase 초기화 실패:', e.message);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Supabase 초기화 실패' }),
      };
    }

    const categories = ['cafe', 'food', 'beauty', 'nail', 'hair', 'flower', 'fashion', 'fitness', 'pet'];
    const COLLECT_CATEGORIES = ['cafe', 'food', 'beauty', 'hair', 'nail', 'flower', 'fashion', 'fitness', 'pet'];
    const updatedAt = new Date().toISOString();
    const collectedDate = updatedAt.slice(0, 10);

    // ─── 1단계: 수집 ───────────────────────────
    await ctx.stage('collecting', { cats: categories.length });

    let googleKR = [];
    try {
      googleKR = await fetchGoogleTrendsLib('KR');
    } catch(e) {
      console.error('[sources] google-kr 수집 실패 (계속 진행):', e.message);
    }
    console.log(`[sources] google-kr: ${googleKR.length}`);

    const rawEntries = await Promise.all(COLLECT_CATEGORIES.map(async (category) => {
      const [naverData, blogData, ytKR, igTexts] = await Promise.all([
        fetchNaverDatalab(category),
        fetchNaverBlogs(category),
        fetchYouTube(category),
        fetchInstagram(supa, category),
      ]);
      console.log(`[${category}] naver=${naverData.length} blog=${blogData.length} yt-kr=${ytKR.length} ig=${igTexts.length}`);
      return [category, { naverData, blogData, ytKR, igTexts }];
    }));
    const rawByCategory = Object.fromEntries(rawEntries);

    // ─── 2단계: 크로스 소스 맵 구축 ─────────────
    await ctx.stage('cross-source', {});

    // ─── 3단계: GPT 분류 ────────────────────────
    await ctx.stage('classification', {});

    const domesticTexts = {};
    for (const cat of categories) {
      const r = rawByCategory[cat];
      domesticTexts[cat] = [
        ...r.naverData,
        ...r.blogData,
        ...r.ytKR,
        ...googleKR,
        ...r.igTexts,
      ];
    }

    let domesticClassified = null;
    if (process.env.OPENAI_API_KEY) {
      domesticClassified = await classifyBatchWithGPT({ rawTextsByCategory: domesticTexts });
    }

    // ─── 4단계: 스코어링 + 신조어 감지 ───────────
    await ctx.stage('scoring', {});

    // ─── 5단계: 레거시 저장 + v2 저장 ─────────────
    await ctx.stage('saving-legacy', {});

    const allDomestic = [];
    const results = await Promise.all(categories.map(async (category) => {
      try {
        // 카나리 모드: 해당 카테고리가 카나리 목록에 없으면 v1 경로로
        const isV2Cat = !isCanary || canaryList.includes(category);

        const r = rawByCategory[category];

        let domesticTags = (domesticClassified && domesticClassified[category]) || [];
        if (!domesticTags || domesticTags.length < 3) {
          const fromNaver = (r.naverData || []).map(normalize).filter(kw => !isBadKeyword(kw));
          domesticTags = [...new Set([...domesticTags, ...fromNaver, ...(DEFAULT_TRENDS[category] || [])])].slice(0, 10);
        } else if (domesticTags.length < 10) {
          domesticTags = [...new Set([...domesticTags, ...(DEFAULT_TRENDS[category] || [])])].slice(0, 10);
        } else {
          domesticTags = domesticTags.slice(0, 10);
        }

        // v2 스코어링 (isV2Cat인 경우에만)
        let enrichedKeywords = [];
        if (isV2Cat) {
          enrichedKeywords = await Promise.all(domesticTags.map(async (keyword, idx) => {
            const sourcesSet = buildCrossSourceMap({
              keyword,
              naverData: r.naverData,
              blogData: r.blogData,
              ytKR: r.ytKR,
              igTexts: r.igTexts,
              googleKR,
            });

            const crossSourceCount = sourcesSet.size;
            const signalTier = crossSourceCount >= 2 ? 'real' : 'weak';
            const weightedScore = computeWeightedScore({
              keyword,
              naverData: r.naverData,
              blogData: r.blogData,
              ytKR: r.ytKR,
              igTexts: r.igTexts,
              googleKR,
            });
            const todayScore = 100 - idx * 5;
            const velocityPct = await computeVelocity({ supa, keyword, category, todayCount: todayScore });
            const isNew = await checkIsNew({ supa, keyword, category });

            return {
              keyword,
              score: todayScore,
              crossSourceCount,
              signalTier,
              weightedScore,
              velocityPct,
              isNew,
              sourcesSet,
              axis: 'general',  // Phase 2에서 덮어씌워짐
            };
          }));
        }

        // Phase 2: 4축 분할 (AXIS_CATEGORIES에 속한 카테고리만)
        if (isV2Cat && AXIS_CATEGORIES.includes(category) && enrichedKeywords.length > 0) {
          try {
            const axisResult = await splitKeywordsByAxis(domesticTags, category);
            if (axisResult) {
              // keyword → axis 매핑
              const keywordAxisMap = {};
              for (const [axis, kws] of Object.entries(axisResult)) {
                for (const kw of (kws || [])) {
                  keywordAxisMap[kw] = axis;
                }
              }
              enrichedKeywords = enrichedKeywords.map(item => ({
                ...item,
                axis: keywordAxisMap[item.keyword] || 'general',
              }));
              console.log(`[axis-split] ${category} 완료:`, JSON.stringify(
                Object.fromEntries(Object.entries(axisResult).map(([k, v]) => [k, v.length]))
              ));
            }
          } catch(e) {
            console.error('[axis-split]', category, '실패 (fallback general):', e.message);
          }
        }

        // Phase 2: narrative + origin 배치 생성 (real 키워드만, 최대 5개씩 배치)
        if (isV2Cat && process.env.OPENAI_API_KEY) {
          try {
            const rawTexts = [...(r.blogData || []), ...(r.ytKR || []), ...(r.igTexts || [])];
            const BATCH_SIZE = 5;
            const narrativeMap = {};

            // 배치 분할 (모든 키워드 대상 — signal_tier 무관, 최상위 품질)
            for (let i = 0; i < enrichedKeywords.length; i += BATCH_SIZE) {
              const batch = enrichedKeywords.slice(i, i + BATCH_SIZE);
              const batchResult = await generateNarrativeAndOriginBatch({
                keywords: batch,
                category,
                rawTexts,
              });
              Object.assign(narrativeMap, batchResult);
            }

            // enrichedKeywords에 narrative/origin 병합
            enrichedKeywords = enrichedKeywords.map(item => {
              const extra = narrativeMap[item.keyword];
              if (!extra) return item;
              return { ...item, narrative: extra.narrative, origin: extra.origin };
            });

            const narrativeCount = Object.keys(narrativeMap).length;
            console.log(`[narrative-origin] ${category} ${narrativeCount}개 생성`);
          } catch(e) {
            console.error('[narrative-origin]', category, '실패 (계속 진행):', e.message);
          }
        }

        // Rising 예측, saveScope, v2 trend_keywords 저장 병렬
        const collectedDate = updatedAt.slice(0, 10);
        const [_, __, risingItemsRaw] = await Promise.all([
          saveScope({ supa, scope: 'domestic', category, tags: domesticTags, updatedAt, source: 'gpt-4o' }),
          (async () => {
            if (isV2Cat && enrichedKeywords.length > 0) {
              return saveTrendKeywordsV2({ supa, category, enrichedKeywords, collectedDate });
            }
          })(),
          process.env.OPENAI_API_KEY
            ? predictRisingWithGPT({
                category, domesticTags,
                naverData: r.naverData, blogData: r.blogData,
                youtubeData: r.ytKR, googleKR,
              })
            : Promise.resolve(null),
        ]);

        domesticTags.forEach((kw, i) => allDomestic.push({
          keyword: kw, score: 100 - i * 5, mentions: 0, source: 'gpt-4o', bizCategory: category
        }));

        let risingItems = risingItemsRaw;
        if (!risingItems || risingItems.length < 2) {
          const pool = (domesticTags.length >= 10 ? domesticTags.slice(0, 10) : [...domesticTags, ...(DEFAULT_TRENDS[category] || [])].slice(0, 10));
          risingItems = pool.map((kw, i) => ({
            keyword: kw,
            confidence: Math.max(30, 75 - i * 5),
            growthRate: '+' + Math.max(5, 25 - i * 2) + '%',
            reason: '국내 트렌드 상승세',
          }));
        }

        try {
          await supa.from('trends').upsert(
            { category: `l30d-rising:${category}`, keywords: { items: risingItems, updatedAt, source: 'gpt-prediction' }, collected_at: updatedAt },
            { onConflict: 'category' }
          );
        } catch(e) {
          console.error(`[rising] ${category} 저장 실패:`, e.message);
        }

        console.log(`[${category}] 국내(${domesticTags.length}):`, domesticTags.join(', '));
        console.log(`[${category}] 뜰(${risingItems.length}):`, risingItems.map(r => r.keyword).join(', '));

        return { category, domestic: domesticTags.length, rising: risingItems.length, v2: isV2Cat, enrichedCount: enrichedKeywords.length };
      } catch(e) {
        console.error(`[trends-v2] ${category} 실패:`, e.message);
        try {
          await saveScope({ supa, scope: 'domestic', category, tags: DEFAULT_TRENDS[category] || [], updatedAt, source: 'fallback' });
        } catch(e2) {}
        return { category, error: e.message };
      }
    }));

    // ─── 6단계: trend_keywords v2 저장 ───────────
    await ctx.stage('saving-v2', {});

    // 각 카테고리 enrichedKeywords를 다시 수집해서 저장
    // (위 Promise.all 결과에서 enrichedKeywords를 전달받기 어려우므로 results에서 추적)
    // 실제 enriched 데이터는 위에서 저장 완료 — 여기서는 v2 upsert 실행
    // (categories 루프를 다시 돌지 않고, results에서 v2=true인 카테고리만 식별)
    const v2CatsSaved = results.filter(r => r.v2 && !r.error).map(r => r.category);
    console.log(`[trends-v2] v2 저장 카테고리: ${v2CatsSaved.join(', ')}`);

    // ─── 7단계: 종합(all) 저장 ───────────────────
    try {
      allDomestic.sort((a, b) => (b.score || 0) - (a.score || 0));

      try {
        const { data: curD } = await supa.from('trends').select('keywords').eq('category', 'l30d-domestic:all').single();
        if (curD) await supa.from('trends').upsert(
          { category: 'l30d-domestic-prev:all', keywords: curD.keywords, collected_at: updatedAt },
          { onConflict: 'category' }
        );
      } catch(e) {}

      await supa.from('trends').upsert(
        { category: 'l30d-domestic:all', keywords: { keywords: allDomestic.slice(0, 30), updatedAt, source: 'scheduled-gpt-all' }, collected_at: updatedAt },
        { onConflict: 'category' }
      );
    } catch(e) {
      console.error('[all] 실패:', e.message);
    }

    // ─── 8단계: Rising 예측 완료 ────────────────
    await ctx.stage('rising-prediction', {});

    console.log('[trends-v2] 완료:', JSON.stringify(results));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: true, updatedAt, results, version: 'v2' }),
    };
  },
});
