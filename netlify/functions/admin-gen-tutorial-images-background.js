// admin-gen-tutorial-images-background
// 튜토리얼 9장 cafe demo 사진을 gpt-image-2 로 생성 + supabase storage 'tutorial-demo' bucket 업로드.
// 일회성. 사장님 한 번 trigger 후 9장 다 처리되면 끝.
//
// 인증: admin-guard (Supabase JWT + sellers.is_admin)
// 스토리지: tutorial-demo bucket (public, migration 20260517010000)
// 결과: 진행 상태를 trends 테이블의 'tutorial-images-job' row 에 저장
//
// 트리거 예 (dashboard console):
//   await fetch('/api/admin-gen-tutorial-images-background', {
//     method: 'POST',
//     headers: { Authorization: 'Bearer ' + localStorage.getItem('lumi-auth') },
//   });
//
// 폴링: GET /api/cron-health 의 'tutorial-images-job' row 또는 직접 storage 확인.

const { generateImage } = require('./_shared/openai-image-client');
const { getAdminClient } = require('./_shared/supabase-admin');
const { requireAdmin } = require('./_shared/admin-guard');

const BUCKET = 'tutorial-demo';
const JOB_KEY = 'tutorial-images-job';

const BASE_STYLE =
  'shot on iPhone, instagram aesthetic, small Korean cafe owner perspective, ' +
  'soft natural depth, no text or logos, no people, photorealistic, warm cozy mood';

const PROMPTS = {
  'cafe-1': 'top-down latte art rosetta on a beige ceramic cup, dark walnut wood table, morning soft window light from the left, beige and brown palette, minimal, slight steam, single saucer. ' + BASE_STYLE,
  'cafe-2': 'single slice of cream cheese cake on a small white plate, soft warm indoor cafe lighting in late afternoon, cream and light brown tones, fork and tea cup blurred behind, cozy and slow afternoon mood. ' + BASE_STYLE,
  'cafe-3': 'five pastel macarons (pink, lilac, mint, peach, cream) on a small marble tray, natural daylight from a side window, soft pink and pastel palette, bright and cheerful, very shallow background. ' + BASE_STYLE,
  'cafe-4': 'crispy golden croffle topped with maple syrup and a tiny scoop of vanilla ice cream, wooden board, morning sunlight, deep golden brown palette, syrup glaze catching the light, appetizing close-up. ' + BASE_STYLE,
  'cafe-5': 'tomato cream pasta in a wide pasta plate, parmesan flakes on top, warm indoor lunch lighting, red and yellow tones, fork twirling pasta hinted at, hearty and rich mood, slight steam. ' + BASE_STYLE,
  'cafe-6': 'fresh green salad bowl with cherry tomatoes, corn, and citrus dressing, natural daylight, light green and yellow palette, clean white wooden table, healthy lunch vibe, crisp and bright. ' + BASE_STYLE,
  'cafe-7': 'freshly baked rustic sourdough loaf on a linen cloth, side morning light, brown crust with golden highlights, scattered flour, small bakery counter background slightly blurred, artisanal and warm. ' + BASE_STYLE,
  'cafe-8': 'two berry smoothies in clear glasses with paper straws, bright afternoon sunlight, purple and pink gradient drinks, fresh berries scattered around, energetic and refreshing summer mood. ' + BASE_STYLE,
  'cafe-9': 'beautifully plated dessert: vanilla panna cotta with edible flowers and raspberry coulis on a white round plate, soft warm indoor afternoon light, pastel and white palette, careful artisan plating, minimal background. ' + BASE_STYLE,
};

async function saveJobStatus(supa, payload) {
  try {
    await supa.from('trends').upsert(
      {
        category: JOB_KEY,
        keywords: { ...payload, updatedAt: new Date().toISOString() },
        collected_at: new Date().toISOString(),
      },
      { onConflict: 'category' },
    );
  } catch (e) {
    console.error('[admin-gen-tutorial-images] job status save 실패:', e && e.message);
  }
}

exports.handler = async (event) => {
  // Background function: 즉시 202 + 비동기 처리.
  // 단 admin guard 는 동기 — 인증 실패 시 401 즉시.
  const admin = getAdminClient();
  const auth = await requireAdmin(event, admin);
  if (!auth.ok) {
    return { statusCode: auth.status, body: JSON.stringify({ error: auth.error }) };
  }

  const keys = Object.keys(PROMPTS);
  await saveJobStatus(admin, { status: 'started', total: keys.length, completed: 0, results: [] });

  const results = [];
  let completed = 0;

  for (const key of keys) {
    const prompt = PROMPTS[key];
    try {
      console.log('[admin-gen-tutorial-images] start', key);
      const { buffer, mimeType } = await generateImage({
        prompt,
        size: '1024x1024',
        quality: 'medium',
      });
      const path = `${key}.jpg`;
      const { error: upErr } = await admin.storage
        .from(BUCKET)
        .upload(path, buffer, {
          contentType: mimeType || 'image/jpeg',
          upsert: true,
        });
      if (upErr) throw upErr;
      const { data: pub } = admin.storage.from(BUCKET).getPublicUrl(path);
      const url = pub && pub.publicUrl;
      results.push({ key, ok: true, url });
      console.log('[admin-gen-tutorial-images] uploaded', key, url);
    } catch (e) {
      console.error('[admin-gen-tutorial-images]', key, '실패:', e && e.message);
      results.push({ key, ok: false, error: String(e && e.message || e) });
    }
    completed++;
    await saveJobStatus(admin, {
      status: completed === keys.length ? 'done' : 'in_progress',
      total: keys.length,
      completed,
      results,
    });
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, results }),
  };
};
