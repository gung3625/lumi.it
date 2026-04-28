// naver-shopping-insight.test.js — Node 내장 assert 기반 단위 테스트
// 실행: node netlify/functions/_shared/__tests__/naver-shopping-insight.test.js
//
// 9개 엔드포인트 + 에러 처리 + 정규화 + 분포 요약 검증
// 외부 네트워크 호출 0회 (모든 호출은 _setHttpClient로 모킹)

const assert = require('node:assert/strict');
const path = require('node:path');

const modulePath = path.resolve(__dirname, '..', 'naver-shopping-insight.js');
const lib = require(modulePath);

// 테스트용 환경변수 (시크릿 아님, 모킹 호출만)
process.env.NAVER_CLIENT_ID = 'test_client_id';
process.env.NAVER_CLIENT_SECRET = 'test_client_secret';

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
  }
}

// 모킹 응답 빌더 — 네이버 데이터랩 표준 응답
function mockResponse(results) {
  return {
    status: 200,
    body: JSON.stringify({
      startDate: '2026-03-29',
      endDate: '2026-04-28',
      timeUnit: 'date',
      results,
    }),
  };
}

function mockTimeSeriesResult(title, samples = 3) {
  return {
    title,
    keyword: [title],
    data: Array.from({ length: samples }, (_, i) => ({
      period: `2026-04-${String(20 + i).padStart(2, '0')}`,
      ratio: 50 + i * 5,
    })),
  };
}

(async () => {
  console.log('=== naver-shopping-insight unit tests ===\n');

  // ────────────────────────────────────────
  // B 그룹 4종
  // ────────────────────────────────────────
  await test('B/1: fetchCategoryTrend — 분야 클릭 추이 정규화', async () => {
    let captured = null;
    lib._setHttpClient(async (path, headers, body) => {
      captured = { path, headers, body };
      return mockResponse([mockTimeSeriesResult('패션의류')]);
    });
    const res = await lib.fetchCategoryTrend({
      categoryCode: '50000000',
      categoryName: '패션의류',
      startDate: '2026-03-29',
      endDate: '2026-04-28',
    });
    lib._resetHttpClient();

    assert.equal(captured.path, '/v1/datalab/shopping/categories');
    assert.equal(captured.headers['X-Naver-Client-Id'], 'test_client_id');
    assert.equal(captured.headers['X-Naver-Client-Secret'], 'test_client_secret');
    assert.equal(res.metricType, 'category_overall');
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].title, '패션의류');
    assert.equal(res.results[0].data.length, 3);
  });

  await test('B/2: fetchCategoryByDevice — 분야 × 기기 정규화', async () => {
    lib._setHttpClient(async (path) => {
      assert.equal(path, '/v1/datalab/shopping/category/device');
      return mockResponse([
        mockTimeSeriesResult('pc'),
        mockTimeSeriesResult('mobile'),
      ]);
    });
    const res = await lib.fetchCategoryByDevice({
      categoryCode: '50000000',
      categoryName: '패션의류',
    });
    lib._resetHttpClient();

    assert.equal(res.metricType, 'category_device');
    assert.equal(res.results.length, 2);
  });

  await test('B/3: fetchCategoryByGender — 분야 × 성별 정규화', async () => {
    lib._setHttpClient(async (path) => {
      assert.equal(path, '/v1/datalab/shopping/category/gender');
      return mockResponse([
        mockTimeSeriesResult('female'),
        mockTimeSeriesResult('male'),
      ]);
    });
    const res = await lib.fetchCategoryByGender({ categoryCode: '50000000' });
    lib._resetHttpClient();

    assert.equal(res.metricType, 'category_gender');
    assert.equal(res.results.length, 2);
  });

  await test('B/4: fetchCategoryByAge — 분야 × 연령', async () => {
    lib._setHttpClient(async (path) => {
      assert.equal(path, '/v1/datalab/shopping/category/age');
      return mockResponse([
        mockTimeSeriesResult('20s'),
        mockTimeSeriesResult('30s'),
        mockTimeSeriesResult('40s'),
      ]);
    });
    const res = await lib.fetchCategoryByAge({ categoryCode: '50000000' });
    lib._resetHttpClient();

    assert.equal(res.metricType, 'category_age');
    assert.equal(res.results.length, 3);
  });

  // ────────────────────────────────────────
  // C 그룹 4종
  // ────────────────────────────────────────
  await test('C/5: fetchCategoryKeywords — 분야 + 키워드 인기', async () => {
    let captured = null;
    lib._setHttpClient(async (path, headers, body) => {
      captured = { path, body };
      return mockResponse([mockTimeSeriesResult('봄 원피스')]);
    });
    const res = await lib.fetchCategoryKeywords({
      categoryCode: '50000000',
      keywords: ['봄 원피스', '여름 블라우스'],
    });
    lib._resetHttpClient();

    assert.equal(captured.path, '/v1/datalab/shopping/category/keywords');
    assert.equal(captured.body.keyword.length, 2);
    assert.equal(captured.body.keyword[0].name, '봄 원피스');
    assert.equal(res.metricType, 'category_keywords');
  });

  await test('C/6: fetchCategoryKeywordByDevice — 분야 + 키워드 × 기기', async () => {
    lib._setHttpClient(async (path) => {
      assert.equal(path, '/v1/datalab/shopping/category/keyword/device');
      return mockResponse([mockTimeSeriesResult('mobile')]);
    });
    const res = await lib.fetchCategoryKeywordByDevice({
      categoryCode: '50000000',
      keyword: '봄 원피스',
    });
    lib._resetHttpClient();

    assert.equal(res.metricType, 'category_keyword_device');
    assert.equal(res.keyword, '봄 원피스');
  });

  await test('C/7: fetchCategoryKeywordByGender — 분야 + 키워드 × 성별', async () => {
    lib._setHttpClient(async (path) => {
      assert.equal(path, '/v1/datalab/shopping/category/keyword/gender');
      return mockResponse([mockTimeSeriesResult('female')]);
    });
    const res = await lib.fetchCategoryKeywordByGender({
      categoryCode: '50000000',
      keyword: '봄 원피스',
    });
    lib._resetHttpClient();

    assert.equal(res.metricType, 'category_keyword_gender');
  });

  await test('C/8: fetchCategoryKeywordByAge — 분야 + 키워드 × 연령', async () => {
    lib._setHttpClient(async (path) => {
      assert.equal(path, '/v1/datalab/shopping/category/keyword/age');
      return mockResponse([mockTimeSeriesResult('20s')]);
    });
    const res = await lib.fetchCategoryKeywordByAge({
      categoryCode: '50000000',
      keyword: '봄 원피스',
    });
    lib._resetHttpClient();

    assert.equal(res.metricType, 'category_keyword_age');
  });

  // ────────────────────────────────────────
  // 입력 검증
  // ────────────────────────────────────────
  await test('검증/1: 카테고리 코드 8자리 숫자 아니면 INVALID_CATEGORY', async () => {
    await assert.rejects(
      async () => lib.fetchCategoryTrend({ categoryCode: 'INVALID' }),
      err => err.code === 'INVALID_CATEGORY'
    );
  });

  await test('검증/2: 키워드 누락 시 INVALID_KEYWORD', async () => {
    await assert.rejects(
      async () => lib.fetchCategoryKeywordByDevice({ categoryCode: '50000000', keyword: '' }),
      err => err.code === 'INVALID_KEYWORD'
    );
  });

  await test('검증/3: keywords 빈 배열이면 INVALID_KEYWORDS', async () => {
    await assert.rejects(
      async () => lib.fetchCategoryKeywords({ categoryCode: '50000000', keywords: [] }),
      err => err.code === 'INVALID_KEYWORDS'
    );
  });

  await test('검증/4: 환경변수 누락 시 MISSING_CREDENTIALS', async () => {
    const savedId = process.env.NAVER_CLIENT_ID;
    delete process.env.NAVER_CLIENT_ID;
    await assert.rejects(
      async () => lib.fetchCategoryTrend({ categoryCode: '50000000' }),
      err => err.code === 'MISSING_CREDENTIALS'
    );
    process.env.NAVER_CLIENT_ID = savedId;
  });

  // ────────────────────────────────────────
  // 에러 번역
  // ────────────────────────────────────────
  await test('에러/1: 401 친절한 번역', async () => {
    lib._setHttpClient(async () => ({
      status: 401,
      body: JSON.stringify({ errorCode: '024', errorMessage: 'Authentication failed' }),
    }));
    try {
      await lib.fetchCategoryTrend({ categoryCode: '50000000' });
      throw new Error('expected to throw');
    } catch (e) {
      assert.equal(e.code, 'NAVER_API_ERROR');
      assert.equal(e.status, 401);
      assert.match(e.friendly.title, /네이버 인증 실패/);
      assert.ok(e.friendly.action);
    }
    lib._resetHttpClient();
  });

  await test('에러/2: 429 autoRetry 플래그', async () => {
    lib._setHttpClient(async () => ({
      status: 429,
      body: '{"errorCode":"010","errorMessage":"Too many requests"}',
    }));
    try {
      await lib.fetchCategoryTrend({ categoryCode: '50000000' });
      throw new Error('expected to throw');
    } catch (e) {
      assert.equal(e.status, 429);
      assert.equal(e.friendly.autoRetry, true);
    }
    lib._resetHttpClient();
  });

  await test('에러/3: translateNaverError 함수 단독 호출', () => {
    const f403 = lib.translateNaverError(403, '{"errorCode":"011"}');
    assert.match(f403.title, /권한 부족/);
    const f400 = lib.translateNaverError(400, 'BAD');
    assert.match(f400.title, /형식 오류/);
    const f500 = lib.translateNaverError(500, '');
    assert.ok(f500.title.includes('500'));
  });

  // ────────────────────────────────────────
  // 분포 요약
  // ────────────────────────────────────────
  await test('summary/1: summarizeDistribution — 비율 합 100%', () => {
    const results = [
      { title: 'pc', data: [{ period: '2026-04-20', ratio: 30 }] },
      { title: 'mobile', data: [{ period: '2026-04-20', ratio: 70 }] },
    ];
    const sum = lib.summarizeDistribution(results, 'device');
    assert.equal(sum.kind, 'device');
    assert.equal(sum.split.pc, 30);
    assert.equal(sum.split.mobile, 70);
  });

  await test('summary/2: 빈 results 입력 시 null', () => {
    assert.equal(lib.summarizeDistribution([], 'device'), null);
    assert.equal(lib.summarizeDistribution(null, 'gender'), null);
  });

  // ────────────────────────────────────────
  // 카테고리 매핑
  // ────────────────────────────────────────
  await test('mapping/1: LUMI_TO_NAVER_CATEGORY 10업종 모두 8자리', () => {
    const entries = Object.values(lib.LUMI_TO_NAVER_CATEGORY);
    assert.equal(entries.length, 10);
    for (const v of entries) {
      assert.match(v.code, /^\d{8}$/);
      assert.ok(v.name && v.name.length > 0);
    }
  });

  // ────────────────────────────────────────
  // 결과 출력
  // ────────────────────────────────────────
  console.log('\n=== summary ===');
  console.log(`passed: ${passed}`);
  console.log(`failed: ${failed}`);
  if (failed > 0) {
    console.log('\nFAILURES:');
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.error.stack || f.error.message}`);
    }
    process.exit(1);
  }
  process.exit(0);
})().catch(err => {
  console.error('test runner crash:', err);
  process.exit(2);
});
