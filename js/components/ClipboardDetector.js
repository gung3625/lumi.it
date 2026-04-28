// ====================================================================
// 루미 Sprint 1.5 — Smart Clipboard Detector
// ====================================================================
// 셀러가 마켓 사이트에서 키 복사 → 루미 돌아옴 → 자동 감지 → "입력할까요?"
// 메모리 project_market_oauth_wizard_ux.md ② 항목.
//
// 보안:
//   - 권한 명시 동의 (브라우저 prompt) 필수
//   - 자동 입력 X, 항상 셀러 [예/아니오] 컨펌
//   - 거부 시 = 일반 입력 폼 폴백 (셀러를 막지 않음)
//   - iOS Safari 권한 정책 다름 = 폴백 = 일반 입력 폼
//   - Secret Key는 자동 감지돼도 popup에서 즉시 마스킹 표시
//
// 사용:
//   const detector = ClipboardDetector.create({
//     market: 'coupang',
//     patterns: ['vendorId', 'accessKey', 'secretKey'],
//     onDetect: (kind, value) => fillInput(kind, value),
//   });
//   detector.start();
//   // ...
//   detector.stop();
// ====================================================================
(function (global) {
  'use strict';

  // 키 패턴 정규표현식 (Sprint 1.5)
  // 메모리: 형식 검증은 클라이언트 즉시(<50ms), Phase 1
  const PATTERNS = {
    coupang: {
      vendorId: /\bA\d{8,12}\b/,                              // A00012345
      accessKey: /\b[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12,16}\b/i,
      accessKeyAlt: /\b[a-f0-9]{32,64}\b/i,                   // 단순 hex 32~64자
      secretKey: /\b[A-Za-z0-9+/=]{40,80}\b/,                 // base64 형식 추정
    },
    naver: {
      applicationId: /\b[a-zA-Z0-9_-]{12,40}\b/,              // SELF 등록 시 12~40자
      applicationSecret: /\$2[ayb]\$[\d]{2}\$[A-Za-z0-9./]{53}/, // bcrypt 형식
      applicationSecretAlt: /\b[A-Za-z0-9+/=]{40,80}\b/,      // base64 fallback
    },
  };

  // 실제 노출 가능한 키 종류와 라벨
  const KIND_LABELS = {
    vendorId: 'Vendor ID',
    accessKey: 'Access Key',
    secretKey: 'Secret Key',
    applicationId: 'Application ID',
    applicationSecret: 'Application Secret',
  };

  // 마스킹 (popup 미리보기용 — Secret만 마스킹, ID는 그대로)
  function maskValue(kind, value) {
    if (!value) return '';
    const isSecret = /secret/i.test(kind);
    if (!isSecret) return value;
    if (value.length <= 8) return '••••' + value.slice(-2);
    return value.slice(0, 4) + '••••' + value.slice(-4);
  }

  // 키 종류 추정 — 이미 어떤 input에 포커스되어 있는지 hint
  function detectKind(text, market, hint) {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (trimmed.length < 8 || trimmed.length > 200) return null;

    const map = PATTERNS[market];
    if (!map) return null;

    // hint가 있으면 hint 패턴 우선 매칭 (포커스된 입력칸 = 신뢰도 높음)
    if (hint && map[hint]) {
      const re = map[hint];
      if (re.test(trimmed)) return { kind: hint, value: trimmed };
    }

    // hint 없으면 순서대로 시도 (vendorId → accessKey → secretKey)
    const order = market === 'coupang'
      ? ['vendorId', 'accessKey', 'secretKey']
      : ['applicationId', 'applicationSecret'];

    for (const kind of order) {
      const re = map[kind];
      if (re && re.test(trimmed)) return { kind, value: trimmed };
    }

    // 폴백 패턴 (Alt suffix)
    if (market === 'coupang' && PATTERNS.coupang.accessKeyAlt.test(trimmed)) {
      return { kind: 'accessKey', value: trimmed };
    }
    if (market === 'naver' && PATTERNS.naver.applicationSecretAlt.test(trimmed)) {
      return { kind: 'applicationSecret', value: trimmed };
    }

    return null;
  }

  // 노드 테스트 등에서 navigator는 global 또는 window 어디든 있을 수 있음.
  // 호출 시점에 동적으로 조회 (테스트 환경에서 navigator 교체 가능).
  function getNavigator() {
    if (typeof navigator !== 'undefined' && navigator) return navigator;
    if (global && global.navigator) return global.navigator;
    if (typeof globalThis !== 'undefined' && globalThis.navigator) return globalThis.navigator;
    return null;
  }

  // 환경 체크 — Web Clipboard API 사용 가능 여부
  function isClipboardSupported() {
    const nav = getNavigator();
    return Boolean(nav && nav.clipboard && typeof nav.clipboard.readText === 'function');
  }

  // iOS Safari 감지 (권한 정책 다름)
  function isIOSSafari() {
    const nav = getNavigator();
    const ua = (nav && nav.userAgent) || '';
    return /iP(hone|ad|od)/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS/.test(ua);
  }

  // 안전한 클립보드 읽기 — 권한 거부 시 null 반환 (throw X)
  async function safeReadClipboard() {
    if (!isClipboardSupported()) return null;
    const nav = getNavigator();
    try {
      const text = await nav.clipboard.readText();
      return typeof text === 'string' ? text : null;
    } catch (err) {
      // 권한 거부, 보안 컨텍스트 아님, focus 없음 등
      // 모두 silent fail — 사용자는 일반 입력 폼으로 폴백
      return null;
    }
  }

  // 마지막으로 처리한 값 — 같은 값을 두 번 묻지 않기
  function createDetector(opts) {
    const options = Object.assign({
      market: 'coupang',
      onDetect: function () {},   // (kind, value) => void
      onPopup: null,              // (params) => Promise<boolean>  — 사용자 confirm UI 주입
      hint: null,                 // 'vendorId' / 'accessKey' / ...
      cooldownMs: 1500,           // 같은 값 중복 처리 방지
      pollOnVisibility: true,     // 탭이 다시 보일 때 자동 체크
    }, opts || {});

    let _lastSeen = '';
    let _lastSeenAt = 0;
    let _running = false;
    let _onVisibilityChange = null;
    let _supported = isClipboardSupported() && !isIOSSafari();

    async function checkClipboard(triggerHint) {
      if (!_running) return;
      const text = await safeReadClipboard();
      if (!text) return;
      const now = Date.now();
      if (text === _lastSeen && (now - _lastSeenAt) < options.cooldownMs) return;
      _lastSeen = text;
      _lastSeenAt = now;

      const detected = detectKind(text, options.market, triggerHint || options.hint);
      if (!detected) return;

      const popupParams = {
        kind: detected.kind,
        label: KIND_LABELS[detected.kind] || detected.kind,
        masked: maskValue(detected.kind, detected.value),
        market: options.market,
      };

      // popup 주입 콜백이 있으면 호출 (사용자 [예/아니오])
      if (typeof options.onPopup === 'function') {
        let approved = false;
        try { approved = Boolean(await options.onPopup(popupParams)); } catch (_) { approved = false; }
        if (approved) options.onDetect(detected.kind, detected.value);
        return;
      }

      // popup 없으면 즉시 onDetect (자동 입력은 위자드 명시 동의 후만)
      options.onDetect(detected.kind, detected.value);
    }

    function start() {
      if (!_supported) return false;
      if (_running) return true;
      _running = true;

      // 탭 visibility 변경 감지 — 사용자가 마켓 탭에서 돌아옴
      if (options.pollOnVisibility && typeof document !== 'undefined') {
        _onVisibilityChange = function () {
          if (document.visibilityState === 'visible') {
            // 약간의 딜레이 — focus 안정화 후 readText
            setTimeout(function () { checkClipboard('visibility'); }, 200);
          }
        };
        document.addEventListener('visibilitychange', _onVisibilityChange);
      }

      return true;
    }

    function stop() {
      _running = false;
      if (_onVisibilityChange && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', _onVisibilityChange);
        _onVisibilityChange = null;
      }
    }

    // 외부 트리거 — 사용자가 입력칸 클릭, "다시 확인" 버튼 클릭 시
    function trigger(hint) {
      return checkClipboard(hint);
    }

    return {
      start, stop, trigger,
      isSupported: function () { return _supported; },
      isRunning: function () { return _running; },
    };
  }

  // ====================================================================
  // export
  // ====================================================================
  const ClipboardDetector = {
    create: createDetector,
    detectKind: detectKind,
    maskValue: maskValue,
    isClipboardSupported: isClipboardSupported,
    isIOSSafari: isIOSSafari,
    PATTERNS: PATTERNS,
    KIND_LABELS: KIND_LABELS,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ClipboardDetector;
  }
  if (global) {
    global.ClipboardDetector = ClipboardDetector;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
