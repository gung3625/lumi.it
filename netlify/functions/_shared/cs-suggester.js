// CS 답변 자동 생성 — Sprint 3
// 메모리 project_proactive_ux_paradigm.md 시나리오 5
// 기본 모드: 카테고리별 룰 기반 템플릿 (모킹).
// CS_SUGGEST_MOCK=false 또는 OPENAI_API_KEY 존재 시 GPT-4o-mini 호출.

/**
 * 카테고리별 룰 기반 답변 초안 (셀러 1탭 전송 가능)
 */
const TEMPLATE_BY_CATEGORY = {
  shipping: {
    title: '배송 안내',
    body: ({ buyer, productTitle, courier, trackingNumber }) => {
      const named = buyer ? `${buyer} 고객님,` : '고객님,';
      const product = productTitle ? `'${productTitle}' ` : '';
      if (courier && trackingNumber) {
        return `${named}\n주문하신 ${product}상품은 ${courier} 운송장 ${trackingNumber}로 발송되었어요. 보통 1~2일 내 도착하니 조금만 기다려 주세요. 감사합니다.`;
      }
      return `${named}\n주문하신 ${product}상품은 오늘 출고 예정이에요. 송장번호는 출고 직후 안내드릴게요. 조금만 기다려 주시면 감사하겠습니다.`;
    },
    confidence: 0.78,
  },
  exchange: {
    title: '교환 안내',
    body: ({ buyer, productTitle }) => {
      const named = buyer ? `${buyer} 고객님,` : '고객님,';
      const product = productTitle ? `'${productTitle}' ` : '';
      return `${named}\n${product}상품 교환 요청 잘 접수했어요. 회수 후 새 상품 발송까지 보통 3~5일 소요되니 안심하시고 기다려 주세요. 불편 드려 죄송합니다.`;
    },
    confidence: 0.74,
  },
  refund: {
    title: '환불 안내',
    body: ({ buyer }) => {
      const named = buyer ? `${buyer} 고객님,` : '고객님,';
      return `${named}\n환불 요청을 확인했어요. 상품 회수 후 1~3영업일 내 마켓을 통해 환불이 진행돼요. 진행 상황은 마켓 주문내역에서도 보이니 확인 부탁드릴게요.`;
    },
    confidence: 0.72,
  },
  product: {
    title: '상품 문의',
    body: ({ buyer, productTitle }) => {
      const named = buyer ? `${buyer} 고객님,` : '고객님,';
      const product = productTitle ? `'${productTitle}' ` : '';
      return `${named}\n${product}상품 문의 주셔서 감사해요. 상세 페이지의 정보가 정확하며, 추가 궁금하신 점은 언제든 말씀해 주세요.`;
    },
    confidence: 0.65,
  },
  other: {
    title: '문의 답변',
    body: ({ buyer }) => {
      const named = buyer ? `${buyer} 고객님,` : '고객님,';
      return `${named}\n문의 주셔서 감사해요. 빠르게 확인 후 안내드릴게요. 잠시만 기다려 주세요.`;
    },
    confidence: 0.55,
  },
};

/**
 * 문의 메시지 키워드 → 카테고리 자동 분류
 * @param {string} message
 * @returns {'shipping'|'exchange'|'refund'|'product'|'other'}
 */
function classifyCategory(message) {
  const t = String(message || '').toLowerCase();
  if (/(배송|출고|운송장|언제|도착|택배|발송)/.test(t)) return 'shipping';
  if (/(교환|반품받고|사이즈|색깔|컬러)/.test(t)) return 'exchange';
  if (/(환불|취소|결제 취소|돈|입금)/.test(t)) return 'refund';
  if (/(상품|재질|소재|사이즈|품질|모델|색상)/.test(t)) return 'product';
  return 'other';
}

/**
 * AI 답변 초안 생성
 * @param {Object} input
 * @param {string} input.message - 구매자 문의 본문
 * @param {string} [input.category] - 미지정 시 자동 분류
 * @param {string} [input.buyer_name_masked]
 * @param {string} [input.product_title]
 * @param {string} [input.courier]
 * @param {string} [input.tracking_number]
 * @param {boolean} [input.mock]
 * @returns {Promise<{ category: string, response: string, confidence: number, model: string }>}
 */
async function suggestReply(input) {
  const category = input.category || classifyCategory(input.message);
  const tpl = TEMPLATE_BY_CATEGORY[category] || TEMPLATE_BY_CATEGORY.other;

  const isMock = input.mock === true
    || (process.env.CS_SUGGEST_MOCK || 'true').toLowerCase() !== 'false'
    || !process.env.OPENAI_API_KEY;

  if (isMock) {
    return {
      category,
      response: tpl.body({
        buyer: input.buyer_name_masked || null,
        productTitle: input.product_title || null,
        courier: input.courier || null,
        trackingNumber: input.tracking_number || null,
      }),
      confidence: tpl.confidence,
      model: 'lumi-template-v1',
    };
  }

  // 실연동 (gpt-4o-mini, 한국어, 간결, 정중)
  try {
    const fetch = require('node-fetch');
    const systemPrompt = '당신은 1인 셀러의 친절한 CS 비서입니다. 답변은 한국어 3~5문장 이내, 정중하지만 간결하게, 구매자 이름이 있으면 호칭으로 사용하고, 광고나 사과 과잉을 피하세요.';
    const userPrompt = JSON.stringify({
      buyer: input.buyer_name_masked || null,
      product: input.product_title || null,
      message: input.message,
      category,
      courier: input.courier || null,
      tracking_number: input.tracking_number || null,
    });
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.4,
        max_tokens: 280,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      // GPT 실패 → 룰 기반 fallback
      return {
        category,
        response: tpl.body({
          buyer: input.buyer_name_masked || null,
          productTitle: input.product_title || null,
          courier: input.courier || null,
          trackingNumber: input.tracking_number || null,
        }),
        confidence: tpl.confidence * 0.8,
        model: 'lumi-template-fallback',
      };
    }
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content?.trim() || '';
    return {
      category,
      response: text,
      confidence: 0.85,
      model: 'gpt-4o-mini',
    };
  } catch (e) {
    return {
      category,
      response: tpl.body({
        buyer: input.buyer_name_masked || null,
        productTitle: input.product_title || null,
        courier: input.courier || null,
        trackingNumber: input.tracking_number || null,
      }),
      confidence: tpl.confidence * 0.7,
      model: 'lumi-template-error',
      error: e.message,
    };
  }
}

module.exports = {
  classifyCategory,
  suggestReply,
  TEMPLATE_BY_CATEGORY,
};
