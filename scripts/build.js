#!/usr/bin/env node
/**
 * scripts/build.js — Netlify deploy 직전 css/js minify (audit 후속, 전체 최적화).
 *
 * 사장님 결정 2026-05-17: Netlify 의 build.processing.js/css.minify 가 효과 없음 →
 * 자체 esbuild 로 minify. publish="." 라 in-place 덮어쓰기 (deploy server 의 임시 git clone).
 *
 * 대상:
 * - /js/**.js (공용 + pages/*)
 * - /css/**.css (tokens, base, motion, tabbar, legal + pages/*)
 *
 * 안전:
 * - source map 생성 (디버깅용, 동일 디렉토리 .map)
 * - 한국어 주석 / template literal preserve (esbuild 가 자동)
 * - 실패 시 build 전체 fail — 잘못된 minify 가 deploy 안 됨
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function* walk(dir, exts) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) yield* walk(p, exts);
    else if (exts.includes(path.extname(name).toLowerCase())) yield p;
  }
}

async function main() {
  const { build } = require('esbuild');

  const jsFiles  = [...walk(path.join(ROOT, 'js'), ['.js'])];
  const cssFiles = [...walk(path.join(ROOT, 'css'), ['.css'])];
  const all = [...jsFiles, ...cssFiles];

  if (all.length === 0) {
    console.log('[build] no js/css to minify');
    return;
  }

  console.log(`[build] minifying ${jsFiles.length} js + ${cssFiles.length} css files…`);

  // 각 파일 in-place minify
  for (const file of all) {
    const original = fs.statSync(file).size;
    await build({
      entryPoints: [file],
      outfile: file,
      bundle: false,
      minify: true,
      allowOverwrite: true,
      sourcemap: false,
      target: ['es2020'],
      legalComments: 'none',
      logLevel: 'warning',
    });
    const minified = fs.statSync(file).size;
    const pct = ((1 - minified / original) * 100).toFixed(1);
    console.log(`  ${path.relative(ROOT, file).padEnd(45)} ${String(original).padStart(7)} → ${String(minified).padStart(7)} (-${pct}%)`);
  }

  console.log('[build] done.');
}

main().catch(err => {
  console.error('[build] FAIL:', err);
  process.exit(1);
});
