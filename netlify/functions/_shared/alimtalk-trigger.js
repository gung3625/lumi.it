// alimtalk-trigger.js — 알림톡 자동 발송 트리거
// 5 이벤트 (new_order / tracking_overdue / cs_urgent / refund_request / low_stock)에서
// 호출되는 단일 진입점.
// Rate limit · 셀러 ON/OFF · template 미승인 = mock 모드 처리.
//
// M4 hotfix: checkAndIncrementRateLimit — atomic upsert via RPC
// (INSERT ... ON CONFLICT DO UPDATE, race-safe)
// migrations/2026-04-29-atomic-rate-limit-rpc.sql 참조

const crypto = require('crypto');
const { maskPhone, normalizePhone } = require('./onboarding-utils');

// ------------------------------------------------------------------
// 상수
// ------------------------------------------------------------------
const VALID_TYPES = new Set([
  'new_order',
  'tracking_overdue',
  'cs_urgent',
  'refund_request',
  'low_stock',
]);

const DAILY_LIMIT = 30;            // 셀러당 일 30건
const PER_TYPE_WINDOW_MIN = 30;    // 동일 타입 30분 윈도우
const SOLAPI_API_KEY = process.env.SOLAPI_API_KEY;
const SOLAPI_API_SECRET = process.env.SOLAPI_API_SECRET;

// ------------------------------------------------------------------
// Solapi HMAC 헤더
// ------------------------------------------------------------------
function getSolapiAuthHeader() {
  if (!SOLAPI_API_KEY || !SOLAPI_API_SECRET) return null;
  const date = new Date().toISOString();
  const salt = Math.random().toString(36).substring(2, 12);
  const signature = crypto
    .createHmac('sha256', SOLAPI_API_SECRET)
    .update(date + salt)
    .digest('hex');
  return `HMAC-SHA256 apiKey=${SOLAPI_API_KEY}, date=${date}, salt=${salt}, signature=${signature}`;
}

// ------------------------------------------------------------------
// 변수 치환 (#{이름} → 실제 값)
// ------------------------------------------------------------------
function renderTemplate(bodyTemplate, variables) {
  if (!bodyTemplate) return '';
  let out = bodyTemplate;
  for (const [k, v] of Object.entries(variables || {})) {
    const safe = String(v == null ? '' : v).slice(0, 200);
    out = out.split(`#{${k}}`).join(safe);
  }
  return out;
}

// ------------------------------------------------------------------
// Rate limit 체크 + 카운트 증가 (M4: atomic — bump_alimtalk_rate_limit_atomic RPC)
// 동시 호출에도 INSERT ... ON CONFLICT DO UPDATE로 안전.
// RPC 미배포 시 SELECT-then-UPSERT legacy fallback.
// ------------------------------------------------------------------
async function checkAndIncrementRateLimit(admin, sellerId, type) {
  const now = new Date();
  const dailyKey = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const bucketIdx = Math.floor((now.getUTCHours() * 60 + now.getUTCMinutes()) / PER_TYPE_WINDOW_MIN);
  const perTypeKey = `${type}:${dailyKey}:${bucketIdx}`;
  const nowIso = now.toISOString();

  // 1) RPC atomic 시도 (daily)
  const dailyRpc = await admin.rpc('bump_alimtalk_rate_limit_atomic', {
    p_seller_id: sellerId,
    p_window_kind: 'daily',
    p_window_key: dailyKey,
  }).catch(() => ({ error: true, data: null }));

  if (!dailyRpc.error && Array.isArray(dailyRpc.data)) {
    const dailyCount = dailyRpc.data[0]?.count ?? 0;
    if (dailyCount > DAILY_LIMIT) {
      return { allowed: false, reason: `일 ${DAILY_LIMIT}건 한도 초과` };
    }
    // per-type 30분 atomic
    const typeRpc = await admin.rpc('bump_alimtalk_rate_limit_atomic', {
      p_seller_id: sellerId,
      p_window_kind: 'per_type_30min',
      p_window_key: perTypeKey,
    }).catch(() => ({ error: true, data: null }));

    if (!typeRpc.error && Array.isArray(typeRpc.data)) {
      const typeCount = typeRpc.data[0]?.count ?? 0;
      if (typeCount > 1) {
        return { allowed: false, reason: '동일 알림 30분 1회 제한' };
      }
      return { allowed: true };
    }
    // typeRpc 실패 → fallback
  }

  // ──────── Legacy fallback (RPC 미배포) ────────
  const { data: dailyRow } = await admin
    .from('alimtalk_rate_limit')
    .select('count')
    .eq('seller_id', sellerId)
    .eq('window_kind', 'daily')
    .eq('window_key', dailyKey)
    .maybeSingle();
  if (dailyRow && dailyRow.count >= DAILY_LIMIT) {
    return { allowed: false, reason: `일 ${DAILY_LIMIT}건 한도 초과` };
  }
  const { data: typeRow } = await admin
    .from('alimtalk_rate_limit')
    .select('count')
    .eq('seller_id', sellerId)
    .eq('window_kind', 'per_type_30min')
    .eq('window_key', perTypeKey)
    .maybeSingle();
  if (typeRow && typeRow.count >= 1) {
    return { allowed: false, reason: '동일 알림 30분 1회 제한' };
  }
  await admin.from('alimtalk_rate_limit').upsert({
    seller_id: sellerId,
    window_kind: 'daily',
    window_key: dailyKey,
    count: (dailyRow?.count || 0) + 1,
    last_at: nowIso,
  }, { onConflict: 'seller_id,window_kind,window_key' });
  await admin.from('alimtalk_rate_limit').upsert({
    seller_id: sellerId,
    window_kind: 'per_type_30min',
    window_key: perTypeKey,
    count: (typeRow?.count || 0) + 1,
    last_at: nowIso,
  }, { onConflict: 'seller_id,window_kind,window_key' });
  return { allowed: true };
}

// ------------------------------------------------------------------
// 외부 발송 (Solapi) — 승인된 템플릿이면 ATA, 없으면 mock
// ------------------------------------------------------------------
async function sendViaSolapi(toPhone, template, renderedBody, variables) {
  if (!SOLAPI_API_KEY || !SOLAPI_API_SECRET) {
    return { ok: false, status: 'mock', reason: 'SOLAPI 환경변수 미설정' };
  }
  const auth = getSolapiAuthHeader();
  if (!auth) return { ok: false, status: 'mock', reason: 'auth 헤더 생성 실패' };

  if (!template.template_id) {
    return { ok: false, status: 'mock', reason: '템플릿 미승인 (검수 대기)' };
  }

  const channelId = template.channel_id || 'KA01PF26032219112677567W26lSNGQj';
  const body = {
    message: {
      to: toPhone,
      from: channelId,
      type: 'ATA',
      kakaoOptions: {
        pfId: channelId,
        templateId: template.template_id,
        variables: Object.fromEntries(
          Object.entries(variables || {}).map(([k, v]) => [`#{${k}}`, String(v == null ? '' : v).slice(0, 200)])
        ),
      },
    },
  };

  try {
    const res = await fetch('https://api.solapi.com/messages/v4/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': auth },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, status: 'failed', reason: `Solapi ${res.status}`, raw: data };
    }
    return { ok: true, status: 'sent', messageId: data?.messageId || data?.groupId || null, raw: data };
  } catch (e) {
    return { ok: false, status: 'failed', reason: e.message };
  }
}

// ------------------------------------------------------------------
// 핵심: triggerAlimtalk — 절대 throw 안 함
// ------------------------------------------------------------------
/**
 * @param {object} admin - Supabase admin client
 * @param {object} params
 * @param {string} params.sellerId
 * @param {string} params.type - new_order|tracking_overdue|cs_urgent|refund_request|low_stock
 * @param {object} params.variables
 * @param {string} [params.overridePhone]
 * @returns {Promise<{status: string, reason?: string, history_id?: string}>}
 */
async function triggerAlimtalk(admin, params) {
  const { sellerId, type, variables = {}, overridePhone = null } = params || {};

  if (!sellerId) return { status: 'skipped', reason: 'sellerId 누락' };
  if (!VALID_TYPES.has(type)) return { status: 'skipped', reason: '알 수 없는 타입' };
  if (!admin) return { status: 'mock', reason: 'admin client 없음 (테스트 환경)' };

  try {
    // 템플릿 조회
    const { data: template, error: tErr } = await admin
      .from('alimtalk_templates')
      .select('template_type, template_id, template_code, channel_id, status, body_template, variables, title')
      .eq('template_type', type)
      .maybeSingle();
    if (tErr || !template) {
      return await recordHistory(admin, { sellerId, type, toPhoneMasked: '***', variables, status: 'failed', reason: '템플릿 미존재' });
    }

    // 셀러 설정 조회
    const { data: setting } = await admin
      .from('alimtalk_settings')
      .select('enabled, override_phone')
      .eq('seller_id', sellerId)
      .eq('template_type', type)
      .maybeSingle();
    if (setting && setting.enabled === false) {
      return await recordHistory(admin, { sellerId, type, toPhoneMasked: '***', variables, status: 'skipped', reason: '셀러 OFF' });
    }

    // 수신번호 결정
    let toPhone = normalizePhone(overridePhone || setting?.override_phone || '');
    if (!toPhone) {
      const { data: seller } = await admin
        .from('sellers')
        .select('phone')
        .eq('id', sellerId)
        .maybeSingle();
      toPhone = normalizePhone(seller?.phone || '');
    }
    if (!toPhone) {
      return await recordHistory(admin, { sellerId, type, toPhoneMasked: '***', variables, status: 'skipped', reason: '수신번호 없음' });
    }

    // Rate limit (M4: atomic)
    const rl = await checkAndIncrementRateLimit(admin, sellerId, type);
    if (!rl.allowed) {
      return await recordHistory(admin, { sellerId, type, toPhoneMasked: maskPhone(toPhone), variables, status: 'skipped', reason: rl.reason });
    }

    // 외부 발송
    const renderedBody = renderTemplate(template.body_template, variables);
    const sent = await sendViaSolapi(toPhone, template, renderedBody, variables);

    return await recordHistory(admin, {
      sellerId,
      type,
      toPhoneMasked: maskPhone(toPhone),
      variables,
      status: sent.status,
      reason: sent.reason || null,
      providerMessageId: sent.messageId || null,
      raw: sent.raw || null,
    });
  } catch (e) {
    console.error('[alimtalk-trigger] 예외:', e.message);
    return { status: 'failed', reason: e.message };
  }
}

// ------------------------------------------------------------------
// History 기록 (best-effort)
// ------------------------------------------------------------------
async function recordHistory(admin, opts) {
  const { sellerId, type, toPhoneMasked, variables, status, reason, providerMessageId, raw } = opts;
  try {
    const { data } = await admin.from('alimtalk_history').insert({
      seller_id: sellerId,
      template_type: type,
      to_phone_masked: toPhoneMasked || '***',
      variables: variables || {},
      status,
      reason: reason || null,
      provider_message_id: providerMessageId || null,
      raw_response: raw || null,
    }).select('id').single();
    return { status, reason: reason || null, history_id: data?.id || null };
  } catch (e) {
    console.error('[alimtalk-trigger] history 기록 실패:', e.message);
    return { status, reason: reason || null };
  }
}

module.exports = {
  triggerAlimtalk,
  renderTemplate,
  VALID_TYPES,
  DAILY_LIMIT,
  PER_TYPE_WINDOW_MIN,
  _checkAndIncrementRateLimit: checkAndIncrementRateLimit,
};
