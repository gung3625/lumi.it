// 국세청 사업자 진위·상태 조회 클라이언트 (data.go.kr)
// - status: POST https://api.odcloud.kr/api/nts-businessman/v1/status
// - validate: POST https://api.odcloud.kr/api/nts-businessman/v1/validate
//
// 응답 코드:
// - data[].b_stt_cd: '01'=계속사업자, '02'=휴업자, '03'=폐업자
// - data[].valid: '01'=일치, '02'=불일치
//
// 보안: 사업자번호·대표자명·개업일은 평문 로그 출력 절대 금지 (호출자 책임)

const https = require('https');

const NTS_BASE = 'https://api.odcloud.kr/api/nts-businessman/v1';
const DEFAULT_TIMEOUT_MS = 7000;

function postJson(url, body, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const u = new URL(url);
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      path: u.pathname + u.search,
      port: u.port || 443,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': data.length,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (_) { /* */ }
        resolve({ status: res.statusCode, body: text, json: parsed });
      });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(new Error('NTS API timeout')); });
    req.write(data);
    req.end();
  });
}

/**
 * 휴폐업 상태 조회 — 1개 사업자번호만 검사
 * @param {Object} params
 * @param {string} params.businessNumber - 숫자 10자리
 * @param {string} params.serviceKey - data.go.kr 공통 키 (decoded)
 * @param {object} [params.fetcher] - 의존성 주입 (테스트용). { postJson }
 * @returns {Promise<{ ok: boolean, statusCode: string|null, raw: object|null, httpStatus: number }>}
 */
async function fetchBusinessStatus({ businessNumber, serviceKey, fetcher }) {
  const post = (fetcher && fetcher.postJson) || postJson;
  const url = `${NTS_BASE}/status?serviceKey=${encodeURIComponent(serviceKey)}`;
  const res = await post(url, { b_no: [businessNumber] });
  if (res.status !== 200 || !res.json || !Array.isArray(res.json.data) || res.json.data.length === 0) {
    return { ok: false, statusCode: null, raw: res.json, httpStatus: res.status };
  }
  const item = res.json.data[0];
  return { ok: true, statusCode: item.b_stt_cd || null, raw: item, httpStatus: res.status };
}

/**
 * 진위 확인 — 사업자번호 + 대표자명 + 개업일 일치 검증
 * @param {Object} params
 * @param {string} params.businessNumber - 숫자 10자리
 * @param {string} params.ownerName - 대표자명
 * @param {string} params.startDate - YYYYMMDD 형식 (개업일)
 * @param {string} params.serviceKey
 * @param {string} [params.businessName] - 상호 (선택, 정확도 향상)
 * @param {object} [params.fetcher]
 * @returns {Promise<{ ok: boolean, valid: string|null, raw: object|null, httpStatus: number }>}
 */
async function validateBusinessIdentity({
  businessNumber,
  ownerName,
  startDate,
  serviceKey,
  businessName,
  fetcher,
}) {
  const post = (fetcher && fetcher.postJson) || postJson;
  const url = `${NTS_BASE}/validate?serviceKey=${encodeURIComponent(serviceKey)}`;
  const business = {
    b_no: businessNumber,
    start_dt: startDate,
    p_nm: ownerName,
  };
  if (businessName) business.b_nm = businessName;
  const res = await post(url, { businesses: [business] });
  if (res.status !== 200 || !res.json || !Array.isArray(res.json.data) || res.json.data.length === 0) {
    return { ok: false, valid: null, raw: res.json, httpStatus: res.status };
  }
  const item = res.json.data[0];
  return { ok: true, valid: item.valid || null, raw: item, httpStatus: res.status };
}

module.exports = {
  fetchBusinessStatus,
  validateBusinessIdentity,
  postJson,
  NTS_BASE,
};
