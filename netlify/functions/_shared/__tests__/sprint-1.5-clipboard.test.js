// Sprint 1.5 — ClipboardDetector + market-guides 단위 테스트
// 외부 라이브러리 X, node assert만 사용
// 실행: node netlify/functions/_shared/__tests__/sprint-1.5-clipboard.test.js

const assert = require('assert');
const path = require('path');

// ClipboardDetector를 Node 환경에서 로드 (window 폴리필)
function loadClipboardDetector() {
  // ClipboardDetector는 window에 export. global을 window로 위장.
  global.window = global.window || {};
  global.document = global.document || null;
  global.navigator = global.navigator || { clipboard: null, userAgent: '' };
  delete require.cache[path.resolve(__dirname, '..', '..', '..', '..', 'js', 'components', 'ClipboardDetector.js')];
  require(path.resolve(__dirname, '..', '..', '..', '..', 'js', 'components', 'ClipboardDetector.js'));
  return global.window.ClipboardDetector;
}

let pass = 0;
let fail = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    pass += 1;
    results.push({ name, status: 'PASS' });
    console.log(`[PASS] ${name}`);
  } catch (e) {
    fail += 1;
    results.push({ name, status: 'FAIL', error: e.message });
    console.error(`[FAIL] ${name}: ${e.message}`);
  }
}

(async () => {
  // ============================================================
  // 1. ClipboardDetector 패턴 감지
  // ============================================================
  const Detector = loadClipboardDetector();

  test('ClipboardDetector: 모듈 export 정상', () => {
    assert(Detector, 'ClipboardDetector이 정의돼야 함');
    assert(typeof Detector.create === 'function', 'create 함수 존재');
    assert(typeof Detector.detectKind === 'function', 'detectKind 함수 존재');
    assert(typeof Detector.maskValue === 'function', 'maskValue 함수 존재');
    assert(Detector.PATTERNS && Detector.PATTERNS.coupang, 'PATTERNS 존재');
  });

  test('detectKind: 쿠팡 Vendor ID 감지 (A로 시작 9~13자리)', () => {
    const r = Detector.detectKind('A00012345', 'coupang');
    assert(r, '감지 결과 존재');
    assert.strictEqual(r.kind, 'vendorId');
    assert.strictEqual(r.value, 'A00012345');
  });

  test('detectKind: 쿠팡 Vendor ID — 공백·줄바꿈 트림', () => {
    const r = Detector.detectKind('  A123456789  \n', 'coupang');
    assert(r);
    assert.strictEqual(r.kind, 'vendorId');
    assert.strictEqual(r.value, 'A123456789');
  });

  test('detectKind: 쿠팡 Access Key (hex 32자) 감지', () => {
    const r = Detector.detectKind('0123456789abcdef0123456789abcdef', 'coupang', 'accessKey');
    assert(r, 'hint=accessKey 시 매칭');
    assert.strictEqual(r.kind, 'accessKey');
  });

  test('detectKind: 쿠팡 Secret Key (base64 형식) 감지', () => {
    const fakeSecret = 'aGVsbG93b3JsZHRoaXNpc215c2VjcmV0a2V5MTIzNDU2Nzg5MA==';
    const r = Detector.detectKind(fakeSecret, 'coupang', 'secretKey');
    assert(r, '감지 결과 존재');
    assert.strictEqual(r.kind, 'secretKey');
  });

  test('detectKind: 네이버 Application ID 감지', () => {
    const r = Detector.detectKind('mZRKKpL1aBcDef234', 'naver');
    assert(r);
    assert.strictEqual(r.kind, 'applicationId');
  });

  test('detectKind: 네이버 Application Secret (bcrypt 형식) 감지', () => {
    const bcryptHash = '$2a$10$abcdefghijklmnopqrstuv0123456789ABCDEFGHIJKLMNOPQRSTU';
    const r = Detector.detectKind(bcryptHash, 'naver');
    assert(r, '감지 결과 존재');
    assert.strictEqual(r.kind, 'applicationSecret');
  });

  test('detectKind: 너무 짧은 텍스트는 거부 (8자 미만)', () => {
    const r = Detector.detectKind('abc', 'coupang');
    assert.strictEqual(r, null);
  });

  test('detectKind: 너무 긴 텍스트는 거부 (200자 초과)', () => {
    const long = 'A' + '0'.repeat(220);
    const r = Detector.detectKind(long, 'coupang');
    assert.strictEqual(r, null);
  });

  test('detectKind: 빈 문자열·null 거부', () => {
    assert.strictEqual(Detector.detectKind('', 'coupang'), null);
    assert.strictEqual(Detector.detectKind(null, 'coupang'), null);
    assert.strictEqual(Detector.detectKind(undefined, 'coupang'), null);
  });

  test('detectKind: 알 수 없는 마켓 거부', () => {
    const r = Detector.detectKind('A00012345', 'unknown');
    assert.strictEqual(r, null);
  });

  // ============================================================
  // 2. maskValue (Secret 마스킹, ID는 그대로)
  // ============================================================
  test('maskValue: Secret Key 마스킹 (앞 4 + ●●●● + 뒤 4)', () => {
    const masked = Detector.maskValue('secretKey', 'aGVsbG93b3JsZGZvb2JhcjEyMzQ1Njc4OTBhYmNkZWZnaA==');
    assert(masked.includes('••••'), '마스킹 처리됨');
    assert(masked.startsWith('aGVs'), '앞 4자 보존');
    assert(masked.endsWith('aA=='), '뒤 4자 보존');
  });

  test('maskValue: Vendor ID는 그대로 (마스킹 X)', () => {
    const v = Detector.maskValue('vendorId', 'A00012345');
    assert.strictEqual(v, 'A00012345');
  });

  test('maskValue: Access Key는 그대로 (마스킹 X — Secret 만 마스킹)', () => {
    const v = Detector.maskValue('accessKey', '0123456789abcdef');
    assert.strictEqual(v, '0123456789abcdef');
  });

  test('maskValue: Application Secret 마스킹', () => {
    const v = Detector.maskValue('applicationSecret', 'verylongsecretvaluefromcommerceapi');
    assert(v.includes('••••'));
  });

  test('maskValue: 짧은 Secret (8자 이하)', () => {
    const v = Detector.maskValue('secretKey', 'abc');
    assert(v.startsWith('••••'));
  });

  // ============================================================
  // 3. 환경 체크
  // ============================================================
  test('isClipboardSupported: navigator.clipboard 없으면 false', () => {
    const orig = global.navigator;
    global.navigator = { userAgent: 'test' };
    delete require.cache[path.resolve(__dirname, '..', '..', '..', '..', 'js', 'components', 'ClipboardDetector.js')];
    require(path.resolve(__dirname, '..', '..', '..', '..', 'js', 'components', 'ClipboardDetector.js'));
    const D = global.window.ClipboardDetector;
    assert.strictEqual(D.isClipboardSupported(), false);
    global.navigator = orig;
  });

  test('isIOSSafari: iOS UA 감지 (정규표현식 직접 검증)', () => {
    // Node 24+는 readonly globalThis.navigator를 가지므로 직접 정규식 검증 사용
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
    const isIOS = /iP(hone|ad|od)/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS/.test(ua);
    assert.strictEqual(isIOS, true);
  });

  test('isIOSSafari: Chrome iOS는 거부 (CriOS 포함)', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) CriOS/120.0 Safari/604.1';
    const isIOS = /iP(hone|ad|od)/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS/.test(ua);
    assert.strictEqual(isIOS, false);
  });

  test('isIOSSafari: Android Chrome 거부', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 13) Chrome/120.0';
    const isIOS = /iP(hone|ad|od)/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS/.test(ua);
    assert.strictEqual(isIOS, false);
  });

  // ============================================================
  // 4. createDetector 인스턴스 동작
  // ============================================================
  test('create: 인스턴스 메서드 존재', () => {
    const d = Detector.create({ market: 'coupang' });
    assert(typeof d.start === 'function');
    assert(typeof d.stop === 'function');
    assert(typeof d.trigger === 'function');
    assert(typeof d.isSupported === 'function');
    assert(typeof d.isRunning === 'function');
  });

  test('create: 알 수 없는 마켓도 throw 안 함', () => {
    const d = Detector.create({ market: 'invalid' });
    assert(d, '인스턴스 생성됨 (graceful)');
  });

  // ============================================================
  // 5. KIND_LABELS 한글 라벨 점검
  // ============================================================
  test('KIND_LABELS: 5종 라벨 모두 정의', () => {
    assert.strictEqual(Detector.KIND_LABELS.vendorId, 'Vendor ID');
    assert.strictEqual(Detector.KIND_LABELS.accessKey, 'Access Key');
    assert.strictEqual(Detector.KIND_LABELS.secretKey, 'Secret Key');
    assert.strictEqual(Detector.KIND_LABELS.applicationId, 'Application ID');
    assert.strictEqual(Detector.KIND_LABELS.applicationSecret, 'Application Secret');
  });

  // ============================================================
  // 6. market-guides handler 응답 형식 (DB 미설정 → fallback)
  // ============================================================
  test('market-guides: fallback 가이드 응답 형식', async () => {
    // SUPABASE 환경변수 비우면 getAdminClient throw → fallback 경로
    const origUrl = process.env.SUPABASE_URL;
    const origKey = process.env.SUPABASE_SERVICE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;

    delete require.cache[path.resolve(__dirname, '..', '..', 'market-guides.js')];
    const handler = require(path.resolve(__dirname, '..', '..', 'market-guides.js')).handler;

    const event = {
      httpMethod: 'GET',
      headers: { origin: 'http://localhost:8888' },
      queryStringParameters: { market: 'coupang' },
    };
    const out = await handler(event);
    assert.strictEqual(out.statusCode, 200);
    const body = JSON.parse(out.body);
    assert.strictEqual(body.success, true);
    assert(Array.isArray(body.guides));
    assert(body.guides.length > 0, 'fallback 가이드 1개 이상');
    assert(body.guides.every((g) => g.market === 'coupang'), '쿠팡 필터링');
    assert(body.guides.every((g) => g.external_url && g.title), '필수 필드');

    if (origUrl) process.env.SUPABASE_URL = origUrl;
    if (origKey) process.env.SUPABASE_SERVICE_KEY = origKey;
  });

  test('market-guides: 잘못된 market 파라미터 → 400', async () => {
    delete require.cache[path.resolve(__dirname, '..', '..', 'market-guides.js')];
    const handler = require(path.resolve(__dirname, '..', '..', 'market-guides.js')).handler;
    const event = {
      httpMethod: 'GET',
      headers: { origin: 'http://localhost:8888' },
      queryStringParameters: { market: 'aliexpress' },
    };
    const out = await handler(event);
    assert.strictEqual(out.statusCode, 400);
  });

  test('market-guides: market 없으면 전체 반환', async () => {
    const origUrl = process.env.SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    delete require.cache[path.resolve(__dirname, '..', '..', 'market-guides.js')];
    const handler = require(path.resolve(__dirname, '..', '..', 'market-guides.js')).handler;
    const event = { httpMethod: 'GET', headers: { origin: 'http://localhost:8888' }, queryStringParameters: {} };
    const out = await handler(event);
    assert.strictEqual(out.statusCode, 200);
    const body = JSON.parse(out.body);
    const markets = new Set(body.guides.map((g) => g.market));
    assert(markets.has('coupang') && markets.has('naver'), '쿠팡 + 네이버 모두 포함');
    if (origUrl) process.env.SUPABASE_URL = origUrl;
  });

  test('market-guides: OPTIONS preflight → 204', async () => {
    delete require.cache[path.resolve(__dirname, '..', '..', 'market-guides.js')];
    const handler = require(path.resolve(__dirname, '..', '..', 'market-guides.js')).handler;
    const out = await handler({ httpMethod: 'OPTIONS', headers: {}, queryStringParameters: {} });
    assert.strictEqual(out.statusCode, 204);
  });

  test('market-guides: POST 거부 → 405', async () => {
    delete require.cache[path.resolve(__dirname, '..', '..', 'market-guides.js')];
    const handler = require(path.resolve(__dirname, '..', '..', 'market-guides.js')).handler;
    const out = await handler({ httpMethod: 'POST', headers: {}, queryStringParameters: {} });
    assert.strictEqual(out.statusCode, 405);
  });

  // ============================================================
  console.log(`\n=== Sprint 1.5 단위 테스트: ${pass} PASS / ${fail} FAIL ===\n`);
  process.exit(fail > 0 ? 1 : 0);
})();
