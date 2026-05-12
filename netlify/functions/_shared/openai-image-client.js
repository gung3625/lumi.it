// OpenAI gpt-image-2 이미지 생성 클라이언트 래퍼.
// 엔드포인트: POST https://api.openai.com/v1/images/generations
// 모델: gpt-image-2 (2026-04-21 출시, GPT-5.4 backbone). v1 대비 텍스트 렌더·속도·multi-turn editing 개선.
// 응답: data[0].b64_json (default) 또는 data[0].url (CDN fallback).
//
// 환경변수: OPENAI_API_KEY (필수). 값은 절대 로그·응답에 노출 금지.
//
// PR #161+ : gpt-image-1 → gpt-image-2 전환. brand_content_library 생성 경로 통일.
// PR #151 에서 admin-generate-demo-images 만 먼저 v2 전환, 본 shared 클라이언트는
// PNG 출력으로 남아있어 production 경로 두 갈래였음. 본 변경으로 production 통일.

const OPENAI_BASE = 'https://api.openai.com/v1';
const IMAGE_MODEL = 'gpt-image-2';
const IMAGE_TIMEOUT_MS = 120_000;   // v2 high quality 가 60s 넘는 경우 있음

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
 * gpt-image-2 이미지 생성 (동기) → Buffer + mimeType
 *
 * v2 응답 처리:
 *   1) data[0].b64_json 우선 (기본 응답)
 *   2) 없으면 data[0].url 로 CDN fetch 후 base64 변환 (PR #156 패턴)
 *
 * @param {{ prompt: string, size?: string, quality?: string }} options
 *   - size: '1024x1024' | '1024x1536' | '1536x1024' (v2 지원)
 *   - quality: 'low' | 'medium' | 'high' | 'auto' (v2 명명. v1 의 standard/hd 와 다름)
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
    // v2 는 response_format 옵션 거부 (v1 옵션) — 제거. b64_json 은 default 응답에 자동 포함.
    output_format: 'jpeg',           // PNG → JPEG (Storage 용량 절감, 인스타용 충분)
    output_compression: 85,
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
    throw new Error(`gpt-image-2 요청 실패: ${e.message || 'network error'}`);
  }
  clearTimeout(tid);

  // 403: 조직 인증 미완료
  if (res.status === 403) {
    throw new Error('gpt-image-2 사용 불가: OpenAI 조직 인증이 필요합니다.');
  }

  if (!res.ok) {
    const snippet = await readErrorSnippet(res);
    throw new Error(`gpt-image-2 HTTP ${res.status}: ${snippet}`);
  }

  let data;
  try { data = await res.json(); }
  catch (e) { throw new Error(`gpt-image-2 응답 JSON 파싱 실패: ${e.message}`); }

  const first = Array.isArray(data?.data) ? data.data[0] : null;
  if (!first) {
    throw new Error('gpt-image-2 응답에 data[0] 없음');
  }

  // 1순위: b64_json
  if (first.b64_json) {
    console.log('[openai-image-client] 이미지 생성 완료 (b64_json).');
    return {
      buffer: Buffer.from(first.b64_json, 'base64'),
      mimeType: 'image/jpeg',
    };
  }

  // 2순위: url → fetch 후 base64
  if (first.url) {
    let cdnRes;
    try {
      cdnRes = await fetch(first.url);
    } catch (e) {
      throw new Error(`gpt-image-2 CDN fetch 실패: ${e.message}`);
    }
    if (!cdnRes.ok) {
      throw new Error(`gpt-image-2 CDN HTTP ${cdnRes.status}`);
    }
    const buffer = Buffer.from(await cdnRes.arrayBuffer());
    console.log('[openai-image-client] 이미지 생성 완료 (url fallback).');
    return {
      buffer,
      mimeType: 'image/jpeg',
    };
  }

  throw new Error('gpt-image-2 응답에 b64_json / url 둘 다 없음');
}

module.exports = { generateImage };
