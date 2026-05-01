// collect-marketplace-claims.js — 마켓 클레임 수집 cron (30분마다)
// 스케줄: "*/30 * * * *"
// 수동 트리거: Authorization: Bearer ${LUMI_SECRET}

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyLumiSecret } = require('./_shared/auth');

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

/**
 * 쿠팡 클레임 수집
 * TODO: coupang-adapter에 fetchClaims() 추가 시 교체
 * - GET /v2/providers/seller_api/apis/api/v1/orders/claim?claimType=CANCEL&createdAt=...
 * - GET /v2/providers/seller_api/apis/api/v1/orders/claim?claimType=RETURN&createdAt=...
 * - GET /v2/providers/seller_api/apis/api/v1/orders/claim?claimType=EXCHANGE&createdAt=...
 */
async function fetchCoupangClaims(sellerId, credentials) {
  // TODO: 실 연동 전 placeholder
  console.log(`[collect-claims] coupang seller=${sellerId} — placeholder, 실 연동 필요`);
  return [];
}

/**
 * 네이버 클레임 수집
 * TODO: naver-adapter에 fetchClaims() 추가 시 교체
 * - POST /external/v1/pay-user/claim/cancel/list
 * - POST /external/v1/pay-user/claim/return/list
 * - POST /external/v1/pay-user/claim/exchange/list
 */
async function fetchNaverClaims(sellerId, credentials) {
  // TODO: 실 연동 전 placeholder
  console.log(`[collect-claims] naver seller=${sellerId} — placeholder, 실 연동 필요`);
  return [];
}

/**
 * 토스 클레임 수집
 * TODO: toss-adapter에 fetchClaims() 추가 시 교체
 * - GET /v1/claim/list?type=CANCEL&from=...
 * - GET /v1/claim/list?type=RETURN&from=...
 * - GET /v1/claim/list?type=EXCHANGE&from=...
 */
async function fetchTossClaims(sellerId, credentials) {
  // TODO: 실 연동 전 placeholder
  console.log(`[collect-claims] toss seller=${sellerId} — placeholder, 실 연동 필요`);
  return [];
}

/**
 * 마켓별 raw 클레임을 marketplace_claims 스키마로 정규화
 * @param {string} market
 * @param {string} sellerId
 * @param {object[]} rawClaims
 * @returns {object[]}
 */
function normalizeClaims(market, sellerId, rawClaims) {
  return rawClaims.map((raw) => ({
    seller_id: sellerId,
    market,
    market_claim_id: String(raw.claimId || raw.claim_id || raw.id || ''),
    claim_type: mapClaimType(raw.claimType || raw.claim_type || raw.type || ''),
    status: 'pending',
    reason: raw.reason || raw.claimReason || null,
    buyer_message: raw.buyerMessage || raw.buyer_message || null,
    marketplace_order_id: null, // TODO: marketplace_orders와 매핑 필요
    collected_at: new Date().toISOString(),
    created_at: raw.createdAt || raw.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })).filter((c) => c.market_claim_id && c.claim_type);
}

function mapClaimType(raw) {
  const s = String(raw).toLowerCase();
  if (s.includes('cancel')) return 'cancel';
  if (s.includes('return') || s.includes('refund')) return 'return';
  if (s.includes('exchange')) return 'exchange';
  if (s.includes('inquiry') || s.includes('question')) return 'inquiry';
  return null;
}

async function runCollect(event) {
  const admin = getAdminClient();

  // 연동된 셀러 목록 조회 (coupang/naver/toss credentials)
  // TODO: 실 연동 시 market_credentials 테이블에서 credentials 조회
  const { data: sellers, error: sErr } = await admin
    .from('sellers')
    .select('id')
    .limit(200);

  if (sErr) {
    console.error('[collect-claims] sellers 조회 실패:', sErr.message);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: 'sellers 조회 실패' }),
    };
  }

  let totalUpserted = 0;
  let totalSkipped = 0;
  const errors = [];

  for (const seller of (sellers || [])) {
    const sellerId = seller.id;

    // 각 마켓 클레임 수집 (placeholder — 실 연동 시 credentials 전달)
    const [coupangRaw, naverRaw, tossRaw] = await Promise.allSettled([
      fetchCoupangClaims(sellerId, {}),
      fetchNaverClaims(sellerId, {}),
      fetchTossClaims(sellerId, {}),
    ]);

    const allNormalized = [
      ...normalizeClaims('coupang', sellerId, coupangRaw.status === 'fulfilled' ? coupangRaw.value : []),
      ...normalizeClaims('naver', sellerId, naverRaw.status === 'fulfilled' ? naverRaw.value : []),
      ...normalizeClaims('toss', sellerId, tossRaw.status === 'fulfilled' ? tossRaw.value : []),
    ];

    if (allNormalized.length === 0) continue;

    // UNIQUE(market, market_claim_id) 기반 upsert — 기존 데이터 덮어쓰기 방지
    const { error: upsertErr, count } = await admin
      .from('marketplace_claims')
      .upsert(allNormalized, {
        onConflict: 'market,market_claim_id',
        ignoreDuplicates: true, // 이미 존재하는 건은 status 변경 없이 스킵
        count: 'exact',
      });

    if (upsertErr) {
      console.error(`[collect-claims] seller=${sellerId} upsert 오류:`, upsertErr.message);
      errors.push({ sellerId, error: upsertErr.message });
    } else {
      totalUpserted += count || 0;
      totalSkipped += allNormalized.length - (count || 0);
    }
  }

  console.log(`[collect-claims] 완료 — upserted=${totalUpserted} skipped=${totalSkipped} sellers=${sellers?.length || 0}`);

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      success: true,
      upserted: totalUpserted,
      skipped: totalSkipped,
      sellers: sellers?.length || 0,
      errors: errors.length > 0 ? errors : undefined,
    }),
  };
}

exports.handler = async (event) => {
  const bodyObj = (() => { try { return JSON.parse(event?.body || '{}'); } catch (_) { return {}; } })();
  const isScheduled = !event || !event.httpMethod || !!bodyObj.next_run;

  // 수동 트리거 인증 확인 (scheduled-ig-token-refresh-background.js 패턴)
  if (!isScheduled) {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: HEADERS, body: '' };
    }
    const authHeader = (event.headers && (
      event.headers['authorization'] || event.headers['Authorization'] || ''
    )).replace(/^Bearer\s+/i, '');
    const xSecret = event.headers && (
      event.headers['x-lumi-secret'] || event.headers['X-Lumi-Secret'] || ''
    );
    const provided = authHeader || xSecret;
    if (!verifyLumiSecret(provided)) {
      return {
        statusCode: 401,
        headers: HEADERS,
        body: JSON.stringify({ error: '인증 실패' }),
      };
    }
  }

  try {
    return await runCollect(event);
  } catch (e) {
    console.error('[collect-claims] 크래시:', e.message, e.stack);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: e.message }),
    };
  }
};

module.exports.config = {
  schedule: '*/30 * * * *',
};
