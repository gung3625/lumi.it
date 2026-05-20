#!/usr/bin/env node
/**
 * scripts/check-antipatterns.js — 안티패턴 검사. build 직전 실행.
 *
 * 배경 (2026-05-09, 커밋 e032abf):
 *   @supabase/postgrest-js 의 PostgrestBuilder 는 PromiseLike (.then 만 정의,
 *   .catch 없음). 따라서 빌더 끝에 .catch(...) 체이닝하면 호출 시점에
 *   "TypeError: ... .catch is not a function" 동기 throw — await 까지 도달 X.
 *
 *   2026-05-01 ~ 5-08 동안 scheduled-trends-v2 가 이 안티패턴으로 매일 자정
 *   동기 죽음. 9일 발견 안 됨. _shared/supa-safe.js 의 safeAwait() 가 표준.
 *
 * 본 검사가 새 코드에 같은 안티패턴이 재진입하는 것을 차단.
 *
 * 검사 항목:
 *   1. supabase 빌더 .catch 체이닝 — 동기 TypeError 유발
 *      예: admin.from('t').update({...}).catch(...)
 *           admin.rpc('foo').catch(...)
 *
 *   2. (heuristic) await 없는 supabase mutation
 *      예: admin.from('t').update({...}).eq(...);   ← await 빠짐 → fire-and-forget
 *
 * build 에 통합 — npm run build 첫 단계. 발견 시 build fail.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['netlify/functions', 'js'];
const SKIP_DIRS = ['node_modules', '.git', '.netlify', 'dist'];

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.includes(name)) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (name.endsWith('.js')) yield p;
  }
}

// 1. supabase 빌더 .catch — 강한 신호. supa-safe.js 자신은 예외.
const RE_BUILDER_CATCH = /\b(?:admin|supa(?:base)?|sb|client)\b[^;\n]*?\.(?:from|rpc|storage|auth)\b[^;\n]*?\)\.catch\s*\(/;

// 2. await 누락 — heuristic. 다음 조건 모두 만족하면 의심:
//   - line 이 `.from(` 또는 `.rpc(` 포함
//   - 그 호출이 .insert / .update / .delete / .upsert / .select 로 이어짐
//   - line 시작이 await 도 아니고, return 도 아니고, const/let/var assignment 도 아님
//   - safeAwait( 안에 있지도 않음
// false positive 가능성 있어서 발견 시 경고로만 출력 (build fail X), 단 builder-catch 는 fail.
const RE_BUILDER_USE = /\b(?:admin|supa(?:base)?|sb|client)\b\.(?:from|rpc)\s*\(/;
const RE_BUILDER_MUTATION = /\.(?:insert|update|delete|upsert)\s*\(/;
const RE_AWAIT_OR_ASSIGN = /^\s*(?:await\b|return\b|const\b|let\b|var\b|throw\b|yield\b|\(.*=>|=>|\+|\}|safeAwait\s*\()/;

const errors = [];
const warnings = [];

for (const dir of SCAN_DIRS) {
  const abs = path.join(ROOT, dir);
  for (const file of walk(abs)) {
    // supa-safe.js 자신은 검사 제외 (이 헬퍼가 빌더를 직접 다룸)
    if (file.endsWith('supa-safe.js')) continue;

    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const rel = path.relative(ROOT, file);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 주석 라인 제외
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

      // 1. builder .catch — error
      if (RE_BUILDER_CATCH.test(line)) {
        errors.push({
          file: rel,
          line: i + 1,
          rule: 'supabase-builder-catch',
          msg: 'supabase 빌더에 .catch 직접 체이닝 금지. safeAwait() 사용. (커밋 e032abf 참고)',
          code: line.trim().slice(0, 200),
        });
      }

      // 2. heuristic await 누락 — warning
      // 한 라인에 builder 호출 + mutation 메소드가 동시에 나오는 경우 (체이닝)
      // 단, 라인 어디에든 await 가 있으면 (예: try { await ... }) 정상으로 간주.
      const hasAwaitInLine = /\bawait\b/.test(line) || /\bsafeAwait\s*\(/.test(line);
      if (!hasAwaitInLine && RE_BUILDER_USE.test(line) && RE_BUILDER_MUTATION.test(line) && !RE_AWAIT_OR_ASSIGN.test(line)) {
        // 멀티라인 체이닝이면 위 라인이 await 일 수 있음 — 위 5라인까지 확인
        let hasContext = false;
        for (let j = Math.max(0, i - 5); j < i; j++) {
          if (/\b(?:await|return|const|let|var)\b/.test(lines[j])) { hasContext = true; break; }
        }
        if (!hasContext) {
          warnings.push({
            file: rel,
            line: i + 1,
            rule: 'maybe-missing-await',
            msg: '의심: supabase mutation 에 await 누락 가능 (heuristic, 확인 필요)',
            code: line.trim().slice(0, 200),
          });
        }
      }
    }
  }
}

if (warnings.length > 0) {
  console.warn(`\n[check-antipatterns] 경고 ${warnings.length}건 (false positive 가능):`);
  for (const w of warnings) {
    console.warn(`  ${w.file}:${w.line} [${w.rule}] ${w.msg}\n    ${w.code}`);
  }
}

if (errors.length > 0) {
  console.error(`\n[check-antipatterns] ❌ 에러 ${errors.length}건 — build 중단:`);
  for (const e of errors) {
    console.error(`  ${e.file}:${e.line} [${e.rule}] ${e.msg}\n    ${e.code}`);
  }
  console.error('\n  fix: supabase 빌더 호출은 safeAwait() 로 감싸세요.');
  console.error('       const { data, error } = await safeAwait(admin.from(...).update(...));\n');
  process.exit(1);
}

console.log(`[check-antipatterns] ✓ 통과 (${warnings.length} 경고)`);
