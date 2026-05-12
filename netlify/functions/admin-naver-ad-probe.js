// admin-naver-ad-probe.js — 네이버 검색광고 API 활성화 검증용 임시 엔드포인트
//
// GET /api/admin-naver-ad-probe?keyword=KEYWORD
//   헤더 X-Lumi-Secret: ${LUMI_SECRET}
//
// 동작:
//   1) NAVER_AD_API_KEY / NAVER_AD_API_SECRET / NAVER_AD_CUSTOMER_ID 환경변수 존재 여부 확인
//   2) 시드 1~3개로 fetchRelatedFromSeeds 호출
//   3) 받은 연관 키워드 상위 10개 + 월간 검색량 반환
//
// 의도: 검색광고 API 활성화 직후 cron 자정까지 기다리지 않고 즉시 검증.

'use strict';

const { fetchRelatedFromSeeds, fetchKeywordSearchVolume } = require('./_shared/naver-ad-keyword-tool');

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }

  const secret = (event.headers && (event.headers['x-lumi-secret'] || event.headers['X-Lumi-Secret'])) || '';
  if (!process.env.LUMI_SECRET || secret !== process.env.LUMI_SECRET) {
    return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: '인증 실패' }) };
  }

  const params = new URLSearchParams(event.rawQuery || '');
  const seedRaw = (params.get('keyword') || '카페').trim();
  const seeds = seedRaw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 3);

  const envState = {
    NAVER_AD_API_KEY: !!process.env.NAVER_AD_API_KEY,
    NAVER_AD_API_SECRET: !!process.env.NAVER_AD_API_SECRET,
    NAVER_AD_CUSTOMER_ID: !!process.env.NAVER_AD_CUSTOMER_ID,
  };
  const allConfigured = envState.NAVER_AD_API_KEY && envState.NAVER_AD_API_SECRET && envState.NAVER_AD_CUSTOMER_ID;

  if (!allConfigured) {
    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ ok: false, reason: '환경변수 미설정', envState }),
    };
  }

  const startedAt = Date.now();
  let related = [];
  let error = null;
  try {
    related = await fetchRelatedFromSeeds(seeds, { limit: 80 });
  } catch (e) {
    error = e.message || String(e);
  }

  // PR #173 의 fetchKeywordSearchVolume 도 동시 테스트 — cron 에서 null 반환 원인 디버그.
  // 각 seed 에 대해 단일 키워드 검색량 조회 시도.
  const volumeResults = [];
  for (const s of seeds) {
    try {
      const v = await fetchKeywordSearchVolume(s);
      volumeResults.push({ keyword: s, volume: v });
    } catch (e) {
      volumeResults.push({ keyword: s, volume: null, error: e.message });
    }
  }

  const elapsedMs = Date.now() - startedAt;

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      ok: !error && related.length > 0,
      seeds,
      total: related.length,
      sample: related.slice(0, 10),
      volumeResults,
      elapsedMs,
      error,
      envState,
    }, null, 2),
  };
};
