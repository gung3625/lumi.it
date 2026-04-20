// OpenAI gpt-image-1 이미지 생성 클라이언트 래퍼.
// 엔드포인트: POST https://api.openai.com/v1/images/generations
// 모델: gpt-image-1 (Organization verification required)
// 응답: data[0].b64_json → Buffer
//
// 환경변수: OPENAI_API_KEY (필수). 값은 절대 로그·응답에 노출 금지.

const OPENAI_BASE = 'https://api.openai.com/v1';
const IMAGE_MODEL = 'gpt-image-1';
const IMAGE_TIMEOUT_MS = 60_000;

function requireApiKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY 환경변수가 설정되지 않았습니다.');
  return key;
}

async function readErrorSnippet(res) {
  try {
    const t = await res.text();
    return (t || '').slice(0, 300);
  } catch (_) {
    return '';
  }
}

/**
 * gpt-image-1 이미지 생성 (동기) → Buffer + mimeType
 * @param {{ prompt: string, size?: string, quality?: string }} options
 * @returns {Promise<{ buffer: Buffer, mimeType: string }>}
 */
async function generateImage({ prompt, size = '1024x1536', quality = 'medium' } = {}) {
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('generateImage: prompt 필수');
  }
  const apiKey = requireApiKey();

  const body = {
    model: IMAGE_MODEL,
    prompt,
    size,
    quality,
    n: 1,
  };

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), IMAGE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${OPENAI_BASE}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(tid);
    throw new Error(`gpt-image-1 요청 실패: ${e.message || 'network error'}`);
  }
  clearTimeout(tid);

  // 403: 조직 인증 미완료 (내일 인증 예정)
  if (res.status === 403) {
    throw new Error('gpt-image-1 사용 불가: OpenAI 조직 인증이 필요합니다. 조직 인증 완료 후 재시도하세요.');
  }

  if (!res.ok) {
    const snippet = await readErrorSnippet(res);
    throw new Error(`gpt-image-1 HTTP ${res.status}: ${snippet}`);
  }

  let data;
  try { data = await res.json(); }
  catch (e) { throw new Error(`gpt-image-1 응답 JSON 파싱 실패: ${e.message}`); }

  const first = Array.isArray(data?.data) ? data.data[0] : null;
  if (!first || !first.b64_json) {
    throw new Error('gpt-image-1 응답에 b64_json 데이터가 없습니다.');
  }

  console.log('[openai-image-client] 이미지 생성 완료.');
  return {
    buffer: Buffer.from(first.b64_json, 'base64'),
    mimeType: 'image/png',
  };
}

module.exports = { generateImage };
