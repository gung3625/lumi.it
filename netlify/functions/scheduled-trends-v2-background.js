// scheduled-trends-v2-background.js — Trend Hub v2 Phase 1
// Lumi 지원 업종 (9개): cafe, food, beauty, hair, nail, flower, fashion, fitness, pet
// 제거됨: education, interior, studio (2026-04-23, 소상공인 인스타 SaaS 타깃 불일치)
// 변경 사항 (v1 대비):
//   - gpt-4o 전환 (분류·예측·스토리 전부), 전처리만 mini 폴백 가능
//   - 크로스 소스 검증: 2+ 소스 → signal_tier='real', 1소스 → 'weak'
//   - Velocity 스코어링: 전 주 대비 mention 증가율 (%)
//   - 소스별 가중치: datalab=3 / blog=1 / youtube=2 / ig=2 / google=1
//   - 레거시 키 6종 그대로 유지 (프론트 호환)
//   - runGuarded + heartbeat 키 'scheduled-trends' 그대로
//   - 카나리 전략: TREND_V2_CANARY_CATS env ('all' or comma-separated)

const { getAdminClient } = require('./_shared/supabase-admin');
const { runGuarded } = require('./_shared/cron-guard');
const { checkAndIncrementQuota, QuotaExceededError } = require('./_shared/openai-quota');
const { fetchRelatedFromSeeds } = require('./_shared/naver-ad-keyword-tool');
const https = require('https');

// ─────────────────────────────────────────────
// Phase 2: 4축 분할 대상 카테고리
// ─────────────────────────────────────────────
const AXIS_CATEGORIES = ['cafe', 'food', 'flower', 'fashion', 'pet'];

// ─────────────────────────────────────────────
// 지역 분할 (Phase 1: 구조 준비, 실제 수집은 Phase 2)
// ─────────────────────────────────────────────
const REGIONS = ['all', 'seoul', 'busan', 'daegu', 'incheon', 'daejeon', 'gwangju'];

const REGION_LABELS = {
  all: '전국',
  seoul: '서울',
  busan: '부산',
  daegu: '대구',
  incheon: '인천',
  daejeon: '대전',
  gwangju: '광주',
};

// 지역별 블로그 시드 확장 (Phase 2에서 실제 지역별 수집 시 사용)
function expandSeedsWithRegion(baseSeeds, region) {
  if (region === 'all') return baseSeeds;
  const regionLabel = REGION_LABELS[region];
  return baseSeeds.map(seed => `${regionLabel} ${seed}`);
}

// ─────────────────────────────────────────────
// 소스 가중치
// ─────────────────────────────────────────────
const SOURCE_WEIGHTS = {
  datalab: 3,
  blog: 1,
  youtube: 2,
  ig: 2,
  google: 1,
  news: 2,  // 뉴스는 신뢰도 높음
  community: 2,  // 커뮤니티 (맘카페·디시·더쿠 등)
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

// 한영 동의어 사전 (보수적, 확실한 것만)
const EN_KO_ALIAS = {
  'matcha': '말차',
  'latte': '라떼',
  'cafe': '카페',
  'coffee': '커피',
  'dessert': '디저트',
  'cream': '크림',
  'beauty': '뷰티',
  'nail': '네일',
  'hair': '헤어',
  'fashion': '패션',
};

function applyAliases(text) {
  let out = text;
  for (const [en, ko] of Object.entries(EN_KO_ALIAS)) {
    out = out.replace(new RegExp(en, 'g'), ko);
  }
  return out;
}

function normalize(raw) {
  if (!raw) return '';
  const step1 = String(raw)
    .normalize('NFC')                                        // Unicode 정규화
    .replace(/^#/, '')                                       // 해시태그 #
    .replace(/[\s\t\u3000]+/g, '')                          // 공백·전각공백 제거
    .replace(/[_\-·・。、,()（）\[\]「」『』]/g, '')           // 특수문자 제거
    .trim()
    .toLowerCase();                                          // 소문자
  return applyAliases(step1);
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
    { groupName: '시그니처음료', keywords: ['말차라떼유행', '흑임자라떼신상', '크림라떼브랜드'] },
    { groupName: '베이커리브랜드', keywords: ['런던베이글뮤지엄', '소금빵브랜드', '크로플카페'] },
    { groupName: '스페셜티브랜드', keywords: ['테라로사시그니처', '블루보틀콜드브루', '스페셜티핸드드립'] },
    { groupName: '디저트트렌드', keywords: ['크로플신상', '마들렌유행', '바스크치즈케이크'] },
    { groupName: '음료트렌드', keywords: ['버터라떼', '흑임자스무디', '말차티라미수'] },
    { groupName: '컨셉카페브랜드', keywords: ['감성카페인테리어', '팝업카페오픈', '루프탑카페브랜드'] }
  ],
  food: [
    { groupName: '브랜드맛집', keywords: ['노티드신상', '다운타우너버거', '런던베이글'] },
    { groupName: '오마카세트렌드', keywords: ['오마카세가성비', '스시오마카세', '한우오마카세'] },
    { groupName: '유행메뉴', keywords: ['마라탕유행', '수제버거브랜드', '파스타트렌드'] },
    { groupName: '주점트렌드', keywords: ['한식주점메뉴', '이자카야신메뉴', '와인바안주'] },
    { groupName: '팝업레스토랑', keywords: ['팝업레스토랑오픈', '셰프테이블', '야장감성포차'] },
    { groupName: '신흥맛집', keywords: ['성수맛집신상', '연남동신상', '한남동레스토랑'] }
  ],
  beauty: [
    { groupName: '브랜드토너추천', keywords: ['토너추천브랜드', '신상앰플', '에센스유행'] },
    { groupName: '입소문선크림', keywords: ['입소문난선크림', '올영인기선크림', '선스틱브랜드'] },
    { groupName: '브랜드신제품', keywords: ['닥터지신제품', '라네즈신상', '코스알엑스인기제품'] },
    { groupName: '이니스프리스킨', keywords: ['이니스프리신상스킨', '뷰티유튜버추천제품', '파우더룸신상리뷰'] },
    { groupName: '성분트렌드', keywords: ['나이아신아마이드세럼', '레티놀크림', '히알루론산토너'] },
    { groupName: '쿠션파운데이션', keywords: ['신상쿠션브랜드', '비건쿠션파운데이션', '글로우파운데이션'] }
  ],
  hair: [
    { groupName: '유행컷트', keywords: ['레이어드컷', '허쉬컷', '풀단발'] },
    { groupName: '뱅앞머리', keywords: ['뱅헤어', '시스루뱅', '태슬뱅'] },
    { groupName: '유행펌', keywords: ['볼륨펌', '허쉬펌', '히피펌'] },
    { groupName: '매직스트레이트', keywords: ['매직스트레이트', '앞머리매직', '뿌리매직'] },
    { groupName: '유행염색', keywords: ['애쉬브라운', '오렌지브라운', '다크초콜릿'] },
    { groupName: '염색기법', keywords: ['뿌리염색', '하이라이트', '발레아쥬'] },
  ],
  nail: [
    { groupName: '유행네일컬러', keywords: ['누드네일', '아이보리네일', '라떼네일'] },
    { groupName: '유행네일아트', keywords: ['오로라네일', '마블네일', '플라워네일'] },
    { groupName: '글리터스톤', keywords: ['글리터젤', '오로라스톤', '크롬네일'] },
    { groupName: '시즌네일', keywords: ['봄네일', '웨딩네일', '파티네일'] },
    { groupName: '네일기법', keywords: ['젤네일', '패디큐어', '프렌치네일'] },
  ],
  flower: [
    { groupName: '꽃종류트렌드', keywords: ['라넌큘러스부케', '수국드라이플라워', '팜파스그라스'] },
    { groupName: '드라이플라워', keywords: ['유칼립투스리스', '목화솜부케', '드라이플라워인테리어'] },
    { groupName: '플라워브랜드', keywords: ['모리플라워', '바이블루밍', '꽃집브랜드'] },
    { groupName: '계절꽃트렌드', keywords: ['프리지어향기', '샴페인장미부케', '버드나무가지'] },
    { groupName: '플라워클래스', keywords: ['플라워원데이클래스', '리스만들기클래스', '부케제작클래스'] }
  ],
  fashion: [
    { groupName: '자라신상', keywords: ['자라신상', '유니클로히트', '무신사유행'] },
    { groupName: 'SPA신상', keywords: ['에잇세컨즈신상', '탑텐신상', '스파브랜드신상'] },
    { groupName: '유행스타일', keywords: ['오버핏블레이저', 'Y2K패션', '코어코어스타일'] },
    { groupName: '데님트렌드', keywords: ['데님온데님코디', '와이드데님팬츠', '빈티지데님재킷'] },
    { groupName: '아이템트렌드', keywords: ['롱스커트유행', '가죽자켓브랜드', '니트조끼코디'] },
    { groupName: '무신사브랜드', keywords: ['무신사픽아이템', '무신사스탠다드신상', '온라인패션브랜드'] },
    { groupName: '스니커즈브랜드', keywords: ['나이키런닝화신상', '호카신상', '온러닝추천'] }
  ],
  fitness: [
    { groupName: '리포머필라테스', keywords: ['리포머프라이빗', '기구필라테스브랜드', '필라테스스튜디오추천'] },
    { groupName: '운동복브랜드', keywords: ['룰루레몬신상', '나이키운동복', '아디다스레깅스'] },
    { groupName: '기구트렌드', keywords: ['케이블크로스운동', '레그프레스루틴', '케틀벨스윙'] },
    { groupName: '그룹운동프로그램', keywords: ['소울사이클', '크로스핏박스', '댄스피트니스'] }
  ],
  pet: [
    { groupName: '사료브랜드', keywords: ['로얄캐닌', '아카나', '오리젠'] },
    { groupName: '간식브랜드', keywords: ['츄잇', '더리얼', '동원펫푸드'] },
    { groupName: '용품브랜드', keywords: ['블루벨', '미미오', '딩고'] },
    { groupName: '영양제', keywords: ['강아지유산균브랜드', '관절영양제추천', '펫스킨케어'] },
    { groupName: '펫서비스', keywords: ['펫호텔추천브랜드', '반려견유치원', '도그워커'] }
  ],
};

const BLOG_SEARCH_SEEDS_BASE = {
  cafe: [
    '말차라떼 유행 카페',
    '흑임자 크림라떼 신상',
    '버터라떼 트렌드',
    '크로플 유행 카페',
    '바스크 치즈케이크 브랜드',
    '소금빵 유명 베이커리',
    '런던베이글뮤지엄 신메뉴',
    '테라로사 시그니처',
    '블루보틀 콜드브루',
    '말차 티라미수 카페',
    '수박라떼 신상',
    '흑임자 스무디 카페',
    '마들렌 유행 베이커리',
    '스콘 카페 추천',
    '핸드드립 스페셜티 카페',
    '레이어드 케이크 카페',
  ],
  food: [
    '노티드 신상 메뉴',
    '다운타우너 버거',
    '오마카세 가성비',
    '스시 오마카세 유행',
    '파스타 트렌드',
    '수제버거 브랜드',
    '마라탕 유행 브랜드',
    '이자카야 신메뉴',
    '한식주점 유행 안주',
    '팝업 레스토랑 오픈',
    '셰프 테이블 예약',
    '야장 포차 감성',
    '와인바 안주 트렌드',
    '성수 신상 맛집',
    '연남동 요즘 맛집',
    '한남동 레스토랑 신상',
    '한우 오마카세',
    '흑돼지 구이 유행',
  ],
  beauty: [
    '요즘 뜨는 토너 브랜드',
    '입소문 난 세럼',
    '신상 쿠션 브랜드',
    '올영 인기 선크림',
    '닥터지 신제품',
    '라네즈 신상',
    '코스알엑스 인기 제품',
    '이니스프리 신상 스킨',
    '뷰티 유튜버 추천 제품',
    '파우더룸 신상 리뷰',
    '나이아신아마이드 세럼 추천',
    '레티놀 크림 브랜드',
    '글로우 파운데이션 추천',
    '비건 쿠션 브랜드',
    '속눈썹펌 후기',
    '클렌징밤 브랜드 추천',
    '선스틱 추천 브랜드',
    '앰플 신상 리뷰',
    '에센스 브랜드 유행',
    '피부과 추천 화장품',
  ],
  hair: [
    '2026 유행 헤어 스타일',
    '요즘 뜨는 컷트 추천',
    '허쉬컷 후기',
    '레이어드컷 얼굴형별',
    '볼륨펌 vs 디지털펌',
    '뿌리펌 관리',
    '시스루뱅 어울리는',
    '2026 유행 염색 컬러',
    '애쉬브라운 자연스러운',
    '발레아쥬 염색 후기',
    '하이라이트 염색 가격',
    '뿌리염색 얼마나',
    '남자 헤어 트렌드',
    '여자 단발 스타일 추천',
    '긴머리 스타일링',
    '매직스트레이트 주기',
    '앞머리펌 관리',
  ],
  nail: [
    '2026 네일 트렌드',
    '요즘 유행 네일 디자인',
    '누드네일 연예인',
    '오로라네일 홀로그램',
    '마블네일 자연스러운',
    '플라워네일 아트',
    '크롬네일 미러',
    '젤네일 vs 아크릴',
    '봄 네일 컬러 추천',
    '웨딩 네일 디자인',
    '파티 네일 글리터',
    '20대 네일 스타일',
    '오피스 네일 단정한',
    '프렌치 네일 변형',
    '셀프 젤네일 추천',
    '페디큐어 관리 후기',
    '남자 네일 케어',
  ],
  flower: [
    '라넌큘러스 부케 트렌드',
    '수국 드라이플라워 인기',
    '팜파스그라스 인테리어',
    '유칼립투스 리스 유행',
    '플라워샵 브랜드 추천',
    '모리플라워 추천',
    '바이블루밍 인기',
    '목화솜 부케 유행',
    '샴페인장미 부케',
    '프리지어 향기 꽃집',
    '드라이플라워 리스 만들기',
    '플라워 원데이클래스 인기',
    '버드나무가지 인테리어',
    '봄 꽃 종류 트렌드',
  ],
  fashion: [
    '자라 신상 코디',
    '유니클로 히트텍 유행',
    '무신사 픽 아이템',
    '에잇세컨즈 신상',
    '탑텐 신상',
    '2026 유행 스타일',
    '오버핏 블레이저 브랜드',
    'Y2K 패션 아이템',
    '코어코어 스타일',
    '데님온데님 코디',
    '자라 신상 가죽자켓',
    '무신사 스탠다드 신상',
    '롱스커트 유행 브랜드',
    '니트 조끼 코디',
    '빈티지 데님 재킷',
    'Y2K 미니스커트 코디',
    '온라인 패션 브랜드 추천',
    '스파 브랜드 신상 추천',
    '나이키 런닝화 신상',
    '호카 신상 운동화',
    '온러닝 추천',
  ],
  fitness: [
    '룰루레몬 신상 레깅스',
    '케이블 크로스 운동법',
    '인기 필라테스 스튜디오 브랜드',
    '리포머 프라이빗 후기',
    '케틀벨 스윙 루틴',
    '아디다스 레깅스 신상',
    '소울사이클 후기',
    '크로스핏 박스 추천',
    '레그프레스 루틴',
    '바디프로필 식단',
    '스피닝 클래스 브랜드',
    '요가 플로우 스튜디오',
  ],
  pet: [
    '로얄캐닌 vs 오리젠',
    '아카나 추천 후기',
    '츄잇 신상 간식',
    '강아지 유산균 브랜드',
    '고양이 사료 브랜드 비교',
    '신상 펫용품 추천',
    '펫 브랜드 올해 신상',
    '반려견 관절 영양제 추천',
    '크라운펫 신상',
    '캐릭터브라더스 추천',
    '인기 반려동물 간식 브랜드',
    '펫 유튜버 추천 사료',
    '반려동물 프리미엄 브랜드',
    '딩고 간식 신상',
    '더리얼 사료 후기',
  ],
};

// 업종별 뉴스 검색 시드 — 드라마·PPL·이슈·신상 제품 중심
const NEWS_SEARCH_SEEDS = {
  cafe: [
    '카페 트렌드', '신상 음료', '디저트 신메뉴',
    '인기 카페', '카페 오픈', '스페셜티 커피'
  ],
  food: [
    '외식 트렌드', '신상 맛집', '요즘 인기 음식',
    '맛집 오픈', '신메뉴 출시', '미쉐린 가이드'
  ],
  beauty: [
    '뷰티 트렌드', '신상 화장품', '인기 브랜드',
    '뷰티 신제품', '립스틱 신상', '스킨케어 트렌드'
  ],
  hair: [
    '헤어 트렌드', '연예인 헤어스타일', '펌 신상',
    '염색 트렌드', '미용실 인기', '헤어 시술'
  ],
  nail: [
    '네일 트렌드', '네일아트 신상', '젤네일 유행',
    '연예인 네일', '네일 디자인 인기'
  ],
  flower: [
    '플라워 트렌드', '웨딩 부케', '꽃 선물 트렌드',
    '드라이플라워 인기', '플라워샵 오픈', '꽃 배달'
  ],
  fashion: [
    '패션 트렌드', '신상 의류', 'Y2K 패션',
    '연예인 패션', '가을 트렌드', '브랜드 런칭'
  ],
  fitness: [
    '피트니스 트렌드', '필라테스 유행', '운동 트렌드',
    '다이어트 신상', '바디프로필 인기', '홈트 신제품'
  ],
  pet: [
    '반려동물 트렌드', '펫 신상품', '강아지 간식 인기',
    '고양이 용품 트렌드', '펫호텔 오픈', '반려견 서비스'
  ]
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
    '말차라떼 신상 리뷰',
    '흑임자 크림라떼 만들기',
    '크로플 카페 브이로그',
    '테라로사 시그니처 리뷰',
    '블루보틀 콜드브루 후기',
    '바스크 치즈케이크 베이커리',
    '런던베이글뮤지엄 신메뉴',
    '소금빵 베이커리 투어',
  ],
  food: [
    '오마카세 가성비 리뷰',
    '노티드 신상 먹방',
    '수제버거 브랜드 비교',
    '한식주점 안주 메뉴',
    '파스타 트렌드 맛집',
    '팝업 레스토랑 후기',
    '야장 포차 브이로그',
    '마라탕 브랜드 리뷰',
  ],
  beauty: [
    '닥터지 신제품 리뷰',
    '라네즈 워터뱅크 후기',
    '코스알엑스 스네일 루틴',
    '나이아신아마이드 세럼 비교',
    '올영 인기 선크림 추천',
    '뷰티 하울 신상',
    '글로우 파운데이션 추천',
    '비건 쿠션 브랜드 리뷰',
  ],
  hair: [
    '2026 헤어 트렌드',
    '허쉬컷 스타일링',
    '볼륨펌 후기',
    '유행 염색 컬러',
    '발레아쥬 염색',
    '단발 스타일 추천',
    '앞머리 자르기 꿀팁',
    '미용실 시술 후기',
  ],
  nail: [
    '네일 트렌드 2026',
    '유행 네일 디자인',
    '오로라네일 셀프',
    '크롬 네일 방법',
    '봄 네일 아트',
    '웨딩 네일 추천',
    '네일샵 후기',
    '젤네일 vs 패디큐어',
  ],
  flower: [
    '라넌큘러스 부케 만들기',
    '수국 드라이플라워 리뷰',
    '유칼립투스 리스 DIY',
    '팜파스 그라스 인테리어',
    '플라워 원데이클래스 브이로그',
    '모리플라워 꽃집 소개',
    '샴페인장미 부케 제작',
    '드라이플라워 인테리어 DIY',
  ],
  fashion: [
    '자라 신상 하울',
    '유니클로 히트텍 리뷰',
    '무신사 픽 아이템 하울',
    'Y2K 패션 코디',
    '오버핏 블레이저 스타일링',
    '데님온데님 코디',
    '에잇세컨즈 신상 하울',
    '코어코어 스타일 코디',
    '나이키 런닝화 신상 리뷰',
    '호카 vs 온러닝 비교',
  ],
  fitness: [
    '리포머 프라이빗 후기',
    '룰루레몬 신상 레깅스 리뷰',
    '케이블 크로스 운동법',
    '소울사이클 클래스 후기',
    '케틀벨 스윙 루틴',
    '바디프로필 식단 영상',
  ],
  pet: [
    '사료 브랜드 비교 리뷰',
    '강아지 간식 추천 브랜드',
    '반려견 유산균 후기',
    '펫용품 신상 언박싱',
    '고양이 사료 추천',
    '반려동물 영양제 리뷰',
    '로얄캐닌 vs 아카나 비교',
    '츄잇 신상 간식 리뷰',
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
      const path = `/v1/search/blog.json?query=${encodeURIComponent(query)}&display=100&sort=date`;
      const result = await httpsGetWithHeaders(
        'openapi.naver.com',
        path,
        { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret },
        10000
      );
      if (result.status !== 200) continue;
      const data = JSON.parse(result.body);
      if (!data.items) continue;
      const blogCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const blogCutoffStr = blogCutoff.toISOString().slice(0, 10).replace(/-/g, '');  // YYYYMMDD
      for (const item of data.items) {
        const postdate = item.postdate || '';  // "20260401" 형식
        if (postdate && postdate < blogCutoffStr) continue;  // 30일 이전 skip
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

async function fetchNaverNews(category) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return [];

  const seeds = NEWS_SEARCH_SEEDS[category] || NEWS_SEARCH_SEEDS.cafe;
  const texts = [];
  for (const query of seeds) {
    try {
      const path = `/v1/search/news.json?query=${encodeURIComponent(query)}&display=30&sort=date`;
      const result = await httpsGetWithHeaders(
        'openapi.naver.com',
        path,
        {
          'X-Naver-Client-Id': clientId,
          'X-Naver-Client-Secret': clientSecret
        },
        10000
      );
      if (result.status !== 200) continue;
      const data = JSON.parse(result.body);
      if (!data.items) continue;

      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      for (const item of data.items) {
        // pubDate: "Thu, 23 Apr 2026 10:00:00 +0900" 형식
        const pubDate = new Date(item.pubDate || '');
        if (isNaN(pubDate) || pubDate < cutoff) continue;  // 30일 이내만

        const title = (item.title || '').replace(/<[^>]+>/g, '').trim();
        const desc = (item.description || '').replace(/<[^>]+>/g, '').trim();
        if (title) texts.push(title);
        if (desc) texts.push(desc.slice(0, 120));
      }
      await new Promise(r => setTimeout(r, 200));
    } catch(e) {
      console.error('[naver-news]', category, query, 'error:', e.message);
    }
  }
  return texts;
}

async function fetchKeywordSaturation(keyword) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const path = `/v1/search/blog.json?query=${encodeURIComponent(keyword)}&display=1&sort=sim`;
    const result = await httpsGetWithHeaders(
      'openapi.naver.com',
      path,
      {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret
      },
      5000
    );
    if (result.status !== 200) return null;
    const data = JSON.parse(result.body);
    return typeof data.total === 'number' ? data.total : null;
  } catch(e) {
    console.error('[saturation]', keyword, 'error:', e.message);
    return null;
  }
}

function classifySaturation(total) {
  if (total == null) return null;
  if (total < 500) return 'blue_ocean';
  if (total < 5000) return 'growing';
  if (total < 50000) return 'established';
  return 'saturated';
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
      const searchPath = `/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=50` +
        `&regionCode=KR` +
        `&publishedAfter=${encodeURIComponent(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())}` +
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
// 커뮤니티 트렌드 데이터 로드 (scheduled-community-trends 수집분)
// ─────────────────────────────────────────────
async function fetchCommunityData(supa, category) {
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: rows } = await supa
      .from('trends')
      .select('keywords, collected_at')
      .or(`category.eq.community:${category},category.like.community:${category}:%`)
      .gte('collected_at', cutoff + 'T00:00:00Z');

    if (!rows || rows.length === 0) return [];

    // items 병합 + keyword로 중복 제거
    const merged = new Set();
    for (const row of rows) {
      const items = row.keywords?.items || [];
      items.forEach(it => {
        if (it?.keyword) merged.add(it.keyword);
      });
    }
    return Array.from(merged);
  } catch (e) {
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
// ※ interior axis 키워드는 카테고리 탭 기본 응답에서 제외되며,
//   별도 endpoint(?axis=interior 또는 ?axis=all) 요청 시에만 노출.
//   분류기(classifyBatchWithGPT) 단계에서 cafe/food/beauty/flower/fashion 카테고리로
//   인테리어 키워드가 들어오는 것을 1차 차단하고, 그래도 들어온 row는
//   get-trends.js mergeV2Fields의 default axis 필터에서 2차 차단.
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
    interior: '오픈키친, 한옥인테리어, 우드인테리어',
    goods: '밀키트, 소스패키지, 굿즈',
    experience: '야장감성, 테라스뷰, 셰프테이블, 쿠킹클래스, 런치세트',
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

## 카테고리 배치 규칙

키워드가 **두 개 이상 카테고리에 명확히 해당**하면 **해당하는 모든 카테고리에 포함**하세요.
- 예: "디저트" → cafe(디저트 카페)·food(디저트 전문점) 모두 해당 → 둘 다 배치
- 예: "플라워 케이크" → flower(꽃 장식)·food(케이크)·cafe(디저트 케이크) 3곳 해당
- 예: "반려견 수제간식" → pet(반려동물 간식)·food(수제 식품) 둘 다 해당

단, **겹치지 않는 명확한 경계**는 기존대로 한 카테고리에만:
- "젤네일" → nail 전용 (beauty·hair 배치 금지)
- "매직스트레이트" → hair 전용 (beauty·nail 배치 금지)
- "필라테스 리포머" → fitness 전용
- "나이키런닝화"·"호카신상"·"온러닝"·운동화·스니커즈류 → **fashion 전용 (fitness 배치 절대 금지)** — 운동 장비가 아닌 패션 신발로 분류
- "참나무장작구이"·"야장감성"·"오마카세"·"이자카야" → food 전용 (**cafe 배치 절대 금지**)
- "라떼"·"크로플"·"소금빵"·"마들렌" → cafe 전용 (food 배치 금지)
- "와인바"·"주점"·"이자카야"·"고기집" → food 전용

애매하면 한 카테고리에만. 명확히 둘 이상 해당될 때만 복수 배치.
**중요**: 고기·술·주점 감성은 무조건 food에만. 카페는 음료·디저트·빵·커피 공간.

## 인테리어/공간 키워드 분류 규칙 (반드시 준수)
- 키워드는 **고객이 검색·소비할 수 있는 상품/서비스/메뉴**여야 함
- 인테리어·가구·공간·디스플레이 키워드(예: "X인테리어", "X공간", "X매장", "오픈키친", "한옥카페", "감성공간", "쇼룸", "디스플레이")는
  cafe·food·beauty·flower·fashion·fitness·pet 등 **어떤 업종 카테고리에도 분류하지 말 것** (필요 시 해당 키워드는 빈 배열에서 제외)
- cafe = 음료/디저트/원두/베이커리 메뉴 위주 (매장 인테리어 X)
- food = 식당 메뉴/요리/배달 메뉴 (식당 인테리어 X)
- beauty = 화장품/시술/메이크업 (매장 인테리어 X)
- flower = 꽃/꽃다발/식물 자체 (매장 디스플레이/인테리어 X)
- fashion = 옷/액세서리/신발·운동화·스니커즈/스타일 (매장 인테리어/쇼룸 X)
- 위 규칙 위반 시 해당 키워드는 모든 배열에서 제외 (빈 배열이 정답)

## 카테고리별 범위
- cafe (카페·음료): 커피·라떼·음료·디저트·베이커리·케이크·마카롱·스콘·소금빵·크로플·푸딩·빙수·스무디 (※ 카페 인테리어/공간 키워드는 cafe 배치 금지 — 아래 "인테리어/공간 키워드 분류 규칙" 참조)
  좋은 예) 말차라떼, 크로플, 소금빵, 흑임자크림라떼, 바스크치즈케이크, 버터라떼, 테라로사시그니처, 블루보틀콜드브루
  나쁜 예) 카페추천, 신상카페, 디저트카페 (카테고리 총칭)
  ※ **대형 체인 이름 포함 키워드 절대 금지**: 스타벅스XX·이디야XX·투썸XX·메가XX·컴포즈XX·빽다방XX
    → 체인 메뉴가 유행해도 메뉴명만 추출 (예: "수박라떼" O, "스타벅스 수박라떼" X)
  ※ 소상공인 카페 브랜드는 허용: 런던베이글뮤지엄, 테라로사, 블루보틀, 노티드, 레이어드, 어니언
  ※ **술·고기·구이·BBQ·주점·이자카야·와인바·포차 감성 절대 금지** (food로)
- food (음식·외식·주점): 식당·맛집·한식·일식·양식·중식·분식·주점·고기구이·BBQ·이자카야·와인바·오마카세·파스타·피자·햄버거·김밥·라멘, 야장·포차 감성
  좋은 예) 오마카세가성비, 수제버거브랜드, 마라탕유행, 노티드신상, 한식주점유행안주, 이자카야신메뉴
  나쁜 예) 맛집, 혼밥메뉴, 데이트맛집, 신상맛집 (카테고리 총칭 또는 속성+총칭)
  ※ 대형 프랜차이즈(백종원·본죽 등) 이름 포함 키워드 제외, 메뉴·요리법만
  ※ 카페 메뉴(라떼·디저트·빵)는 cafe 전용. food엔 식사·주류·고기 중심만
- beauty: 브랜드+제품명, 성분명, 메이크업 트렌드 중심
  좋은 예) 닥터지레드블레미쉬, 라네즈워터뱅크, 코스알엑스스네일, 나이아신아마이드세럼, 글로우파운데이션, 비건쿠션
  나쁜 예) 화장품, 스킨케어, 수분크림, 여자스킨케어 (카테고리 총칭 또는 속성+총칭)
  ※ 네일·헤어 키워드는 beauty에 넣지 말 것
- nail (네일): 유행하는 **디자인**(플라워/마블/오로라/크롬), **컬러**(누드/라떼/아이보리), **기법**(젤/패디큐어/프렌치) 중심
  좋은 예) 오로라네일, 누드네일, 크롬네일, 라떼컬러, 마블네일, 플라워네일아트, 글리터젤
  나쁜 예) 네일샵, 네일, 봄네일 (너무 일반 또는 시즌+총칭)
  ※ beauty/hair와 별개. 네일 관련 키워드는 반드시 nail 배열에만
- hair (헤어): 유행하는 **컷트 스타일**(허쉬컷/단발/뱅헤어/레이어드), **펌 종류**(볼륨펌/허쉬펌/디지털펌/매직스트레이트), **염색 컬러·기법**(애쉬브라운/오렌지브라운/발레아쥬/하이라이트/뿌리염색) 중심
  좋은 예) 허쉬컷, 애쉬브라운, 발레아쥬, 뿌리펌, 시스루뱅, 레이어드컷, 볼륨펌, 오렌지브라운
  나쁜 예) 미용실, 헤어샵, 염색, 펌, 남자헤어 (카테고리 총칭 또는 속성+총칭)
  ※ beauty/nail와 별개. 헤어 관련 키워드는 반드시 hair 배열에만
- flower (꽃집·플라워): 구체 꽃 종류·스타일·플라워샵 브랜드 중심
  좋은 예) 라넌큘러스부케, 수국드라이플라워, 팜파스그라스, 유칼립투스리스, 모리플라워, 샴페인장미부케
  나쁜 예) 꽃다발, 웨딩부케, 생일꽃, 꽃집추천 (카테고리 총칭 또는 용도+총칭)
- fitness (피트니스): 구체 프로그램·기구·운동복(레깅스/스포츠브라) 브랜드 중심
  좋은 예) 룰루레몬얼라인, 리포머프라이빗, 케이블크로스, 소울사이클, 케틀벨스윙, 아디다스레깅스신상
  나쁜 예) 헬스, 운동, 홈트, 다이어트운동, 필라테스 (카테고리 총칭 또는 목적+총칭), 나이키런닝화·호카·온러닝 (운동화는 fashion 전용)
  ※ 운동화·스니커즈·러닝화 브랜드는 fitness가 아니라 fashion 배열에 배치
- pet (반려동물): 사료/간식/용품 브랜드, 영양제, 펫 서비스 중심
  좋은 예) 로얄캐닌키튼, 아카나어덜트, 츄잇육포, 블루벨하네스, 강아지관절영양제, 딩고간식
  나쁜 예) 강아지사료, 고양이사료, 강아지간식, 고양이간식, 펫용품 (카테고리 총칭)
  ※ beauty/fashion/pet 브랜드명은 허용 (소상공인이 브랜드 참고해서 운영)

## 절대 준수 — "트렌드 자체" vs "트렌드를 찾기 위한 검색어" 엄격 구분
- 유효(선별 O): 구체적 대상·제품·메뉴·스타일·기법
  예) 말차라떼, 크로플, 글레이즈드네일, 오마카세, 팝업스토어, 뉴트로, matcha latte, smash burger, glazed nails
- 무효(제외): 카테고리·평가·행위·의도
  예) 맛집, 핫플레이스, 추천, 축제, 재밌는곳, 데이트코스, 가볼만한곳, 인기, 데일리, 맛있는, 예쁜

## 카테고리 총칭 절대 제외 (사용자 최우선 지시)
다음 패턴은 모든 업종에서 **반드시 제외** — 어떤 트렌드 값어치도 없는 무의미 단어:
1. 업종 명사 단독: 카페, 음식, 뷰티, 헤어, 네일, 꽃, 패션, 헬스, 펫, 스킨케어, 화장품
2. "종류명 + 총칭": 강아지사료, 고양이사료, 강아지간식, 고양이간식, 수분크림, 미백화장품
3. "대상/속성 + 카테고리": 남자코디, 여자스킨케어, 20대피부관리, 남성토너, 여드름케어
차라리 빈 배열 반환이 정답. 사용자가 명시: "차라리 정보가 없는 게 낫다."

## 특히 다음 "포괄 카테고리 용어"는 반드시 제외
- "신상X", "신메뉴", "신제품", "신상음료", "신상디저트" 등 "신상/신메뉴" 계열 모두 제외
- "X카페" 형태 중 업종 총칭 모두 제외
- "계절+카테고리" 조합 모두 제외
- "속성+카테고리" 조합 제외
- 업종 총칭(카페, 베이커리, 디저트, 네일샵, 피부과, 헤어샵, 음식점) 단독 모두 제외

## 특히 다음 "속성+카테고리" 조합 패턴은 절대 제외 — 사용자 최우선 지시
다음 조합 패턴은 모두 트렌드 아님, 반드시 제외:
- "연령/성별 + 카테고리" 조합:
  ❌ 남자봄코디, 남성토너, 20대피부관리, 30대다이어트, 40대안티에이징, 여자헤어, 남자스킨케어, 여자스킨케어
  → 차라리 빈 배열 반환. 구체 브랜드/제품이 있으면 그것만
- "기능/목적 + 카테고리" 조합:
  ❌ 여드름케어, 미백화장품, 수분크림, 진정토너, 안티에이징크림, 피부장벽케어
  → 성분명·브랜드명 포함될 때만 유효 (예: "나이아신아마이드세럼" OK)
- "시즌/계절 + 카테고리" 조합:
  ❌ 봄코디, 여름스킨케어, 가을메이크업, 겨울헤어, 봄네일
  → 특정 상품/브랜드 언급 시만 (예: "봄민트립스틱" OK)

## 최우선 포함 기준 — 사용자 최우선 지시
- 브랜드명 + 제품명 (가장 높은 우선순위):
  ✅ 닥터지레드블레미쉬, 라네즈워터뱅크, 코스알엑스스네일, 이니스프리그린티세럼
  ✅ 자라신상블레이저, 유니클로히트텍, 무신사픽셔츠
- 성분명: 나이아신아마이드, 레티놀, 히알루론산, 글리콜산, 비타민C
- 특정 스타일/기법: 오버핏블레이저, Y2K미니스커트, 허쉬컷, 애쉬브라운, 오로라네일
- 유행 메뉴/음료: 말차라떼, 크로플, 오마카세, 수제버거, 흑임자스무디

## 품질 > 수량 원칙 — 사용자 최우선 지시
**"정보가 없으면 빈 배열 반환이 정답"** — 수량 채우기 금지.
- 해당 카테고리에 구체적 브랜드·제품·스타일 근거가 부족하면 빈 배열 [] 반환
- 확신 없는 키워드 추측 배치 절대 금지

## 다양성 제약 — 단일 브랜드/트렌드 도배 금지
같은 응답 배열에 한 브랜드 또는 한 트렌드의 변종이 25% 를 초과하면 안 됨.
- 한 브랜드 변종(자라반팔티/자라진주버튼/자라플라워패턴) 은 배열의 25% 이내로 제한
- 한 트렌드 변종(우베도넛/우베치즈케이크/우베크림디저트) 도 동일
- 변종 도배가 발생하면 가장 대표적인 1~2개만 남기고 나머지는 다른 브랜드/트렌드로 대체
- 대체할 다른 신호가 없으면 배열을 짧게 유지 (수량 채우기 금지 원칙 준수)
- 예시) 자라가 4개면 → 자라 1개 + 유니클로/무신사/온라인편집숍 등 다른 브랜드 키워드로 교체

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
// 예측 적중률 평가 (28일 전 예측 vs 오늘 실제 데이터)
// ─────────────────────────────────────────────
async function evaluatePredictionAccuracy({ supa, category }) {
  try {
    // 1. 28일 전 날짜 계산
    const cutoff = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    // 2. 28일 전 스냅샷 조회
    const { data: oldPrediction } = await supa
      .from('trends')
      .select('keywords')
      .eq('category', `l30d-rising:${category}:${cutoffStr}`)
      .maybeSingle();

    if (!oldPrediction?.keywords?.items) return null;

    const predictedKeywords = oldPrediction.keywords.items.map(i => i.keyword).slice(0, 10);
    if (predictedKeywords.length === 0) return null;

    // 3. 오늘의 trend_keywords 조회 (signal_tier='real' 또는 velocity_pct>50)
    const today = new Date().toISOString().slice(0, 10);
    const { data: todayRows } = await supa
      .from('trend_keywords')
      .select('keyword, signal_tier, velocity_pct')
      .eq('category', category)
      .eq('collected_date', today);

    const todayMap = new Map();
    (todayRows || []).forEach(r => {
      todayMap.set((r.keyword || '').toLowerCase().trim(), r);
    });

    // 4. 적중 판정 (엄격: signal_tier=real OR velocity_pct>50)
    let matched = 0;
    const hitKeywords = [];
    for (const kw of predictedKeywords) {
      const r = todayMap.get((kw || '').toLowerCase().trim());
      if (r && (r.signal_tier === 'real' || (r.velocity_pct != null && r.velocity_pct > 50))) {
        matched++;
        hitKeywords.push(kw);
      }
    }

    // 5. 누적 적중률 조회/업데이트
    const { data: prevAccuracy } = await supa
      .from('trends')
      .select('keywords')
      .eq('category', `prediction-accuracy:${category}`)
      .maybeSingle();

    const prevCumulative = prevAccuracy?.keywords?.cumulative || { total_predicted: 0, total_matched: 0 };

    const newCumulative = {
      total_predicted: prevCumulative.total_predicted + predictedKeywords.length,
      total_matched: prevCumulative.total_matched + matched,
      accuracy: 0,
      updated_at: new Date().toISOString(),
    };
    newCumulative.accuracy = Math.round(newCumulative.total_matched / newCumulative.total_predicted * 1000) / 10;

    const recent28d = {
      total_predicted: predictedKeywords.length,
      total_matched: matched,
      accuracy: Math.round(matched / predictedKeywords.length * 1000) / 10,
      hit_keywords: hitKeywords.slice(0, 5),
    };

    // 6. 저장
    await supa.from('trends').upsert(
      {
        category: `prediction-accuracy:${category}`,
        keywords: {
          cumulative: newCumulative,
          recent_28d: recent28d,
          last_evaluated_batch: cutoffStr,
        },
        collected_at: new Date().toISOString(),
      },
      { onConflict: 'category' }
    );

    console.log(`[accuracy] ${category} 적중: ${matched}/${predictedKeywords.length} (${recent28d.accuracy}%)`);
    return recent28d;
  } catch(e) {
    console.error(`[accuracy] ${category} 실패:`, e.message);
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
// 6글자 이상 복합어는 분해 부분 매칭 추가 (예: '야장감성' = '야장'+'감성')
function textMatchKeyword(text, keyword) {
  const t = normalize(text).toLowerCase();
  const k = normalize(keyword).toLowerCase();
  if (t.includes(k)) return true;
  if (k.length >= 6) {
    const parts = [];
    for (let i = 0; i < k.length; i += 2) {
      parts.push(k.slice(i, Math.min(i + 3, k.length)));
    }
    const matches = parts.filter(p => p.length >= 2 && t.includes(p));
    if (matches.length >= Math.ceil(parts.length / 2)) return true;
  }
  return false;
}

function buildCrossSourceCount({ keyword, naverData, blogData, ytKR, igTexts, googleKR, newsData, communityData }) {
  function countMatches(arr) {
    if (!arr) return 0;
    return arr.filter(t => textMatchKeyword(String(t), keyword)).length;
  }

  return {
    datalab: countMatches(naverData),
    blog: countMatches(blogData),
    youtube: countMatches(ytKR),
    ig: countMatches(igTexts),
    google: countMatches(googleKR),
    news: countMatches(newsData),
    community: countMatches(communityData),
  };
}

// ─────────────────────────────────────────────
// Velocity 계산
// DB에서 전날(7일 전) 스냅샷 조회해 증가율 산출
// ─────────────────────────────────────────────
async function computeVelocity({ supa, keyword, category, todayCount, todayRank }) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // 1차: trend_keywords
    const { data, error } = await supa
      .from('trend_keywords')
      .select('weighted_score, collected_date')
      .eq('keyword', keyword)
      .eq('category', category)
      .gte('collected_date', cutoff)
      .lt('collected_date', today)
      .order('collected_date', { ascending: false })
      .limit(1);

    if (error) console.error(`[velocity] ${category}/${keyword} tier1 err:`, error.message);

    if (!error && data && data.length > 0) {
      const prevScore = Number(data[0].weighted_score);
      if (prevScore > 0) {
        const pct = ((todayCount - prevScore) / prevScore) * 100;
        const v = Math.max(-100, Math.min(2000, Math.round(pct * 10) / 10));
        console.log(`[velocity] ${category}/${keyword} tier1 OK prev=${prevScore} today=${todayCount} v=${v}`);
        return v;
      }
    }

    // 2차: legacy prev 스냅샷 (rank 기반 근사)
    const prevKey = `l30d-domestic-prev:${category}`;
    const { data: prev, error: prevErr } = await supa
      .from('trends')
      .select('keywords')
      .eq('category', prevKey)
      .maybeSingle();

    if (prevErr) console.error(`[velocity] ${category}/${keyword} tier2 err:`, prevErr.message);

    const prevArr = prev?.keywords?.keywords;
    if (!Array.isArray(prevArr)) {
      console.log(`[velocity] ${category}/${keyword} tier2 miss: prevArr=${typeof prevArr}, prevObj keys=${prev ? Object.keys(prev.keywords || {}).join(',') : 'none'}`);
      return null;
    }

    const prevItem = prevArr.find(k =>
      normalize(k.keyword || '').toLowerCase() === normalize(keyword).toLowerCase()
    );
    if (!prevItem) {
      // 이전 스냅샷에 없음 (신규 키워드) — 신규는 velocity 측정 불가, 그러나 rank 기반 추정값 제공
      // 신규 키워드는 일반적으로 급상승 상태로 간주 → todayRank 기반 긍정 velocity 반환
      const estimated = Math.max(50, Math.min(300, 300 - (todayRank || 0) * 20));
      console.log(`[velocity] ${category}/${keyword} tier2 new kw: estimated=${estimated}`);
      return estimated;
    }

    const prevScore = Number(prevItem.score || 0);
    if (prevScore <= 0) return null;

    const todayScoreProxy = 100 - (todayRank || 0) * 5;
    const pct = ((todayScoreProxy - prevScore) / prevScore) * 100;
    return Math.max(-100, Math.min(2000, Math.round(pct * 10) / 10));
  } catch(e) {
    console.error(`[velocity] ${category}/${keyword} 예외:`, e.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// 가중치 스코어 계산
// ─────────────────────────────────────────────
function computeWeightedScore(counts) {
  let score = 0;
  for (const [src, cnt] of Object.entries(counts)) {
    if (cnt > 0) {
      score += (SOURCE_WEIGHTS[src] || 1) * Math.log(cnt + 1);  // log 스케일로 급증 완화
    }
  }
  return Math.round(score * 10) / 10;
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
async function saveTrendKeywordsV2({ supa, category, enrichedKeywords, collectedDate, region = 'all' }) {
  if (!enrichedKeywords || enrichedKeywords.length === 0) return;

  // sources: counts object → { datalab: 3, blog: 15, ... } 형태로 jsonb 저장
  const rows = enrichedKeywords.map(item => {
    const sourcesObj = item.counts || {};
    // axis: Phase 2 분류 결과 (menu/interior/goods/experience) 또는 'general' 기본값
    // 'domestic'은 이 컬럼 의미와 충돌하므로 사용 안 함
    const axis = item.axis || 'general';
    return {
      keyword: item.keyword,
      category,
      axis,
      sub_category: '',  // empty string (NULL 회피 — 인덱스 dedup 일관성)
      region,            // 지역 분할 (Phase 1: 항상 'all', Phase 2에서 지역별 수집 시 변경)
      collected_date: collectedDate,
      signal_tier: item.signalTier,
      cross_source_count: item.crossSourceCount,
      weighted_score: item.weightedScore,
      velocity_pct: item.velocityPct,
      sources: sourcesObj,  // DB 스키마의 sources jsonb 컬럼
      narrative: item.narrative || null,
      origin: item.origin || null,
      raw_mentions: {
        saturation_total: item.saturationTotal ?? null,
        saturation_level: item.saturationLevel ?? null,
      },
    };
  });

  try {
    // delete + insert 패턴 (daily overwrite)
    // Phase 2: axis가 general/menu/interior/goods/experience 모두 포함하여 삭제
    // region 포함하여 삭제 (같은 region 데이터만 overwrite)
    await supa
      .from('trend_keywords')
      .delete()
      .eq('category', category)
      .eq('collected_date', collectedDate)
      .eq('region', region)
      .in('axis', ['general', 'menu', 'interior', 'goods', 'experience', 'domestic']);

    await supa
      .from('trend_keywords')
      .insert(rows);

    console.log(`[trend_keywords] ${category}/${region} ${rows.length}건 저장`);
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
    // Netlify 스케줄 이벤트는 httpMethod='POST' + body에 next_run 포함
    const bodyObj = (() => { try { return JSON.parse(event?.body || '{}'); } catch(_) { return {}; } })();
    const isScheduled = !event || !event.httpMethod || !!bodyObj.next_run;
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

    // 서비스 전체 예산 체크 (cron — 9개 카테고리 × ₩5 = ₩45 추정)
    try {
      await checkAndIncrementQuota(null, 'gpt-4o-mini', categories.length * 5);
    } catch (e) {
      if (e instanceof QuotaExceededError) {
        console.warn('[trends-v2] 서비스 전체 OpenAI 예산 초과 — cron 중단:', e.message);
        return { statusCode: 429, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: e.message, skipped: true }) };
      }
      throw e;
    }

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
      const [naverData, blogData, ytKR, igTexts, newsData, communityData] = await Promise.all([
        fetchNaverDatalab(category),
        fetchNaverBlogs(category),
        fetchYouTube(category),
        fetchInstagram(supa, category),
        fetchNaverNews(category),  // 신규: 뉴스 소스
        fetchCommunityData(supa, category),  // 커뮤니티 트렌드 (맘카페·디시·더쿠 등)
      ]);
      console.log(`[${category}] naver=${naverData.length} blog=${blogData.length} yt-kr=${ytKR.length} ig=${igTexts.length} news=${newsData.length} community=${communityData.length}`);
      return [category, { naverData, blogData, ytKR, igTexts, newsData, communityData }];
    }));
    const rawByCategory = Object.fromEntries(rawEntries);

    // ─── 2단계: 크로스 소스 맵 구축 ─────────────
    await ctx.stage('cross-source', {});

    // ─── 3단계: GPT 분류 ────────────────────────
    await ctx.stage('classification', {});

    // 3-a) 네이버 검색광고 연관키워드 도구로 시드 자동 확장 (env 부재 시 noop, silent fallback)
    //      카테고리당 시드 3개 → 연관 키워드 + 월 검색량 → GPT 분류 raw 데이터에 합류.
    //      lumi 의 NAVER_KEYWORDS 하드코딩 의존도를 줄이고 실제 검색 트래픽 기반 신호 도입.
    const adKeywordsByCat = {};
    await Promise.all(categories.map(async (cat) => {
      const seeds = (NAVER_KEYWORDS[cat] || [])
        .slice(0, 3)
        .map(g => (g.keywords || [])[0])
        .filter(Boolean);
      if (seeds.length === 0) return;
      try {
        const related = await fetchRelatedFromSeeds(seeds, { limit: 60 });
        if (related.length > 0) adKeywordsByCat[cat] = related;
      } catch (e) {
        console.warn(`[naver-ad] ${cat} 실패:`, e.message);
      }
    }));

    const domesticTexts = {};
    for (const cat of categories) {
      const r = rawByCategory[cat];
      const adKeywords = adKeywordsByCat[cat] || [];
      const adTexts = adKeywords.map(k => `${k.keyword} (월간검색 ${k.monthlyTotal})`);
      domesticTexts[cat] = [
        ...r.naverData,
        ...r.blogData,
        ...r.ytKR,
        ...googleKR,
        ...r.igTexts,
        ...(r.newsData || []),
        ...(r.communityData || []),  // 커뮤니티 트렌드 (맘카페·디시·더쿠 등)
        ...adTexts,                   // 검색광고 연관키워드 (env 있을 때만)
      ];
    }

    let domesticClassified = null;
    if (process.env.OPENAI_API_KEY) {
      domesticClassified = await classifyBatchWithGPT({ rawTextsByCategory: domesticTexts });
    }

    // ─── 4단계: 스코어링 ───────────
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
        // fallback 제거 — 데이터 없으면 빈 배열 유지 (사용자 지시: 정보 없으면 빈 상태가 낫다)
        if (domesticTags.length >= 10) {
          domesticTags = domesticTags.slice(0, 10);
        }
        // 빈 배열이어도 save는 진행 (빈 상태 노출)

        // v2 스코어링 (isV2Cat인 경우에만)
        let enrichedKeywords = [];
        if (isV2Cat) {
          enrichedKeywords = await Promise.all(domesticTags.map(async (keyword, idx) => {
            const counts = buildCrossSourceCount({
              keyword,
              naverData: r.naverData,
              blogData: r.blogData,
              ytKR: r.ytKR,
              igTexts: r.igTexts,
              googleKR,
              newsData: r.newsData,
              communityData: r.communityData,
            });

            const crossSourceCount = Object.values(counts).filter(c => c > 0).length;
            const signalTier = crossSourceCount >= 2 ? 'real' : 'weak';
            const weightedScore = computeWeightedScore(counts);
            const todayScore = 100 - idx * 5;
            // velocity 2-tier: trend_keywords weighted_score 우선, 실패시 legacy rank 스냅샷 fallback
            const velocityPct = await computeVelocity({ supa, keyword, category, todayCount: weightedScore, todayRank: idx });
            const saturationTotal = await fetchKeywordSaturation(keyword);
            const saturationLevel = classifySaturation(saturationTotal);

            return {
              keyword,
              score: todayScore,
              crossSourceCount,
              signalTier,
              weightedScore,
              velocityPct,
              counts,
              saturationTotal,
              saturationLevel,
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
              return saveTrendKeywordsV2({ supa, category, enrichedKeywords, collectedDate, region: 'all' });
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
          // fallback 제거 — domesticTags만 사용, 없으면 빈 배열 허용
          const pool = domesticTags.slice(0, 10);
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
          // 날짜별 스냅샷 저장 (28일 후 적중률 검증용)
          const todaySnap = updatedAt.slice(0, 10);
          await supa.from('trends').upsert(
            { category: `l30d-rising:${category}:${todaySnap}`, keywords: { items: risingItems, updatedAt, source: 'gpt-prediction' }, collected_at: updatedAt },
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

    // ─── 9단계: 예측 적중률 평가 (28일 전 예측 vs 오늘 실제) ─────
    await ctx.stage('accuracy-evaluation', {});
    await Promise.all(categories.map(async (cat) => {
      await evaluatePredictionAccuracy({ supa, category: cat });
    }));

    console.log('[trends-v2] 완료:', JSON.stringify(results));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: true, updatedAt, results, version: 'v2' }),
    };
  },
});
