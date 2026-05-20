// _shared/fetch-with-retry.js — 외부 API fetch wrapper with 5xx/network retry.
//
// 2026-05-20 prevention #6, #7: Meta Graph API + OpenAI API 의 transient 실패
// (5xx, abort, network glitch) 시 즉시 자동 재시도. 1회 transient 실패가
// 사장님 무인지로 묻혀야 하는데 현재는 throw → caption_status='failed'.
//
// 정책:
//   - 5xx 응답: retry (Meta/OpenAI 서버 일시 장애)
//   - 4xx 응답: retry X (client 에러는 재시도해도 똑같음. 빠르게 fail)
//   - fetch throw (network/abort): retry
//   - 2회 retry (= 총 3 시도). 500ms → 1500ms exponential backoff.
//
// 사용:
//   const { fetchWithRetry } = require('./fetch-with-retry');
//   const res = await fetchWithRetry(url, { method, headers, body, signal }, {
//     maxRetries: 2,         // default 2
//     timeoutMs: 90_000,     // default 60_000 — AbortController 자동 관리
//     label: 'openai-chat',  // 로그 prefix
//   });
//
// 호출자는 res.ok, res.json() 등 평소 fetch 대로 처리. retry 는 transparent.

'use strict';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * @param {string} url
 * @param {RequestInit} init - 표준 fetch init. signal 은 본 함수가 자동 관리 (timeoutMs 사용).
 * @param {object} opts - { maxRetries, timeoutMs, label }
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, init = {}, opts = {}) {
  const maxRetries = typeof opts.maxRetries === 'number' ? opts.maxRetries : 2;
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 60_000;
  const label = opts.label || 'fetch';

  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(tid);
      if (res.ok) return res;
      // 4xx 는 retry 의미 없음 — 그대로 반환 (호출자가 처리)
      if (res.status >= 400 && res.status < 500) return res;
      // 5xx — retry
      lastErr = new Error(`${label}: HTTP ${res.status}`);
      console.warn(`[fetch-with-retry] ${label} attempt ${attempt + 1}/${maxRetries + 1} → HTTP ${res.status}`);
      if (attempt === maxRetries) return res;  // 마지막 시도면 응답 그대로 반환
    } catch (err) {
      clearTimeout(tid);
      lastErr = err;
      console.warn(`[fetch-with-retry] ${label} attempt ${attempt + 1}/${maxRetries + 1} → ${err.name}: ${err.message}`);
      if (attempt === maxRetries) throw err;  // 마지막 시도면 throw
    }
    // 다음 시도 전 백오프 (500ms → 1500ms → 4500ms)
    await sleep(500 * Math.pow(3, attempt));
  }
  throw lastErr || new Error(`${label}: 알 수 없는 실패`);
}

module.exports = { fetchWithRetry };
