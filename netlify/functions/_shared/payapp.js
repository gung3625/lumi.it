// PayApp 정기결제 API 공통 헬퍼.
// docs: https://docs.payapp.kr/dev_center01.html — 응답은 JSON 아님(x-www-form-urlencoded 쿼리스트링).
'use strict';

const PAYAPP_API = 'https://api.payapp.kr/oapi/apiLoad.html';
const SUBSCRIPTION_PRICE = 19900;
const GOOD_NAME = '루미 Pro 월 구독';

// PayApp REST 호출: params → form-urlencoded POST → 쿼리스트링 응답 파싱.
// 결제 mutation 이라 자동 재시도 안 함(중복 등록/청구 위험). 타임아웃만 둔다.
async function callPayApp(params = {}, { timeoutMs = 15000 } = {}) {
  const userid = process.env.PAYAPP_USERID;
  const linkkey = process.env.PAYAPP_LINKKEY;
  if (!userid || !linkkey) throw new Error('PAYAPP_USERID / PAYAPP_LINKKEY 미설정');

  const form = new URLSearchParams();
  form.set('userid', userid);
  form.set('linkkey', linkkey);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') form.set(k, String(v));
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let text;
  try {
    const res = await fetch(PAYAPP_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: form.toString(),
      signal: ctrl.signal,
    });
    text = await res.text();
  } finally {
    clearTimeout(timer);
  }

  // 응답은 쿼리스트링: state=1&rebill_no=..&payurl=..&errno=..&errorMessage=..
  const parsed = new URLSearchParams(text);
  const data = {};
  for (const [k, v] of parsed) data[k] = v;
  return { ok: data.state === '1', data };
}

module.exports = { callPayApp, PAYAPP_API, SUBSCRIPTION_PRICE, GOOD_NAME };
