// categories.js — 대분류 ↔ 세부 카테고리 매핑 (프론트엔드 공용)
// 백엔드는 9개 세부 카테고리(cafe/food/hair/nail/beauty/fashion/flower/fitness/pet) 그대로.
// 프론트엔드 UI에서 5개 대분류로 묶어 보여준다 (네이버 쇼핑인사이트 분류 참고).
// "소매" 가 너무 광범위해서 패션을 독립 분리, 플라워·펫은 라이프로 묶음.

(function () {
  const MAJOR_GROUPS = [
    {
      id: 'cafe',
      label: '카페',
      subs: [
        { id: 'cafe', label: '카페' },
      ],
    },
    {
      id: 'food',
      label: '식당',
      subs: [
        { id: 'food', label: '식당' },
      ],
    },
    {
      id: 'hair',
      label: '헤어',
      subs: [
        { id: 'hair', label: '헤어' },
      ],
    },
    {
      id: 'nail',
      label: '네일',
      subs: [
        { id: 'nail', label: '네일' },
      ],
    },
    {
      id: 'beauty',
      label: '뷰티',
      subs: [
        { id: 'beauty', label: '뷰티' },
      ],
    },
    {
      id: 'fashion_group',
      label: '패션',
      subs: [
        // 서브카테고리 분기: parent + subcat 필드. trends.html fetchGroupTrends 가
        // ?category=fashion&subcat=clothing 형태로 호출 → get-trends.js 가
        // trend_keywords.sub_category 컬럼 필터.
        // GPT 분류기는 fashion 키워드 분류 시 sub_category='clothing'|'footwear' 마킹.
        { id: 'fashion-clothing', label: '옷',    parent: 'fashion', subcat: 'clothing' },
        { id: 'fashion-footwear', label: '신발',  parent: 'fashion', subcat: 'footwear' },
      ],
    },
    {
      id: 'wellness',
      label: '운동·레저',
      subs: [
        { id: 'fitness', label: '운동' },
      ],
    },
    {
      id: 'life',
      label: '라이프',
      subs: [
        { id: 'flower', label: '플라워' },
      ],
    },
  ];

  // sub id → 대분류 id 역매핑
  const SUB_TO_MAJOR = {};
  for (const g of MAJOR_GROUPS) for (const s of g.subs) SUB_TO_MAJOR[s.id] = g.id;

  // sub id → sub label
  const SUB_LABEL = {};
  for (const g of MAJOR_GROUPS) for (const s of g.subs) SUB_LABEL[s.id] = s.label;

  function findMajorBySub(subId) {
    return MAJOR_GROUPS.find(g => g.subs.some(s => s.id === subId)) || MAJOR_GROUPS[0];
  }

  function findGroup(majorId) {
    return MAJOR_GROUPS.find(g => g.id === majorId) || MAJOR_GROUPS[0];
  }

  window.LumiCategories = {
    MAJOR_GROUPS,
    SUB_TO_MAJOR,
    SUB_LABEL,
    findMajorBySub,
    findGroup,
    defaultSub: 'cafe',
  };
})();
