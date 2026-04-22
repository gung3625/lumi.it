// 회원 탈퇴 API — PIPA §36 (개인정보 파기 요구권) 대응
// POST /api/account-delete
// - 인증: Bearer JWT (현재 로그인 사용자만 자기 계정 삭제)
// - 확인: body.confirmation === "DELETE MY ACCOUNT"
// - 동작: 민감 테이블 CASCADE 삭제 + 결제/계약 레코드는 user_id NULL화 (전자상거래법 5년 보존 의무)
// - 감사 로그: account_deletion_log (user_id 해시·시각·IP만)
const crypto = require('crypto');
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { corsHeaders, getOrigin } = require('./_shared/auth');

const CONFIRMATION_PHRASE = 'DELETE MY ACCOUNT';

// 즉시 파기 대상 — user_id CASCADE FK 또는 수동 delete
const CASCADE_TABLES = [
  'auto_reply_log',
  'auto_reply_settings',
  'auto_reply_corrections',
  'store_context',
  'captions',
  'scheduled_posts',
  'reservations',
  'ig_accounts',
  'promo_schedule',
  'rate_limits',
  'oauth_nonces',
];

// user_id NULL화 대상 — 전자상거래법 5년 보존
// (본 배포에선 payments 테이블명이 확정되지 않았으므로 안전하게 옵셔널 처리)
const RETAIN_NULLIFY_TABLES = [
  'payments',
  'payment_history',
  'subscriptions',
];

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex');
}

function getClientIp(event) {
  const h = event.headers || {};
  return h['x-nf-client-connection-ip']
    || h['client-ip']
    || (h['x-forwarded-for'] || '').split(',')[0].trim()
    || 'unknown';
}

exports.handler = async (event) => {
  const CORS = corsHeaders(getOrigin(event), { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // 1. Bearer 토큰 검증
  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  // 2. body 파싱 + confirmation 문구 확인
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '잘못된 요청입니다.' }) };
  }

  if (body.confirmation !== CONFIRMATION_PHRASE) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: `확인 문구가 일치하지 않습니다. "${CONFIRMATION_PHRASE}" 를 정확히 입력하세요.` }),
    };
  }

  const admin = getAdminClient();
  const userId = user.id;
  const userHash = sha256Hex(userId);
  const clientIp = getClientIp(event);

  const cascadeResults = {};
  const nullifyResults = {};
  const softErrors = [];

  try {
    // 3. 감사 로그 먼저 기록 (삭제 도중 실패해도 흔적 남김) — 테이블 부재 시 스킵
    try {
      await admin.from('account_deletion_log').insert({
        user_id_hash: userHash,
        deleted_at: new Date().toISOString(),
        source_ip: clientIp,
      });
    } catch (e) {
      // 테이블 미존재 등 — 내부 로그만 남기고 계속 진행
      console.error('[account-delete] 감사 로그 기록 실패(계속 진행):', e.message);
    }

    // 4. CASCADE 테이블 삭제 (테이블 부재/권한 오류는 스킵)
    for (const table of CASCADE_TABLES) {
      try {
        const { error: delErr, count } = await admin
          .from(table)
          .delete({ count: 'exact' })
          .eq('user_id', userId);
        if (delErr) {
          softErrors.push(`${table}: ${delErr.message}`);
        } else {
          cascadeResults[table] = count ?? 0;
        }
      } catch (e) {
        softErrors.push(`${table}: ${e.message}`);
      }
    }

    // 5. 전자상거래법 보존 대상 user_id NULL화 (옵셔널 — 테이블 미존재면 스킵)
    for (const table of RETAIN_NULLIFY_TABLES) {
      try {
        const { error: upErr, count } = await admin
          .from(table)
          .update({ user_id: null }, { count: 'exact' })
          .eq('user_id', userId);
        if (upErr) {
          // 대부분 테이블 미존재 — 기록만 하고 스킵
          softErrors.push(`${table}: ${upErr.message}`);
        } else {
          nullifyResults[table] = count ?? 0;
        }
      } catch (e) {
        softErrors.push(`${table}: ${e.message}`);
      }
    }

    // 6. public.users 프로필 삭제
    try {
      await admin.from('users').delete().eq('id', userId);
    } catch (e) {
      console.error('[account-delete] users 프로필 삭제 실패:', e.message);
    }

    // 7. Supabase Auth 사용자 삭제 (service_role 필수) — 최종 단계
    const { error: authDelErr } = await admin.auth.admin.deleteUser(userId);
    if (authDelErr) {
      console.error('[account-delete] auth 사용자 삭제 실패:', authDelErr.message);
      return {
        statusCode: 500,
        headers: CORS,
        body: JSON.stringify({ error: '탈퇴 처리 중 오류가 발생했습니다. 고객센터로 문의해주세요.' }),
      };
    }

    console.log(`[account-delete] 완료 user_hash=${userHash.slice(0, 12)} soft_errors=${softErrors.length}`);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        deleted: true,
        retainedRecords: ['payment_5y'],
        purged: cascadeResults,
        nullified: nullifyResults,
      }),
    };
  } catch (err) {
    console.error('[account-delete] 예외:', err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: '탈퇴 처리 중 오류가 발생했습니다. 고객센터로 문의해주세요.' }),
    };
  }
};
