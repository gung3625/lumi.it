// Sprint 3.6 — Audit Log 모듈 (append-only 감사 로그)
// 메모리: project_phase1_strategic_differentiation (Privacy-by-Design)
// 모든 주요 액션을 audit_logs 테이블에 기록한다.
//
// 사용 패턴:
//   const audit = require('./_shared/audit-log');
//   await audit.log(adminClient, {
//     actorId: sellerId, actorType: 'seller',
//     action: 'order.unmask', resourceType: 'order', resourceId: orderId,
//     metadata: { field: 'phone' },
//     event,  // Netlify event (IP/UA 추출용)
//   });

const crypto = require('crypto');

/**
 * Netlify event에서 IP·UA 추출 (PII 로그 회피 목적)
 * @param {Object} event Netlify handler event
 */
function extractRequestMeta(event) {
  if (!event || !event.headers) return { ip_address: null, user_agent: null };
  const h = event.headers || {};
  const fwd = h['x-forwarded-for'] || h['X-Forwarded-For'] || '';
  const ip = (typeof fwd === 'string' ? fwd.split(',')[0] : '').trim()
    || h['x-nf-client-connection-ip']
    || h['client-ip']
    || null;
  const ua = h['user-agent'] || h['User-Agent'] || null;
  return { ip_address: ip, user_agent: ua ? String(ua).slice(0, 512) : null };
}

/**
 * 무결성 해시 계산 — 이전 hash + 현재 row JSON 의 sha256
 * @param {string|null} prevHash
 * @param {Object} payload
 */
function computeIntegrityHash(prevHash, payload) {
  const h = crypto.createHash('sha256');
  h.update(String(prevHash || ''));
  h.update('\n');
  h.update(JSON.stringify(payload, Object.keys(payload).sort()));
  return h.digest('hex');
}

/**
 * 감사 로그 1건 기록 (best-effort — 실패해도 호출자 흐름은 막지 않음)
 * @param {Object} admin Supabase admin client (createClient(serviceRole))
 * @param {Object} entry
 *   - actorId, actorType ('seller'|'system'|'admin')
 *   - action (예: 'signup.consent', 'order.unmask', 'cancellation.request')
 *   - resourceType, resourceId
 *   - metadata (PII 평문 금지 — 마스킹/해시만 허용)
 *   - event (Netlify event, optional)
 */
async function log(admin, entry) {
  if (!admin) return { skipped: 'no_admin' };
  const meta = extractRequestMeta(entry.event);
  const safeMetadata = sanitizeMetadata(entry.metadata || {});

  // 이전 hash 조회 (체인 무결성 — 실패 시 null로 진행)
  let prevHash = null;
  try {
    const { data: prev } = await admin
      .from('audit_logs')
      .select('integrity_hash')
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();
    prevHash = prev && prev.integrity_hash ? prev.integrity_hash : null;
  } catch {
    prevHash = null;
  }

  const row = {
    actor_id: entry.actorId || null,
    actor_type: entry.actorType || 'system',
    action: entry.action,
    resource_type: entry.resourceType || null,
    resource_id: entry.resourceId ? String(entry.resourceId) : null,
    metadata: safeMetadata,
    ip_address: meta.ip_address,
    user_agent: meta.user_agent,
  };
  row.integrity_hash = computeIntegrityHash(prevHash, row);

  try {
    const { error } = await admin.from('audit_logs').insert(row);
    if (error) {
      console.error('[audit-log] insert 실패:', error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (e) {
    console.error('[audit-log] 예외:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * metadata에서 PII로 의심되는 키를 자동 제거 — 평문 로그 절대 금지
 */
function sanitizeMetadata(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const FORBIDDEN_KEYS = new Set([
    'password', 'access_key', 'secret_key', 'access_token', 'refresh_token',
    'token', 'api_key', 'card_number', 'card_no', 'cvv', 'cvc',
    'buyer_name', 'buyer_phone', 'buyer_address', 'buyer_email',
    'name_plain', 'phone_plain', 'address_plain', 'email_plain',
  ]);
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (FORBIDDEN_KEYS.has(String(k).toLowerCase())) continue;
    if (typeof v === 'string' && v.length > 500) {
      out[k] = `${v.slice(0, 500)}...[truncated]`;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * 마스킹 해제 이벤트 별도 기록
 */
async function logUnmask(admin, entry) {
  const meta = extractRequestMeta(entry.event);
  try {
    const { error } = await admin.from('pii_unmask_events').insert({
      seller_id: entry.sellerId,
      resource_type: entry.resourceType,
      resource_id: String(entry.resourceId),
      field: entry.field || 'all',
      reason: entry.reason || null,
      ip_address: meta.ip_address,
      user_agent: meta.user_agent,
    });
    if (error) console.error('[audit-log] unmask insert 실패:', error.message);
  } catch (e) {
    console.error('[audit-log] unmask 예외:', e.message);
  }
  // audit_logs에도 흔적 남김
  return log(admin, {
    actorId: entry.sellerId,
    actorType: 'seller',
    action: `${entry.resourceType}.unmask`,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    metadata: { field: entry.field, reason: entry.reason || null },
    event: entry.event,
  });
}

/**
 * 동의 1건 기록 (consent_type별로 가장 최근 행이 현재 상태)
 */
async function logConsent(admin, { sellerId, consentType, consentVersion = 'v1', granted, event }) {
  const meta = extractRequestMeta(event);
  try {
    const { error } = await admin.from('seller_consents').insert({
      seller_id: sellerId,
      consent_type: consentType,
      consent_version: consentVersion,
      granted: Boolean(granted),
      ip_address: meta.ip_address,
      user_agent: meta.user_agent,
    });
    if (error) console.error('[audit-log] consent insert 실패:', error.message);
  } catch (e) {
    console.error('[audit-log] consent 예외:', e.message);
  }
  return log(admin, {
    actorId: sellerId,
    actorType: 'seller',
    action: granted ? 'consent.grant' : 'consent.revoke',
    resourceType: 'consent',
    resourceId: consentType,
    metadata: { version: consentVersion },
    event,
  });
}

module.exports = {
  log,
  logUnmask,
  logConsent,
  extractRequestMeta,
  computeIntegrityHash,
  sanitizeMetadata,
};
