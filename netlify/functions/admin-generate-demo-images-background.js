// netlify/functions/admin-generate-demo-images-background.js
// Admin: 12장 데모 매장 사진을 OpenAI Images API(gpt-image-2)로 생성 →
// GitHub Contents API로 assets/demo/NN.jpg 에 직접 commit.
//
// 2026-05 PR #151: gpt-image-1 → gpt-image-2 (출시 2026-04-21, GPT-5.4 backbone).
// 텍스트 렌더 정확도·속도·multi-turn editing 개선. transparent 배경은 v2 미지원
// (jpeg 출력엔 영향 없음).
//
// 호출: GET /api/admin-generate-demo-images?secret=<LUMI_SECRET>
//   또는 헤더 X-Lumi-Secret: <LUMI_SECRET>
//
// 환경변수 필수:
//   OPENAI_API_KEY  — OpenAI 결제 키
//   GITHUB_TOKEN    — Personal Access Token (scope: repo / Contents:write)
//   LUMI_SECRET     — admin 인증
// 환경변수 옵션:
//   GITHUB_REPO     — 기본 "gung3625/lumi.it"
//   GITHUB_BRANCH   — 기본 "claude/rebuild-all-files-Jhc1i"
//
// background 함수 (timeout 15분). 12장 순차 처리 (각 ~10-30초).

const REPO = process.env.GITHUB_REPO || 'gung3625/lumi.it';
const BRANCH = process.env.GITHUB_BRANCH || 'claude/rebuild-all-files-Jhc1i';

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

exports.handler = async (event) => {
  const headers = event.headers || {};
  const qp = event.queryStringParameters || {};
  const secret =
    headers['x-lumi-secret'] ||
    headers['X-Lumi-Secret'] ||
    qp.secret;

  if (!secret || secret !== process.env.LUMI_SECRET) {
    return { statusCode: 401, body: 'unauthorized' };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const ghToken = process.env.GITHUB_TOKEN;
  if (!apiKey || !ghToken) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'missing env vars',
        missing: { OPENAI_API_KEY: !apiKey, GITHUB_TOKEN: !ghToken },
      }),
    };
  }

  const log = [];

  for (let i = 0; i < PROMPTS.length; i++) {
    const idx = String(i + 1).padStart(2, '0');
    const path = `assets/demo/${idx}.jpg`;

    try {
      // 1) OpenAI Images
      const imgRes = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-image-2',
          prompt: PROMPTS[i],
          size: '1024x1024',              // v2 도 지원 (v2 가 default 는 auto)
          quality: 'medium',               // v2: low/medium/high/auto
          n: 1,
          response_format: 'b64_json',     // v2 default 가 'url' 이라 명시 필요 (b64 추출 호환)
          output_format: 'jpeg',           // 인코딩
          output_compression: 85,          // jpeg 압축 품질 (0~100). v2 신규 옵션.
        }),
      });

      if (!imgRes.ok) {
        const err = await imgRes.text();
        log.push({ idx, stage: 'openai', status: imgRes.status, err: err.slice(0, 300) });
        continue;
      }

      const imgJson = await imgRes.json();
      const b64 = imgJson && imgJson.data && imgJson.data[0] && imgJson.data[0].b64_json;
      if (!b64) {
        log.push({ idx, stage: 'openai', err: 'no b64_json in response' });
        continue;
      }

      // 2) GitHub: 기존 파일 SHA 조회 (있으면 update, 없으면 create)
      let sha;
      const ghGet = await fetch(
        `https://api.github.com/repos/${REPO}/contents/${path}?ref=${encodeURIComponent(BRANCH)}`,
        {
          headers: {
            'Authorization': `Bearer ${ghToken}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'lumi-admin-bot',
          },
        }
      );
      if (ghGet.ok) {
        const existing = await ghGet.json();
        sha = existing && existing.sha;
      }

      // 3) GitHub: PUT (create or update)
      const ghPut = await fetch(
        `https://api.github.com/repos/${REPO}/contents/${path}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${ghToken}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            'User-Agent': 'lumi-admin-bot',
          },
          body: JSON.stringify({
            message: `chore: 데모 이미지 ${idx} 생성/갱신`,
            content: b64,
            branch: BRANCH,
            ...(sha ? { sha } : {}),
          }),
        }
      );
      if (!ghPut.ok) {
        const err = await ghPut.text();
        log.push({ idx, stage: 'github', status: ghPut.status, err: err.slice(0, 300) });
        continue;
      }

      log.push({ idx, stage: 'done', path });
    } catch (e) {
      log.push({ idx, stage: 'exception', err: String(e).slice(0, 300) });
    }
  }

  console.log('[admin-generate-demo-images] log:', JSON.stringify(log));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok: true,
      repo: REPO,
      branch: BRANCH,
      summary: {
        total: PROMPTS.length,
        succeeded: log.filter((l) => l.stage === 'done').length,
      },
      log,
    }),
  };
};
