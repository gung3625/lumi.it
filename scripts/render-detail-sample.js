'use strict';
// 도매꾹 상품번호 → 실제 상세페이지 디자인 컷 PNG 생성 (로컬/GCP 검증용).
// 사용: node scripts/render-detail-sample.js <도매꾹상품번호> [출력파일.png]
//   예: node scripts/render-detail-sample.js 12345678 detail.png
// 필요 env: DOMEGGOOK_API_KEY(+USER_ID), OPENAI_API_KEY 또는 GEMINI_API_KEY.
//   GCP는 ecosystem.config.js apps[0].env 를 자동 로드(아래). 아이맥 로컬은 해당 env가 셸에 있어야 함.

// GCP/PM2 환경변수 자동 로드(있으면).
try {
  const eco = require('../ecosystem.config.js');
  const env = eco && eco.apps && eco.apps[0] && eco.apps[0].env;
  if (env) for (const k of Object.keys(env)) if (process.env[k] == null) process.env[k] = env[k];
} catch (_) { /* 로컬에 ecosystem 없으면 셸 env 사용 */ }

const fs = require('fs');
const { getItemView } = require('../netlify/functions/_shared/domeggook-api');
const { generateDetailPage } = require('../netlify/functions/_shared/detail-page');
const { renderDetailCuts } = require('../netlify/functions/_shared/detail-render');

(async () => {
  const no = process.argv[2];
  const out = process.argv[3] || ('detail_' + (no || 'sample') + '.png');
  if (!no) { console.error('사용: node scripts/render-detail-sample.js <도매꾹상품번호> [출력.png]'); process.exit(1); }

  console.log('1) 도매꾹 상품 조회:', no);
  const product = await getItemView(no);
  if (!product) { console.error('   ✗ 상품 조회 실패 (상품번호/DOMEGGOOK_API_KEY 확인)'); process.exit(1); }
  console.log('   ✓', product.title, '| 이미지', (product.images || []).length, '장 | 옵션', (product.options || []).length, '개');

  console.log('2) 카피 생성(LLM)...');
  const { copy, error } = await generateDetailPage(product, {});
  if (!copy) { console.error('   ✗ 카피 생성 실패:', error); process.exit(1); }
  console.log('   ✓ heroHeadline:', copy.heroHeadline);

  console.log('3) 디자인 컷 렌더(상품 사진 + 상품색 자동 테마)...');
  const { cuts, stitched } = await renderDetailCuts(product, copy); // photos=product.images(URL) 자동 사용
  fs.writeFileSync(out, stitched);
  // 컷별로도 저장(검토용)
  const dir = out.replace(/\.png$/i, '') + '_cuts';
  fs.mkdirSync(dir, { recursive: true });
  cuts.forEach((c, i) => fs.writeFileSync(dir + '/' + String(i).padStart(2, '0') + '_' + c.name + '.png', c.png));
  console.log('   ✓ 컷', cuts.length, '개:', cuts.map((c) => c.name).join(', '));
  console.log('\n완료 → 합본:', out, '| 컷별:', dir + '/');
})().catch((e) => { console.error('오류:', e.stack || e.message); process.exit(1); });
