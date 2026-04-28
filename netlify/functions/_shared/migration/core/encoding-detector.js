// 인코딩 자동 감지 — Sprint 3.5 마이그레이션
// EUC-KR (CP949) vs UTF-8 자동 판별
//
// 사용처:
//   const encoding = detectEncoding(buffer);  // 'utf-8' | 'euc-kr' | 'binary'
//   xlsx.read(buffer, { type: 'buffer', codepage: encoding === 'euc-kr' ? 949 : 65001 });
//
// 설계:
// - BOM 우선 검사 (EF BB BF = UTF-8)
// - UTF-8 statistical validation (multi-byte sequence)
// - 한글 빈도 분석 (CP949 범위 vs UTF-8 한글 범위)
// - 엑셀 파일은 ZIP 컨테이너이므로 헤더 PK\x03\x04 → 'binary' 반환 (codepage 옵션 무시)

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const ZIP_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_HEADER = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]); // legacy XLS

/**
 * 버퍼의 인코딩 추정.
 * @param {Buffer|Uint8Array} buf
 * @returns {'utf-8'|'euc-kr'|'binary'}
 */
function detectEncoding(buf) {
  if (!buf || !Buffer.isBuffer(buf)) {
    if (buf && buf.byteLength) buf = Buffer.from(buf);
    else return 'utf-8';
  }
  if (buf.length === 0) return 'utf-8';

  // 1. 엑셀(XLSX/XLS) 바이너리 컨테이너 — codepage는 SheetJS가 시트별 처리
  if (buf.length >= 4) {
    if (buf.subarray(0, 4).equals(ZIP_HEADER)) return 'binary';
    if (buf.subarray(0, 4).equals(OLE_HEADER)) return 'binary';
  }

  // 2. UTF-8 BOM
  if (buf.length >= 3 && buf.subarray(0, 3).equals(UTF8_BOM)) return 'utf-8';

  // 3. CSV/텍스트 통계 분석 (앞 2KB 표본)
  const sample = buf.subarray(0, Math.min(buf.length, 2048));
  return statisticalGuess(sample);
}

/**
 * 한글 빈도 + UTF-8 valid sequence 검사로 인코딩 추정.
 * @param {Buffer} sample
 * @returns {'utf-8'|'euc-kr'}
 */
function statisticalGuess(sample) {
  let utf8Korean = 0;
  let eucKrCandidates = 0;
  let invalidUtf8 = 0;

  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];

    // ASCII는 둘 다 동일
    if (b < 0x80) continue;

    // UTF-8 한글: 0xEA~0xED + 2 byte (가-힣 범위)
    if (b >= 0xea && b <= 0xed && i + 2 < sample.length) {
      const b2 = sample[i + 1];
      const b3 = sample[i + 2];
      if (b2 >= 0x80 && b2 <= 0xbf && b3 >= 0x80 && b3 <= 0xbf) {
        utf8Korean++;
        i += 2;
        continue;
      }
    }

    // UTF-8 다른 multi-byte 시퀀스
    if (b >= 0xc2 && b <= 0xf4) {
      const expected = b < 0xe0 ? 1 : b < 0xf0 ? 2 : 3;
      let valid = i + expected < sample.length;
      for (let j = 1; j <= expected && valid; j++) {
        const cb = sample[i + j];
        if (cb < 0x80 || cb > 0xbf) valid = false;
      }
      if (valid) {
        i += expected;
        continue;
      }
      invalidUtf8++;
    }

    // EUC-KR: 0xA1~0xFE + 0xA1~0xFE (KS X 1001 lead/trail byte)
    if (b >= 0xa1 && b <= 0xfe && i + 1 < sample.length) {
      const b2 = sample[i + 1];
      if (b2 >= 0xa1 && b2 <= 0xfe) {
        eucKrCandidates++;
      }
    }

    // CP949 확장 lead byte
    if (b >= 0x81 && b <= 0xa0 && i + 1 < sample.length) {
      eucKrCandidates++;
    }
  }

  // 결정 룰:
  // - UTF-8 한글이 많고 invalid가 적으면 UTF-8
  // - EUC-KR 후보가 한글 UTF-8보다 많으면 EUC-KR
  if (utf8Korean >= 3 && invalidUtf8 === 0) return 'utf-8';
  if (eucKrCandidates > utf8Korean * 2 && eucKrCandidates >= 5) return 'euc-kr';
  if (invalidUtf8 > 0) return 'euc-kr';
  return 'utf-8';
}

/**
 * SheetJS codepage 번호 매핑.
 * @param {string} encoding
 * @returns {number|undefined}
 */
function toCodepage(encoding) {
  if (encoding === 'euc-kr') return 949;
  if (encoding === 'utf-8') return 65001;
  return undefined;
}

module.exports = {
  detectEncoding,
  toCodepage,
};
