#!/usr/bin/env node
// Sprint 3.5 마이그레이션 마법사 V1 — 검증 게이트 (5+개)
// 사용: node sprint35-verify/verify.js

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SUMMARY = [];

function logResult(no, name, pass, detail) {
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${no}. ${name} — ${detail}`);
  SUMMARY.push({ no, name, pass, detail });
}

(async () => {
  // ────────────────────────────────────────────────────────────────────────
  // Gate 1: 4단 파이프라인 모듈 존재
  // ────────────────────────────────────────────────────────────────────────
  {
    const required = [
      'netlify/functions/_shared/migration/core/encoding-detector.js',
      'netlify/functions/_shared/migration/core/solution-identifier.js',
      'netlify/functions/_shared/migration/core/header-mapper.js',
      'netlify/functions/_shared/migration/core/lumi-excel-processor.js',
      'netlify/functions/_shared/migration/parsers/sabang-parser.js',
      'netlify/functions/_shared/migration/transformers/currency-parser.js',
      'netlify/functions/_shared/migration/transformers/option-parser.js',
      'netlify/functions/_shared/migration/transformers/image-validator.js',
      'netlify/functions/_shared/migration/transformers/policy-word-checker.js',
      'netlify/functions/_shared/migration/workers/large-file-worker.js',
      'netlify/functions/migration-upload.js',
      'netlify/functions/migration-analyze.js',
      'netlify/functions/migration-execute.js',
      'migration-wizard.html',
    ];
    const missing = required.filter((f) => !fs.existsSync(path.join(ROOT, f)));
    logResult(1, '필수 모듈·파일 존재', missing.length === 0,
      missing.length === 0 ? `${required.length}개 전부 생성됨` : `누락: ${missing.join(', ')}`);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Gate 2: 단위 테스트 통과
  // ────────────────────────────────────────────────────────────────────────
  {
    const { spawnSync } = require('child_process');
    const r = spawnSync('node', [path.join(ROOT, 'netlify/functions/_shared/migration/__tests__/run-tests.js')], {
      encoding: 'utf-8',
    });
    const passed = r.status === 0;
    const summaryLine = (r.stdout || '').split('\n').reverse().find((l) => /\d+\/\d+ passed/.test(l)) || 'no summary';
    logResult(2, '단위 테스트 통과', passed, summaryLine.trim());
  }

  // ────────────────────────────────────────────────────────────────────────
  // Gate 3: 솔루션 자동 감지 (4사 표준 시그니처)
  // ────────────────────────────────────────────────────────────────────────
  {
    const { identifySolution } = require(path.join(ROOT, 'netlify/functions/_shared/migration/core/solution-identifier'));
    const cases = [
      { name: 'sabangnet', headers: ['판매자상품코드', 'it_name', 'it_price', 'it_stock', 'it_img'] },
      { name: 'shoplinker', headers: ['판매자관리코드', '상품명', '판매가', '공급가', '대표이미지'] },
      { name: 'ezadmin', headers: ['상품관리코드', '상품명', '판매단가', '현재고', '이지카테고리'] },
      { name: 'plto', headers: ['자체상품코드', '상품명', '판매가', '메인이미지', '확장필드1'] },
      { name: 'unknown', headers: ['Random A', 'Random B'] },
    ];
    let correct = 0;
    for (const c of cases) {
      const r = identifySolution(c.headers);
      if (r.solution === c.name) correct++;
    }
    logResult(3, '솔루션 자동 감지 (4사 + unknown)', correct === cases.length,
      `${correct}/${cases.length} 정확`);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Gate 4: 4단 매핑 파이프라인 (사방넷 표준 양식 → 100% 코드 매핑)
  // ────────────────────────────────────────────────────────────────────────
  {
    const { mapHeaders } = require(path.join(ROOT, 'netlify/functions/_shared/migration/core/header-mapper'));
    const headers = ['판매자상품코드', 'it_name', 'it_price', 'it_stock', 'it_img', '카테고리코드'];
    const r = await mapHeaders(headers, { solution: 'sabangnet', mockAi: true });
    const codeMatched = r.filter((m) => m.source === 'code').length;
    const pass = codeMatched >= 5;
    logResult(4, 'Phase 1 코드 룰 (사방넷 표준 ≥ 5필드 매핑)', pass,
      `code 매핑 ${codeMatched}/${r.length}`);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Gate 5: 가짜 사방넷 양식 5개 통합 처리
  // ────────────────────────────────────────────────────────────────────────
  {
    const { processExcelBuffer } = require(path.join(ROOT, 'netlify/functions/_shared/migration/core/lumi-excel-processor'));
    let xlsx;
    try { xlsx = require(path.join(ROOT, 'node_modules', 'xlsx')); }
    catch { try { xlsx = require('xlsx'); } catch { xlsx = null; } }

    if (!xlsx) {
      logResult(5, '가짜 사방넷 양식 5개 처리', false, 'xlsx 미설치 (npm install xlsx 필요)');
    } else {
      const fakeForms = [
        // 표준 사방넷 (행 분리형)
        [
          { '판매자상품코드': 'A001', 'it_name': '봄 원피스', '옵션명': '색상', '옵션값': '블랙', 'it_price': '39000', 'it_stock': '10', 'it_img': 'https://example.com/a.jpg', '카테고리코드': '001001' },
          { '판매자상품코드': 'A001', 'it_name': '봄 원피스', '옵션명': '색상', '옵션값': '화이트', 'it_price': '39000', 'it_stock': '5', 'it_img': 'https://example.com/a.jpg', '카테고리코드': '001001' },
        ],
        // 결합형 옵션
        [{ '판매자상품코드': 'B001', 'it_name': '여름 셔츠', 'it_price': '29,000원', 'it_stock': '20', 'it_img': 'https://example.com/b.jpg', '옵션값': '색상:블루|사이즈:L' }],
        // 변칙 (한글 헤더만)
        [{ '상품코드': 'C001', '상품명': '가을 자켓', '판매가': '59000', '재고수량': '15', '대표이미지URL': 'https://example.com/c.jpg' }],
        // 가격 dirty data
        [{ '판매자상품코드': 'D001', 'it_name': '겨울 코트', 'it_price': '129,000원(품절)', 'it_stock': '0', 'it_img': 'https://example.com/d.jpg' }],
        // 다중 상품
        Array.from({ length: 5 }, (_, i) => ({
          '판매자상품코드': `E${String(i + 1).padStart(3, '0')}`,
          'it_name': `상품 ${i + 1}`,
          'it_price': `${(i + 1) * 10000}`,
          'it_stock': `${(i + 1) * 5}`,
          'it_img': `https://example.com/e${i + 1}.jpg`,
        })),
      ];

      let allPass = true;
      const details = [];
      for (let i = 0; i < fakeForms.length; i++) {
        const wb = xlsx.utils.book_new();
        const ws = xlsx.utils.json_to_sheet(fakeForms[i]);
        xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
        const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        const r = await processExcelBuffer(buf, { mockAi: true });
        const ok = r.success && r.products.length > 0;
        if (!ok) { allPass = false; details.push(`form#${i + 1}=실패`); }
        else details.push(`form#${i + 1}=${r.products.length}건`);
      }
      logResult(5, '가짜 사방넷 양식 5개 처리', allPass, details.join(', '));
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Gate 6: signup.html 마이그레이션 분기 추가
  // ────────────────────────────────────────────────────────────────────────
  {
    const html = fs.readFileSync(path.join(ROOT, 'signup.html'), 'utf-8');
    const hasMigBranch = /migration-wizard|기존 솔루션|이전하기/i.test(html);
    logResult(6, 'signup.html 마이그레이션 분기 추가', hasMigBranch,
      hasMigBranch ? '분기 카피 발견' : '분기 카피 미발견');
  }

  // ────────────────────────────────────────────────────────────────────────
  // Gate 7: netlify.toml /api/migration-* 리다이렉트
  // ────────────────────────────────────────────────────────────────────────
  {
    const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf-8');
    const hasUpload = /migration-upload/.test(toml) || /\/api\/\*/.test(toml);
    logResult(7, 'netlify.toml /api/* 리다이렉트', hasUpload,
      hasUpload ? '리다이렉트 확인' : '미설정');
  }

  // ────────────────────────────────────────────────────────────────────────
  // Gate 8: 경쟁사명 노출 금지 (UI 카피 검증)
  // ────────────────────────────────────────────────────────────────────────
  {
    const html = fs.readFileSync(path.join(ROOT, 'migration-wizard.html'), 'utf-8');
    const banned = ['사방넷', '샵링커', '이지어드민', '플레이오토'];
    const found = banned.filter((b) => html.includes(b));
    logResult(8, '경쟁사명 노출 금지 (memory feedback_no_competitor_mention_in_copy)',
      found.length === 0,
      found.length === 0 ? '경쟁사명 미노출' : `노출: ${found.join(', ')}`);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Final
  // ────────────────────────────────────────────────────────────────────────
  const passed = SUMMARY.filter((s) => s.pass).length;
  const total = SUMMARY.length;
  console.log(`\n${passed}/${total} gates passed`);
  if (passed < 5) {
    console.log('FAIL: minimum 5 gates required');
    process.exit(1);
  }
  if (passed < total) {
    console.log('PARTIAL PASS (≥5 gates required, met)');
  }
})().catch((e) => {
  console.error('verify error:', e);
  process.exit(2);
});
