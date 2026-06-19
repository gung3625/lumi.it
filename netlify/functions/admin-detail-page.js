'use strict';
// admin-detail-page.js — 도매꾹 상품번호 → 세련된 소비자 상세페이지(카피+HTML) 자동 생성.
// 입력(POST): { no: 도매꾹상품번호, diffHook?, painPoints?, sellingHook?, model? }
//   diffHook/painPoints/sellingHook = 소싱 파이프라인이 만든 차별화 데이터(있으면 카피가 날카로워짐).
// 인증: Bearer LUMI_SECRET. 카피·HTML 생성은 _shared/detail-page.js 공유 모듈 사용(sensitive:false).
const { getItemView } = require('./_shared/domeggook-api');
const { generateDetailPage } = require('./_shared/detail-page');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};
const ok = (b) => ({ statusCode: 200, headers: CORS, body: JSON.stringify(b) });
const err = (c, m) => ({ statusCode: c, headers: CORS, body: JSON.stringify({ error: m }) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return err(405, 'POST만 허용됩니다.');
  const auth = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!process.env.LUMI_SECRET || auth !== process.env.LUMI_SECRET) return err(401, '인증 실패');

  let body; try { body = JSON.parse(event.body || '{}'); } catch (_) { return err(400, '잘못된 요청 형식'); }
  if (!body.no) return err(400, 'no(도매꾹 상품번호)가 필요합니다.');

  const product = await getItemView(body.no);
  if (!product) return err(502, '도매꾹 상품 조회 실패 (상품번호/DOMEGGOOK_API_KEY 확인)');

  const { copy, html, error } = await generateDetailPage(product, {
    diffHook: body.diffHook, painPoints: body.painPoints, sellingHook: body.sellingHook, model: body.model,
  });
  if (!copy) return err(502, 'LLM 상세페이지 생성 실패: ' + (error || '빈 응답'));

  return ok({
    product: { no: product.no, title: product.title, domePrice: product.domePrice, moq: product.moq, images: product.images },
    copy,
    html,
  });
};
