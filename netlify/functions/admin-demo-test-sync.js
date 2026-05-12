// admin-demo-test-sync.js — 진단용. background 함수 안에서 무엇이 실패하는지 응답 본문에 직접 노출.
// admin-generate-demo-images-background 의 1장 처리 로직과 동일하지만:
//   - background 접미사 X → 응답 본문에 결과 반환 가능 (Netlify Function timeout 10초 안)
//   - count 디폴트 1 (이 함수는 timeout 짧아 1~2장만 권장)
//   - GitHub commit 옵션 — ?commit=0 이면 OpenAI 호출까지만, commit skip (안전한 호환성 확인용)
//
// GET /api/admin-demo-test-sync?secret=LUMI_SECRET&commit=0&index=0
//
// 응답: { ok, log: [{stage, status, ...}], image: { generated, bytes }, github: {...} | null }

const PROMPTS = [
  'Top-down photo of Korean bibimbap with vibrant vegetables on a warm wooden table, natural daylight, photorealistic shot on iPhone',
  'Interior of a cozy Korean BBQ restaurant, dim warm lighting, wooden tables, atmospheric photorealistic mobile photo',
  'Interior of a modern Korean hair salon, large mirror, warm lighting, minimalist style, photorealistic mobile photo',
  'Close-up of a freshly cut bob haircut from behind in a salon, soft lighting, photorealistic mobile photo',
  'Top-down photo of latte art on a rustic ceramic cup on a wooden cafe table, morning light, photorealistic mobile shot',
  'Beautifully plated Korean strawberry tart on a marble cafe counter, soft natural light, photorealistic',
  'A clothing store display rack with autumn outfits in a warm Korean boutique, photorealistic mobile photo',
  'Mannequin styled in Korean street fashion in beige tones in a boutique window, photorealistic',
  'Cozy Korean cafe storefront at night with warm window glow on a small alley, photorealistic mobile photo',
  'Korean street food stall at evening in Seoul with tteokbokki steam rising, photorealistic candid mobile photo',
  'Hand holding iced americano in front of cafe interior with bokeh background, natural light, photorealistic',
  'Top-down photo of Korean kimchi stew with side dishes spread on a wooden table, natural daylight, photorealistic',
];

const REPO = process.env.GITHUB_REPO || 'gung3625/lumi.it';
const BRANCH = process.env.GITHUB_BRANCH || 'main';

exports.handler = async (event) => {
  const headers = event.headers || {};
  const qp = event.queryStringParameters || {};
  const secret =
    headers['x-lumi-secret'] ||
    headers['X-Lumi-Secret'] ||
    qp.secret;

  if (!secret || secret !== process.env.LUMI_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'unauthorized' }) };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const ghToken = process.env.GITHUB_TOKEN;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'OPENAI_API_KEY missing' }) };
  }

  const doCommit = qp.commit !== '0';
  let index = parseInt(qp.index || '0', 10);
  if (!Number.isFinite(index) || index < 0 || index >= PROMPTS.length) index = 0;

  const log = [];
  const idx = String(index + 1).padStart(2, '0');
  const path = `assets/demo/${idx}.jpg`;

  // 1) OpenAI Images
  let b64 = null;
  let imageMeta = null;
  try {
    const imgRes = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-image-2',
        prompt: PROMPTS[index],
        size: '1024x1024',
        quality: 'medium',
        n: 1,
        response_format: 'b64_json',
        output_format: 'jpeg',
        output_compression: 85,
      }),
    });

    const text = await imgRes.text();
    log.push({ stage: 'openai', status: imgRes.status, ok: imgRes.ok });

    if (!imgRes.ok) {
      log.push({ stage: 'openai_error_body', body: text.slice(0, 800) });
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, log }) };
    }

    let imgJson;
    try { imgJson = JSON.parse(text); }
    catch (e) {
      log.push({ stage: 'openai_parse', err: e.message, body: text.slice(0, 400) });
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, log }) };
    }

    b64 = imgJson && imgJson.data && imgJson.data[0] && imgJson.data[0].b64_json;
    if (!b64) {
      log.push({ stage: 'openai_no_b64', keys: imgJson?.data?.[0] ? Object.keys(imgJson.data[0]) : null });
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, log, response_keys: imgJson ? Object.keys(imgJson) : null }) };
    }
    imageMeta = { bytes: b64.length, response_keys: Object.keys(imgJson) };
    log.push({ stage: 'openai_ok', b64_chars: b64.length });
  } catch (e) {
    log.push({ stage: 'openai_throw', err: e.message });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, log }) };
  }

  // 2) GitHub commit (옵션)
  let githubResult = null;
  if (doCommit) {
    if (!ghToken) {
      log.push({ stage: 'github_skip', reason: 'GITHUB_TOKEN missing' });
    } else {
      try {
        // 기존 파일 SHA 조회 (있으면 update)
        let sha;
        const ghGet = await fetch(
          `https://api.github.com/repos/${REPO}/contents/${path}?ref=${encodeURIComponent(BRANCH)}`,
          { headers: { 'Authorization': `Bearer ${ghToken}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'lumi-admin-bot' } }
        );
        if (ghGet.ok) {
          const existing = await ghGet.json();
          sha = existing && existing.sha;
        }
        log.push({ stage: 'github_get', status: ghGet.status, sha: sha ? sha.slice(0, 8) : null });

        // PUT (create or update)
        const putBody = {
          message: `[admin-demo-test] regen ${idx} via gpt-image-2`,
          content: b64,
          branch: BRANCH,
        };
        if (sha) putBody.sha = sha;

        const ghPut = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${ghToken}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'lumi-admin-bot', 'Content-Type': 'application/json' },
          body: JSON.stringify(putBody),
        });
        const putText = await ghPut.text();
        log.push({ stage: 'github_put', status: ghPut.status, ok: ghPut.ok });
        if (!ghPut.ok) {
          log.push({ stage: 'github_put_error_body', body: putText.slice(0, 500) });
        } else {
          githubResult = { committed: true, path };
        }
      } catch (e) {
        log.push({ stage: 'github_throw', err: e.message });
      }
    }
  } else {
    log.push({ stage: 'github_skipped_by_param' });
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok: !!b64,
      log,
      image: imageMeta,
      github: githubResult,
    }),
  };
};
