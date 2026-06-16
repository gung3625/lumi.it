// payapp-webhook.js — PayApp 결제결과 콜백(feedbackurl·failurl). 공개·무인증 POST.
//
// PayApp 이 결제완료/자동청구/정기결제 실패마다 x-www-form-urlencoded POST 한다.
// 검증: userid+linkkey+linkval 을 env 와 timing-safe 비교(해시 없음) → 위변조 차단.
// 멱등/감사: mul_no(매 청구 고유)를 PK 로 기록. 응답은 반드시 본문 'SUCCESS'(아니면 재통보).
//   pay_state: 4=결제완료(최초/자동청구 성공), 99=정기 자동청구 실패(2회차+, 문서 확인).
'use strict';

const { getAdminClient } = require('./_shared/supabase-admin');
const { safeEqual } = require('./_shared/auth');
const { SUBSCRIPTION_PRICE } = require('./_shared/payapp');

function textResp(statusCode, text) {
  return { statusCode, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return textResp(204, '');
  if (event.httpMethod !== 'POST') return textResp(405, 'METHOD');

  let raw = event.body || '';
  if (event.isBase64Encoded) {
    try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch (_) { /* noop */ }
  }
  const body = new URLSearchParams(raw);

  const userid = body.get('userid') || '';
  const linkkey = body.get('linkkey') || '';
  const linkval = body.get('linkval') || '';
  const price = parseInt(body.get('price') || '0', 10);
  const payState = parseInt(body.get('pay_state') || '0', 10);
  const payType = parseInt(body.get('pay_type') || '0', 10);
  const mulNo = body.get('mul_no') || '';
  const rebillNo = body.get('rebill_no') || '';
  const var1 = body.get('var1') || '';

  // 감사용 raw — 시크릿(linkval/linkkey)·계정ID(userid) 제외하고 보존(분쟁 대비).
  const safeRaw = {};
  for (const [k, v] of body) {
    if (k !== 'linkval' && k !== 'linkkey' && k !== 'userid') safeRaw[k] = v;
  }

  // 1) 위변조 검증 — userid/linkkey/linkval 셋 다 env 와 일치해야. (linkval 은 절대 로그 금지)
  const okAuth =
    safeEqual(userid, process.env.PAYAPP_USERID) &&
    safeEqual(linkkey, process.env.PAYAPP_LINKKEY) &&
    safeEqual(linkval, process.env.PAYAPP_LINKVAL);
  if (!okAuth) {
    console.warn('[payapp-webhook] 위변조 검증 실패 — 무시');
    return textResp(200, 'FAIL');
  }

  // 2) admin client
  let admin;
  try { admin = getAdminClient(); }
  catch (e) { console.error('[payapp-webhook] admin client:', e.message); return textResp(500, 'ERROR'); }

  // 3) 처리 대상: 4=결제완료(최초/자동청구 성공), 99=정기 자동청구 실패(2회차+). 그 외 상태는 ack.
  if (payState !== 4 && payState !== 99) return textResp(200, 'SUCCESS');

  // 4) seller 식별 — var1(sellerId, subscribe 때 넣음) 우선, 없으면 rebill_no.
  let sellerRow = null;
  if (var1) {
    const { data } = await admin.from('sellers').select('id, subscription_status, subscription_started_at').eq('id', var1).maybeSingle();
    sellerRow = data;
  }
  if (!sellerRow && rebillNo) {
    const { data } = await admin.from('sellers').select('id, subscription_status, subscription_started_at').eq('payapp_rebill_no', rebillNo).maybeSingle();
    sellerRow = data;
  }

  // 감사 기록(best-effort, mul_no 있을 때만 — PK). 23505(중복 콜백) 무시.
  const audit = async (sid) => {
    if (!mulNo) return;
    const { error } = await admin.from('payapp_events').insert({
      mul_no: mulNo, rebill_no: rebillNo || null, seller_id: sid || null,
      pay_state: payState, pay_type: payType, price: price || null, var1: var1 || null, raw: safeRaw,
    });
    if (error && error.code !== '23505') console.warn('[payapp-webhook] payapp_events 기록 실패(무시):', error.message);
  };

  if (!sellerRow) {
    await audit(null);
    console.error('[payapp-webhook] seller 매칭 실패 (var1/rebill_no)');
    return textResp(200, 'SUCCESS'); // 재시도해도 매칭 불가
  }

  // 5) 상태 처리 — 멱등(재시도 안전). 상태 UPDATE 먼저, 감사 기록 best-effort.
  if (payState === 4) {
    // 결제완료(최초/자동청구). 금액 검증 후 활성화. price=0/NaN/누락 거부(falsy 우회 방지).
    if (price !== SUBSCRIPTION_PRICE) {
      console.warn(`[payapp-webhook] 금액 불일치 또는 누락: ${price}`);
      return textResp(200, 'FAIL');
    }
    const patch = { subscription_status: 'active', payapp_last_mul_no: mulNo };
    if (rebillNo) patch.payapp_rebill_no = rebillNo;
    if (!sellerRow.subscription_started_at) patch.subscription_started_at = new Date().toISOString();
    const { error: upErr } = await admin.from('sellers').update(patch).eq('id', sellerRow.id);
    if (upErr) {
      console.error('[payapp-webhook] 구독 활성 UPDATE 실패:', upErr.message);
      return textResp(500, 'ERROR'); // 조용히 넘기지 않음 — 재시도로 자가복구
    }
    await audit(sellerRow.id);
    console.log(`[payapp-webhook] activated seller=${String(sellerRow.id).slice(0, 8)} mul_no=${mulNo}`);
    return textResp(200, 'SUCCESS');
  }

  // payState === 99 — 정기 자동청구 실패(2회차+). active 일 때만 past_due (cancelled/stopped 보존).
  if (sellerRow.subscription_status === 'active') {
    const { error: upErr } = await admin.from('sellers').update({ subscription_status: 'past_due' }).eq('id', sellerRow.id);
    if (upErr) {
      console.error('[payapp-webhook] past_due UPDATE 실패:', upErr.message);
      return textResp(500, 'ERROR');
    }
    console.warn(`[payapp-webhook] 정기결제 실패 seller=${String(sellerRow.id).slice(0, 8)} → past_due`);
  }
  await audit(sellerRow.id);
  return textResp(200, 'SUCCESS');
};
