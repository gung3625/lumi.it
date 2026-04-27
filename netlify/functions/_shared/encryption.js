// 자격증명 암복호화 헬퍼 (AES-256-GCM)
// - ENCRYPTION_KEY 환경변수: 32바이트 키의 base64 인코딩 (44자) 또는 hex (64자)
// - 결과는 { ciphertext, iv, tag } 객체 (모두 base64) — DB JSONB로 저장 가능
// - PostgreSQL pgcrypto 의존 없음, Node 표준 crypto만 사용
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY 환경변수가 설정되지 않았습니다.');
  // base64 (44자, '=' 패딩 포함) 우선 시도
  if (/^[A-Za-z0-9+/]{43}=?$/.test(raw)) {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 32) return buf;
  }
  // hex 64자 fallback
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  throw new Error('ENCRYPTION_KEY 형식 오류 — base64(32바이트) 또는 hex(64자)이어야 합니다.');
}

/**
 * 평문(JSON 직렬화 가능 객체 또는 문자열) → 암호문 객체
 * @param {object|string} plaintext
 * @returns {{ ciphertext: string, iv: string, tag: string }}
 */
function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const data = typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext);
  const enc = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: enc.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/**
 * 암호문 객체 → 평문 (JSON parse 시도, 실패 시 문자열)
 * @param {{ ciphertext: string, iv: string, tag: string }} payload
 * @returns {object|string}
 */
function decrypt(payload) {
  if (!payload || !payload.ciphertext || !payload.iv || !payload.tag) {
    throw new Error('암호문 형식이 올바르지 않습니다.');
  }
  const key = getKey();
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  try { return JSON.parse(dec); } catch { return dec; }
}

/**
 * 짧은 토큰을 그대로 base64 암호화 (encrypt의 string 형태 wrapper) — 결과는 단일 문자열
 * 형식: <ciphertext>.<iv>.<tag>
 */
function encryptToken(token) {
  const { ciphertext, iv, tag } = encrypt(String(token));
  return `${ciphertext}.${iv}.${tag}`;
}

function decryptToken(serialized) {
  if (!serialized || typeof serialized !== 'string') return null;
  const [ciphertext, iv, tag] = serialized.split('.');
  if (!ciphertext || !iv || !tag) throw new Error('토큰 형식이 올바르지 않습니다.');
  return decrypt({ ciphertext, iv, tag });
}

/**
 * 키 부재 시 dev 모드 fallback — 암호화 없이 base64만 (절대 production 금지)
 */
function isAvailable() {
  try { getKey(); return true; } catch { return false; }
}

module.exports = { encrypt, decrypt, encryptToken, decryptToken, isAvailable };
