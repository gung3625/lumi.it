// naver-ad-keyword-tool.js — 네이버 검색광고 API "연관 키워드 도구" 호출 헬퍼
//
// 공식 문서: https://naver.github.io/searchad-apidoc/#/operations/GET/~2Fkeywordstool
// 엔드포인트: GET https://api.searchad.naver.com/keywordstool?hintKeywords=...&showDetail=1
// 인증: HMAC-SHA256 ( signature = HMAC(secret, `${timestamp}.${method}.${uri}`) → base64 )
// 헤더: X-Timestamp, X-API-KEY (액세스 라이센스), X-Customer, X-Signature
//
// 환경변수 (모두 있어야 호출 시도, 하나라도 부재 시 noop 으로 빈 배열 반환):
//   NAVER_AD_API_KEY       — 검색광고 액세스 라이센스
//   NAVER_AD_API_SECRET    — 검색광고 시크릿 키
//   NAVER_AD_CUSTOMER_ID   — 검색광고 CUSTOMER ID (숫자 문자열)
//
// 시드 1개 당 최대 1000개 연관 키워드 + 월간 검색량(PC/모바일/전체) 반환.
// lumi 의 NAVER_KEYWORDS 하드코딩 의존도를 줄이고 GPT 추출 단계에 더 풍부한 raw 데이터 공급.

'use strict';

const crypto = require('crypto');
const https = require('https');

const HOST = 'api.searchad.naver.com';
const PATH = '/keywordstool';

function sign(secret, timestamp, method, uri) {
  const message = `${timestamp}.${method}.${uri}`;
  return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

function httpsGet({ hostname, path, headers, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'GET', headers, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode || 0, body });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('naver-ad-keyword-tool: timeout')); });
    req.end();
  });
}

/**
 * 시드 키워드 1개로 네이버 검색광고 연관 키워드 조회.
 *
 * @param {string} seedKeyword — 시드 키워드 (한글 또는 영문)
 * @returns {Promise<Array<{keyword: string, monthlyTotal: number, monthlyPc: number, monthlyMobile: number, competitionIdx: string}>>}
 *          환경변수 부재 / 실패 / API 에러 모두 빈 배열 반환 (silent fallback).
 */
async function fetchRelatedKeywords(seedKeyword) {
  const apiKey   = process.env.NAVER_AD_API_KEY;
  const secret   = process.env.NAVER_AD_API_SECRET;
  const customer = process.env.NAVER_AD_CUSTOMER_ID;
  if (!apiKey || !secret || !customer) return [];

  if (!seedKeyword || typeof seedKeyword !== 'string') return [];
  const hint = seedKeyword.trim();
  if (hint.length === 0 || hint.length > 50) return [];

  const timestamp = String(Date.now());
  const signature = sign(secret, timestamp, 'GET', PATH);
  const queryPath = `${PATH}?hintKeywords=${encodeURIComponent(hint)}&showDetail=1`;

  let res;
  try {
    res = await httpsGet({
      hostname: HOST,
      path: queryPath,
      headers: {
        'X-Timestamp': timestamp,
        'X-API-KEY': apiKey,
        'X-Customer': customer,
        'X-Signature': signature,
        'Accept': 'application/json',
      },
    });
  } catch (e) {
    console.warn('[naver-ad-keyword-tool] HTTP 실패:', e.message);
    return [];
  }

  if (res.status !== 200) {
    console.warn(`[naver-ad-keyword-tool] non-200: ${res.status} body=${(res.body || '').slice(0, 200)}`);
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch (e) {
    console.warn('[naver-ad-keyword-tool] JSON parse 실패');
    return [];
  }

  const list = Array.isArray(parsed?.keywordList) ? parsed.keywordList : [];
  const out = [];
  for (const item of list) {
    const kw = (item.relKeyword || '').trim();
    if (!kw) continue;
    const pc = parseInt(item.monthlyPcQcCnt, 10) || 0;
    const mo = parseInt(item.monthlyMobileQcCnt, 10) || 0;
    out.push({
      keyword: kw,
      monthlyTotal: pc + mo,
      monthlyPc: pc,
      monthlyMobile: mo,
      competitionIdx: item.compIdx || null,
    });
  }
  return out;
}

/**
 * 여러 시드를 받아 각 시드별로 연관 키워드를 병렬 조회 후 통합.
 * 중복 키워드는 monthlyTotal 큰 값으로 보존. 결과는 monthlyTotal 내림차순 정렬.
 *
 * @param {string[]} seeds
 * @param {{ limit?: number }} [options]  default limit=80
 * @returns {Promise<Array>}  병합된 연관 키워드 (limit 까지)
 */
async function fetchRelatedFromSeeds(seeds, options = {}) {
  const limit = options.limit || 80;
  if (!Array.isArray(seeds) || seeds.length === 0) return [];

  const results = await Promise.all(seeds.slice(0, 10).map(fetchRelatedKeywords));
  const merged = new Map();
  for (const list of results) {
    for (const item of list) {
      const key = item.keyword;
      const existing = merged.get(key);
      if (!existing || (item.monthlyTotal || 0) > (existing.monthlyTotal || 0)) {
        merged.set(key, item);
      }
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => (b.monthlyTotal || 0) - (a.monthlyTotal || 0))
    .slice(0, limit);
}

/**
 * 단일 키워드의 월간 검색량 (PC + 모바일) 조회.
 *
 * 네이버 검색광고 API 는 hint 키워드를 받으면 응답에 hint 자체의 통계도 포함.
 * 정확 매칭 또는 normalized 매칭으로 hint 자체의 monthlyTotal 추출.
 *
 * @param {string} keyword
 * @returns {Promise<{monthlyTotal: number, monthlyPc: number, monthlyMobile: number, competitionIdx: string|null}|null>}
 *          매칭 없으면 null. env 부재 / API 실패 시도 null.
 */
async function fetchKeywordSearchVolume(keyword) {
  if (!keyword || typeof keyword !== 'string') return null;
  const list = await fetchRelatedKeywords(keyword);
  if (!Array.isArray(list) || list.length === 0) {
    return null;
  }

  // 정확 매칭 우선. 공백·대소문자 무관 normalized 매칭 fallback.
  const normTarget = keyword.replace(/\s+/g, '').toLowerCase();
  let hit = list.find(item => item.keyword === keyword);
  let matchType = 'exact';
  if (!hit) {
    hit = list.find(item => item.keyword.replace(/\s+/g, '').toLowerCase() === normTarget);
    matchType = hit ? 'normalized' : '';
  }
  if (!hit) {
    return null;
  }
  // monthlyTotal 100 미만이면 valid 매칭 아님 (검증 2026-05-13).
  //   - 이전: monthlyTotal === 0 만 거부 → 의미 없는 root_morpheme 매칭 (검색량
  //     10~30) 이 통과해 사장님 화면 TOP 10 에 noise 노출.
  //   - 신규: 한국 월 검색량 100 회 미만 = 거의 검색 없음 = 트렌드로 의미 없음.
  //     reject 하고 Layer 2/3 다음 candidate 시도.
  if (!Number.isFinite(hit.monthlyTotal) || hit.monthlyTotal < 100) {
    return null;
  }
  return {
    monthlyTotal: hit.monthlyTotal,
    monthlyPc: hit.monthlyPc,
    monthlyMobile: hit.monthlyMobile,
    competitionIdx: hit.competitionIdx,
    matchType,
    rootKeyword: keyword,
  };
}

/**
 * 한국어 product/style suffix 사전 — 카테고리별 product noun.
 *
 * splitCompoundKorean 이 키워드 끝에서 이 사전의 형태소를 만나면 그걸 1순위
 * candidate 으로 시도. 일반 휴리스틱 (4/3/2-syllable slice) 보다 우선.
 *
 * 추가 시 product noun 만 (브랜드/형용사 X). 길이 desc 로 매칭.
 */
const KO_PRODUCT_SUFFIXES = [
  // 5 syllables
  '드라이플라워', '버뮤다팬츠',
  // 4 syllables
  '스트레이트', '러닝화신상', '레이스탑', '롱원피스', '미니원피스',
  '필라테스', '디퓨저향', '아이라이너', '브래지어', '맞춤정장',
  // 3 syllables
  '아메리카', '러닝화', '에센스', '클렌저', '스니커즈', '레깅스', '오마카세',
  '스커트', '재킷', '점퍼', '코트', '셔츠', '블라우스', '원피스', '청바지',
  '브라운', '하이라이트', '립스틱', '메이크업', '아이라인',
  '디저트', '케이크', '쿠키', '스무디', '마카롱', '크로플', '베이글',
  '하네스', '간식바', '장난감', '캣타워', '캣휠',
  '프라이빗', '케틀벨', '레그프레', '인터벌',
  // 2 syllables — 가장 일반 product noun
  '세럼', '앰플', '크림', '토너', '미스트', '마스크', '에센스', '쿠션',
  '컷트', '컷', '펌', '단발', '염색',
  '네일', '젤네일',
  '신상', '팬츠', '신발', '운동화', '샌들', '구두', '가방', '백',
  '라떼', '커피', '빵', '메뉴',
  '사료', '간식', '용품',
  '요가', '러닝', '스윙', '루틴', '운동', '머신', '사이클', '크로스', '클래스',
  '꽃집', '부케', '리스', '향기', '장미', '튤립', '꽃다발',
  '향수', '디퓨저', '캔들', '인센스',
];

/**
 * 한국어 합성어 분해 — Netlify Functions 환경에서 native NLP 못 쓰므로 휴리스틱.
 *
 * 전략 (긴 root 우선 = 더 구체적 검색량 추정):
 *   0) KO_PRODUCT_SUFFIXES 사전 매칭 — 키워드 끝이 product noun 이면 그 noun 우선
 *      (예: "자라데님스커트" → "스커트", "에코피니티세럼" → "세럼")
 *   1) 4-syllable suffix / prefix
 *   2) 3-syllable suffix / prefix
 *   3) 2-syllable suffix / prefix (가장 일반, 마지막 fallback)
 *
 * 응답: 후보 substrings sorted by 길이 desc, 단 사전 매칭은 항상 1순위.
 *
 * 너무 많은 후보는 API 비용 ↑ 이라 maxCandidates 로 제한.
 */
function splitCompoundKorean(keyword, maxCandidates = 12) {
  if (!keyword || keyword.length < 4) return [];
  const k = keyword.replace(/\s+/g, '');
  const len = k.length;

  // Layer 0 — 사전 suffix 매칭 (1순위)
  const priorityHits = [];
  for (const suffix of KO_PRODUCT_SUFFIXES) {
    if (suffix.length < len && k.endsWith(suffix)) {
      priorityHits.push(suffix);
    }
  }
  // 길이 desc — 긴 매칭이 더 구체적
  priorityHits.sort((a, b) => b.length - a.length);

  const subs = new Set(priorityHits);

  // Layer 1 — 일반 휴리스틱 (suffix/prefix 4·3·2 syllable)
  for (let l = 4; l >= 2; l--) {
    if (l < len) {
      subs.add(k.slice(-l));    // suffix
      subs.add(k.slice(0, l));  // prefix (보조)
    }
  }

  // Layer 2 — Middle 부분 (5음절+ 합성어)
  if (len >= 6) {
    for (let l = 4; l >= 3; l--) {
      for (let s = 1; s <= len - l - 1; s++) {
        subs.add(k.slice(s, s + l));
        if (subs.size >= maxCandidates * 2) break;
      }
    }
  }

  // 길이 desc 정렬 — 단 priorityHits 는 사전 등록 순서로 앞에 유지
  const result = [];
  for (const p of priorityHits) result.push(p);
  for (const s of Array.from(subs).filter(s => !priorityHits.includes(s)).sort((a, b) => b.length - a.length)) {
    result.push(s);
  }
  return result.filter(s => s.length >= 2 && s !== k).slice(0, maxCandidates);
}

/**
 * 검색량 조회 with multi-layer fallback.
 *
 * Layer 1: exact / normalized 매칭 (fetchKeywordSearchVolume)
 * Layer 2: 한국어 합성어 분해 → root 키워드별 시도. 매칭 성공 시 monthlyTotal +
 *          rootKeyword 메타 반환. 사용자 UI 가 "유사 키워드 기준" 라벨 노출 가능.
 *
 * Layer 3 (DataLab ratio 환산) 은 scheduled-trends-v2-background 의 cron 에서
 * 별도 호출 (anchor 키워드 카테고리별 관리 필요해 helper 책임 분리).
 *
 * @param {string} keyword
 * @returns {Promise<object|null>}
 *   { monthlyTotal, monthlyPc, monthlyMobile, competitionIdx, matchType, rootKeyword }
 *   matchType: 'exact' | 'normalized' | 'root_morpheme' | (null = Layer 3 위임)
 */
async function fetchKeywordSearchVolumeRobust(keyword) {
  // Layer 1
  const exact = await fetchKeywordSearchVolume(keyword);
  if (exact) {
    console.log(`[search-volume] ${exact.matchType} match "${keyword}" → ${exact.monthlyTotal}`);
    return exact;
  }

  // Layer 2: 합성어 분해 — 긴 root 부터 시도
  const candidates = splitCompoundKorean(keyword);
  for (const candidate of candidates) {
    const sub = await fetchKeywordSearchVolume(candidate);
    if (sub) {
      console.log(`[search-volume] root_morpheme "${keyword}" → root="${candidate}" → ${sub.monthlyTotal}`);
      return {
        monthlyTotal: sub.monthlyTotal,
        monthlyPc: sub.monthlyPc,
        monthlyMobile: sub.monthlyMobile,
        competitionIdx: sub.competitionIdx,
        matchType: 'root_morpheme',
        rootKeyword: candidate,
      };
    }
  }

  console.warn(`[search-volume] all layers failed for "${keyword}" (candidates tried: ${candidates.length})`);
  return null;
}

module.exports = {
  fetchRelatedKeywords,
  fetchRelatedFromSeeds,
  fetchKeywordSearchVolume,
  fetchKeywordSearchVolumeRobust,
  splitCompoundKorean,
  KO_PRODUCT_SUFFIXES,
};
