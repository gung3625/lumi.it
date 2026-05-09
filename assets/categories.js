// categories.js — 대분류 ↔ 세부 카테고리 매핑 (프론트엔드 공용)
// 백엔드는 9개 세부 카테고리(cafe/food/hair/nail/beauty/fashion/flower/fitness/pet) 그대로.
// 프론트엔드 UI에서만 4개 대분류로 묶어 보여준다.

(function () {
  const MAJOR_GROUPS = [
    {
      id: 'foodservice',
      label: '외식',
      subs: [
        { id: 'cafe', label: '카페' },
        { id: 'food', label: '식당' },
      ],
    },
    {
      id: 'beauty_service',
      label: '미용',
      subs: [
        { id: 'hair',   label: '미용실' },
        { id: 'nail',   label: '네일' },
        { id: 'beauty', label: '뷰티' },
      ],
    },
    {
      id: 'retail',
      label: '소매',
      subs: [
        { id: 'fashion', label: '옷가게' },
        { id: 'flower',  label: '플라워' },
        { id: 'pet',     label: '펫' },
      ],
    },
    {
      id: 'wellness',
      label: '운동·레저',
      subs: [
        { id: 'fitness', label: '운동' },
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
