// _shared/llm-call.js — OpenAI chat/completions 호출 + 실패 시 Gemini 무료 폴백.
//
// 배경 (2026-06-12): OpenAI 프로덕션 키가 429 billing_not_active 상태가 되면
// 캡션 생성·비전 분석·검수·벤치마크 리포트 등 LLM 의존 기능 전부가 조용히
// 죽는다. 결제가 살아나면 OpenAI(기존 품질)로 자동 복귀하고, 죽어 있는 동안은
// Gemini 무료 티어(gemini-2.5-flash, 텍스트+비전)로 동작하도록 폴백을 공용화.
//
// 사용 — 기존 OpenAI 호출부의 fetch 한 줄만 교체:
//   const res = await llmChat(payload, { timeoutMs: 90_000, label: 'caption-gen' });
//   res.ok / await res.json() → { choices:[{message:{content}}] } 모양 유지
//   (호출부의 기존 파싱·에러 처리 코드 무수정)
//
// 정책:
//   - OPENAI_API_KEY 있으면 OpenAI 먼저 (fetchWithRetry: 5xx 재시도, 4xx 즉시 반환)
//   - 실패(4xx/5xx/네트워크/빈 응답) → 동일 프롬프트를 Gemini 로
//   - 둘 다 실패 → throw (호출부의 기존 실패 경로 그대로)
//   - Gemini 변환: messages→contents, data URL 이미지→inlineData,
//     response_format(json_object/json_schema)→responseMimeType+스키마 지시문,
//     max_tokens/max_completion_tokens→maxOutputTokens (thinking 비활성 —
//     thinking 토큰이 출력 한도를 잠식해 빈 응답 나는 것 방지)

'use strict';

const { fetchWithRetry } = require('./fetch-with-retry');

const GEMINI_MODEL = 'gemini-2.5-flash';

function wrapAsResponse(data, provider) {
  return {
    ok: true,
    status: 200,
    provider,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

// OpenAI chat payload → Gemini generateContent 요청
function toGeminiRequest(payload) {
  const contents = [];
  let systemText = '';
  for (const m of payload.messages || []) {
    if (m.role === 'system') {
      systemText += (systemText ? '\n\n' : '') + (typeof m.content === 'string' ? m.content : '');
      continue;
    }
    const parts = [];
    if (typeof m.content === 'string') {
      parts.push({ text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === 'text') parts.push({ text: c.text });
        else if (c.type === 'image_url' && c.image_url && c.image_url.url) {
          const u = c.image_url.url;
          const dm = /^data:([^;]+);base64,(.+)$/s.exec(u);
          if (dm) parts.push({ inlineData: { mimeType: dm[1], data: dm[2] } });
          else parts.push({ remoteUrl: u }); // resolveRemoteImages 가 fetch→base64
        }
      }
    }
    if (parts.length) contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }

  const gen = { thinkingConfig: { thinkingBudget: 0 } };
  const maxTok = payload.max_tokens || payload.max_completion_tokens;
  if (maxTok) gen.maxOutputTokens = Math.max(maxTok, 1024);
  if (typeof payload.temperature === 'number') gen.temperature = payload.temperature;

  const rf = payload.response_format;
  if (rf && (rf.type === 'json_object' || rf.type === 'json_schema')) {
    gen.responseMimeType = 'application/json';
    if (rf.type === 'json_schema' && rf.json_schema && rf.json_schema.schema) {
      // Gemini responseSchema 는 OpenAI JSON Schema 키워드와 호환이 불완전 —
      // 스키마를 지시문으로 주입하고 검증은 호출부의 기존 파싱이 담당.
      const schemaText = '\n\n[출력 형식] 반드시 아래 JSON Schema 를 따르는 JSON 만 출력:\n'
        + JSON.stringify(rf.json_schema.schema);
      const lastUser = [...contents].reverse().find((c) => c.role === 'user');
      if (lastUser) lastUser.parts.push({ text: schemaText });
    }
  }

  const req = { contents, generationConfig: gen };
  if (systemText) req.systemInstruction = { parts: [{ text: systemText }] };
  return req;
}

// https 이미지 URL → inlineData (현재 파이프라인은 전부 data URL 이라 보통 no-op)
async function resolveRemoteImages(req, timeoutMs) {
  for (const c of req.contents) {
    for (let i = 0; i < c.parts.length; i++) {
      const p = c.parts[i];
      if (!p.remoteUrl) continue;
      const r = await fetchWithRetry(p.remoteUrl, {}, {
        timeoutMs: Math.min(timeoutMs, 30_000), label: 'gemini-img-fetch', maxRetries: 1,
      });
      if (!r.ok) throw new Error(`이미지 fetch 실패 HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
      c.parts[i] = { inlineData: { mimeType: mime, data: buf.toString('base64') } };
    }
  }
}

// 고객·민감 데이터(sensitive)는 무료 Gemini 금지 — 무료 티어는 입력을 Google 학습·검토에
// 사용함(2026-06 확인). 유료 키(GEMINI_PAID_API_KEY)는 학습 미사용이라 어디든 OK.
// llm-call 경유 = 기본 sensitive(고객 사진/캡션). 공개 게시물 분석만 호출부에서 sensitive:false.
function pickGeminiKey(sensitive) {
  const paid = process.env.GEMINI_PAID_API_KEY;
  if (paid) return paid;
  if (sensitive) return null;                  // 민감 데이터인데 유료 키 없음 → 호출 차단
  return process.env.GEMINI_API_KEY || null;   // 비민감(공개·일반어)만 무료 허용
}

// 저수준 Gemini generateContent — llmChat 내부용 + 특수 입력(오디오 전사 등) 직접 호출용
async function geminiGenerate(req, opts = {}) {
  const sensitive = opts.sensitive !== false;  // 기본 true (고객 데이터 보호)
  const key = pickGeminiKey(sensitive);
  if (!key) throw new Error(sensitive ? 'sensitive_data_requires_paid_key' : 'GEMINI_API_KEY missing');
  const timeoutMs = opts.timeoutMs || 60_000;
  const label = opts.label || 'gemini';
  const res = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) },
    { timeoutMs, label }
  );
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gemini HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  const text = ((cand && cand.content && cand.content.parts) || []).map((p) => p.text || '').join('');
  if (!text.trim()) throw new Error(`Gemini 빈 응답 (finishReason: ${(cand && cand.finishReason) || '?'})`);
  return text;
}

async function llmChat(payload, opts = {}) {
  const timeoutMs = opts.timeoutMs || 60_000;
  const label = opts.label || 'llm';

  if (process.env.OPENAI_API_KEY && opts.provider !== 'gemini') {
    try {
      const res = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify(payload),
      }, { timeoutMs, label: `${label}:openai` });
      const data = await res.json().catch(() => null);
      if (res.ok && data && !data.error && data.choices && data.choices[0] && data.choices[0].message
        && data.choices[0].message.content) {
        return wrapAsResponse(data, 'openai');
      }
      const why = (data && data.error && (data.error.code || data.error.message)) || `HTTP ${res.status}`;
      console.warn(`[llm:${label}] OpenAI 실패(${String(why).slice(0, 120)}) → Gemini 폴백`);
    } catch (e) {
      console.warn(`[llm:${label}] OpenAI 예외 → Gemini 폴백: ${e.message}`);
    }
  } else {
    console.warn(`[llm:${label}] ${opts.provider === 'gemini' ? 'provider=gemini 지정' : 'OPENAI_API_KEY 없음'} → Gemini`);
  }

  const req = toGeminiRequest(payload);
  await resolveRemoteImages(req, timeoutMs);
  const text = await geminiGenerate(req, { timeoutMs, label: `${label}:gemini`, sensitive: opts.sensitive });
  return wrapAsResponse({ provider: 'gemini', choices: [{ message: { role: 'assistant', content: text } }] }, 'gemini');
}

module.exports = { llmChat, geminiGenerate };
