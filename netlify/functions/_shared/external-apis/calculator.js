// calculator.js — 마진·VAT·수수료 자체 계산 (Tier 0, ₩0)
// 메모리 project_agent_architecture_0428.md
//
// 셀러 자주 묻는 계산:
//   "10000원 상품 마진 30% 면 얼마?"
//   "VAT 포함하면?"
//   "쿠팡 수수료 10.8% 빼면?"

/**
 * 단순 산식 계산 (안전: eval 금지)
 * 허용: 숫자·연산자(+ - * /)·괄호·% (퍼센트)
 */
function safeMath(expr) {
  const cleaned = String(expr || '').replace(/[원₩,\s]/g, '');
  // %는 /100으로 변환
  const withPct = cleaned.replace(/(\d+(?:\.\d+)?)%/g, '($1/100)');
  // 안전성 검사
  if (!/^[\d+\-*/().\s]+$/.test(withPct)) return null;
  try {
    // Function constructor (eval보다 안전 — global scope 차단)
    // eslint-disable-next-line no-new-func
    const result = Function('"use strict"; return (' + withPct + ')')();
    if (typeof result !== 'number' || !isFinite(result)) return null;
    return result;
  } catch (_) {
    return null;
  }
}

/**
 * 마진 계산
 * @param {number} sellPrice
 * @param {number} costPrice
 * @returns {{ margin: number, marginPct: number }}
 */
function calcMargin(sellPrice, costPrice) {
  const margin = (sellPrice || 0) - (costPrice || 0);
  const marginPct = sellPrice > 0 ? (margin / sellPrice) * 100 : 0;
  return { margin, marginPct: Number(marginPct.toFixed(1)) };
}

/**
 * VAT 포함/제외
 */
function calcVat(amount, included = false) {
  const a = Number(amount) || 0;
  if (included) {
    // 포함된 금액에서 공급가/세액 분리
    const supply = Math.round(a / 1.1);
    const vat = a - supply;
    return { supply, vat, total: a };
  }
  const vat = Math.round(a * 0.1);
  return { supply: a, vat, total: a + vat };
}

/**
 * 마켓 수수료 차감
 */
function calcAfterFee(grossPrice, feePercent) {
  const fee = Math.round(grossPrice * (feePercent / 100));
  const net = grossPrice - fee;
  return { gross: grossPrice, fee, net, feePercent };
}

/**
 * 자연어 명령 → 계산 결과 분기
 * 예시:
 *   "10000원에서 30% 빼면" → safeMath
 *   "마진 50000-30000" → calcMargin
 *   "VAT 110000 포함" → calcVat included
 */
function interpret(input) {
  const text = String(input || '').trim();

  // VAT 명시
  if (/vat|부가세/i.test(text)) {
    const nums = (text.match(/\d+/g) || []).map(Number);
    if (nums.length >= 1) {
      const included = /포함|inc/i.test(text);
      const r = calcVat(nums[0], included);
      return {
        ok: true,
        kind: 'vat',
        result: r,
        summary: included
          ? `${nums[0].toLocaleString('ko-KR')}원 (VAT 포함) = 공급가 ${r.supply.toLocaleString('ko-KR')}원 + VAT ${r.vat.toLocaleString('ko-KR')}원`
          : `${nums[0].toLocaleString('ko-KR')}원 (VAT 별도) = 합계 ${r.total.toLocaleString('ko-KR')}원 (VAT ${r.vat.toLocaleString('ko-KR')}원)`,
      };
    }
  }

  // 마진
  if (/마진|이익/.test(text)) {
    const nums = (text.match(/\d+/g) || []).map(Number);
    if (nums.length >= 2) {
      const r = calcMargin(nums[0], nums[1]);
      return {
        ok: true,
        kind: 'margin',
        result: r,
        summary: `판매가 ${nums[0].toLocaleString('ko-KR')}원 - 원가 ${nums[1].toLocaleString('ko-KR')}원 = 마진 ${r.margin.toLocaleString('ko-KR')}원 (${r.marginPct}%)`,
      };
    }
  }

  // 수수료
  if (/수수료/.test(text)) {
    const nums = (text.match(/\d+(?:\.\d+)?/g) || []).map(Number);
    if (nums.length >= 2) {
      const gross = nums[0];
      const pct = nums[1];
      const r = calcAfterFee(gross, pct);
      return {
        ok: true,
        kind: 'fee',
        result: r,
        summary: `${gross.toLocaleString('ko-KR')}원 - 수수료 ${pct}% = 정산 ${r.net.toLocaleString('ko-KR')}원 (수수료 ${r.fee.toLocaleString('ko-KR')}원)`,
      };
    }
  }

  // 단순 산식
  const result = safeMath(text);
  if (result !== null) {
    return {
      ok: true,
      kind: 'math',
      result,
      summary: `${text} = ${Math.round(result).toLocaleString('ko-KR')}`,
    };
  }

  return {
    ok: false,
    summary: '계산할 수 있는 형식이 아니에요. 예: "마진 50000 30000", "VAT 110000 포함", "100*1.1"',
  };
}

module.exports = { safeMath, calcMargin, calcVat, calcAfterFee, interpret };
