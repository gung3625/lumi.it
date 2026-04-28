// holiday.js — 공휴일 정보 (공공데이터포털 + 하드코드 fallback)
// Tier 0, 캐싱 30일

const { makeCacheKey, getCached, setCached } = require('../llm-cache');

// 2026 한국 공휴일 (하드코드 fallback)
const HOLIDAYS_2026 = [
  { date: '2026-01-01', name: '신정' },
  { date: '2026-02-16', name: '설날 연휴' },
  { date: '2026-02-17', name: '설날' },
  { date: '2026-02-18', name: '설날 연휴' },
  { date: '2026-03-01', name: '삼일절' },
  { date: '2026-03-02', name: '삼일절 대체' },
  { date: '2026-05-05', name: '어린이날' },
  { date: '2026-05-24', name: '부처님오신날' },
  { date: '2026-06-03', name: '제20대 대선' },
  { date: '2026-06-06', name: '현충일' },
  { date: '2026-08-15', name: '광복절' },
  { date: '2026-09-24', name: '추석 연휴' },
  { date: '2026-09-25', name: '추석' },
  { date: '2026-09-26', name: '추석 연휴' },
  { date: '2026-10-03', name: '개천절' },
  { date: '2026-10-09', name: '한글날' },
  { date: '2026-12-25', name: '크리스마스' },
];

const HOLIDAYS_2027 = [
  { date: '2027-01-01', name: '신정' },
  { date: '2027-02-06', name: '설날 연휴' },
  { date: '2027-02-07', name: '설날' },
  { date: '2027-02-08', name: '설날 연휴' },
  { date: '2027-03-01', name: '삼일절' },
  { date: '2027-05-05', name: '어린이날' },
];

function getHolidaysForYear(year) {
  if (year === 2026) return HOLIDAYS_2026;
  if (year === 2027) return HOLIDAYS_2027;
  return [];
}

/**
 * 다가오는 공휴일 N개 반환
 */
async function getUpcoming({ count = 3 } = {}) {
  const cacheKey = makeCacheKey({ kind: 'holiday', input: `upcoming-${count}`, tier: 0 });
  const cached = await getCached(cacheKey);
  if (cached) return { ...cached, cached: true };

  const today = new Date().toISOString().slice(0, 10);
  const all = [...HOLIDAYS_2026, ...HOLIDAYS_2027];
  const upcoming = all
    .filter(h => h.date >= today)
    .slice(0, count)
    .map(h => {
      const days = Math.ceil((new Date(h.date).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24));
      return { ...h, daysUntil: days };
    });

  const result = {
    ok: true,
    upcoming,
    summary: upcoming.length > 0
      ? upcoming.map(h => `${h.name} (D-${h.daysUntil})`).join(' · ')
      : '곧 다가오는 공휴일이 없어요',
  };
  await setCached(cacheKey, result, { kind: 'holiday', tier: 0 });
  return result;
}

/**
 * 특정 키워드 매칭 (예: "어린이날", "추석")
 */
async function findByName(name) {
  const today = new Date().toISOString().slice(0, 10);
  const all = [...HOLIDAYS_2026, ...HOLIDAYS_2027];
  const matched = all
    .filter(h => h.date >= today && h.name.includes(name.replace(/\s/g, '')))
    .map(h => {
      const days = Math.ceil((new Date(h.date).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24));
      return { ...h, daysUntil: days };
    });

  return {
    ok: matched.length > 0,
    matched,
    summary: matched.length > 0
      ? `${matched[0].name}: ${matched[0].date} (D-${matched[0].daysUntil})`
      : `"${name}" 관련 공휴일을 찾지 못했어요`,
  };
}

module.exports = { getUpcoming, findByName, HOLIDAYS_2026, HOLIDAYS_2027 };
