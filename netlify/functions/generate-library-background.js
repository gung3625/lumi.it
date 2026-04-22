// Background Function — 브랜드 라이브러리 콘텐츠 생성.
// 매개변수: { industry?, content_type?, slot_index? }
//   - 전체 생성 모드: 파라미터 없음 → 7업종 × 이미지2 + 영상2 = 28개 순차 생성
//   - 특정 슬롯: { industry, content_type, slot_index } → 1개만 (재)생성
// admin-only: Authorization Bearer JWT + users.is_admin 필수.
//
// 환경변수: OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { generateImage } = require('./_shared/openai-image-client');
const { generateVideo } = require('./_shared/sora-video-client');
const { getImagePrompt, getVideoPrompt } = require('./_shared/brand-prompts');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const INDUSTRIES = ['cafe', 'restaurant', 'beauty', 'nail', 'flower', 'clothing', 'gym'];
const SLOTS_PER_TYPE = 2;  // 업종당 이미지 2 + 영상 2

// admin JWT 검증 + is_admin 확인 → { userId } | throw
// LUMI_SECRET Bearer도 허용 (내부 오케스트레이션 경로)
async function requireAdmin(event) {
  const token = extractBearerToken(event);
  // 내부 오케스트레이션: Bearer === LUMI_SECRET
  if (token && process.env.LUMI_SECRET && token === process.env.LUMI_SECRET) {
    return { userId: 'LUMI_INTERNAL' };
  }
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) throw Object.assign(new Error('인증이 필요합니다.'), { statusCode: 401 });

  const admin = getAdminClient();
  const { data, error: dbErr } = await admin.from('users').select('is_admin').eq('id', user.id).single();
  if (dbErr || !data) throw Object.assign(new Error('사용자 조회 실패'), { statusCode: 500 });
  if (!data.is_admin) throw Object.assign(new Error('관리자 권한이 없습니다.'), { statusCode: 401 });

  return { userId: user.id };
}

// Supabase Storage 업로드 → public URL
async function uploadToStorage(supabase, { bucket, path, buffer, contentType }) {
  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, buffer, { contentType, upsert: true });
  if (error) throw new Error(`Storage 업로드 실패 (${bucket}/${path}): ${error.message}`);
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  if (!data?.publicUrl) throw new Error(`Storage publicUrl 조회 실패 (${bucket}/${path})`);
  return data.publicUrl;
}

// 단일 슬롯 생성
async function generateSlot(supabase, { industry, contentType, slotIndex }) {
  const isImage = contentType === 'image';
  const bucket = isImage ? 'lumi-images' : 'lumi-videos';
  const ext = isImage ? 'png' : 'mp4';
  // 고정 경로 — 재생성 시 upsert로 덮어쓰기 (dateStamp 누적 방지)
  const storagePath = `brand-library/${industry}/${contentType}-slot-${slotIndex}.${ext}`;

  console.log(`[generate-library] 시작: ${industry}/${contentType}[${slotIndex}]`);

  // 기존 row 조회
  const { data: existing } = await supabase
    .from('brand_content_library')
    .select('id')
    .eq('industry', industry)
    .eq('content_type', contentType)
    .order('generated_at', { ascending: true })
    .range(slotIndex, slotIndex)
    .maybeSingle();

  // status = generating 으로 upsert
  const upsertData = {
    industry,
    content_type: contentType,
    storage_bucket: bucket,
    storage_path: storagePath,
    status: 'generating',
    error_message: null,
    generated_at: new Date().toISOString(),
  };

  let rowId;
  if (existing?.id) {
    const { error: updErr } = await supabase
      .from('brand_content_library')
      .update({ status: 'generating', error_message: null })
      .eq('id', existing.id);
    if (updErr) console.warn('[generate-library] status 업데이트 실패:', updErr.message);
    rowId = existing.id;
  } else {
    const { data: inserted, error: insErr } = await supabase
      .from('brand_content_library')
      .insert(upsertData)
      .select('id')
      .single();
    if (insErr) throw new Error(`DB insert 실패: ${insErr.message}`);
    rowId = inserted.id;
  }

  try {
    // 프롬프트 생성
    const prompt = isImage
      ? await getImagePrompt(industry, slotIndex)
      : await getVideoPrompt(industry, slotIndex);

    // OpenAI 호출
    const { buffer, mimeType } = isImage
      ? await generateImage({ prompt })
      : await generateVideo({ prompt });

    // Storage 업로드
    const publicUrl = await uploadToStorage(supabase, {
      bucket,
      path: storagePath,
      buffer,
      contentType: mimeType,
    });

    // row 완료 업데이트
    await supabase
      .from('brand_content_library')
      .update({
        status: 'ready',
        public_url: publicUrl,
        storage_path: storagePath,
        storage_bucket: bucket,
        prompt,
        generated_at: new Date().toISOString(),
        error_message: null,
      })
      .eq('id', rowId);

    console.log(`[generate-library] 완료: ${industry}/${contentType}[${slotIndex}] → ${publicUrl}`);
    return { success: true, industry, contentType, slotIndex, publicUrl };
  } catch (err) {
    // 실패 기록
    const msg = err.message || '알 수 없는 오류';
    console.error(`[generate-library] 실패: ${industry}/${contentType}[${slotIndex}]:`, msg);
    await supabase
      .from('brand_content_library')
      .update({ status: 'failed', error_message: msg })
      .eq('id', rowId);
    return { success: false, industry, contentType, slotIndex, error: msg };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    await requireAdmin(event);
  } catch (err) {
    return {
      statusCode: err.statusCode || 401,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {}

  const { industry, content_type: contentType, slot_index: slotIndex } = body;
  const supabase = getAdminClient();

  try {
    // 특정 슬롯 재생성 모드
    if (industry && contentType && typeof slotIndex === 'number') {
      if (!['cafe','restaurant','beauty','nail','flower','clothing','gym'].includes(industry)) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '유효하지 않은 업종입니다.' }) };
      }
      if (!['image','video'].includes(contentType)) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '유효하지 않은 content_type입니다.' }) };
      }
      const result = await generateSlot(supabase, { industry, contentType, slotIndex });
      return {
        statusCode: result.success ? 200 : 500,
        headers: CORS,
        body: JSON.stringify(result),
      };
    }

    // 전체 생성 모드는 admin-library-regenerate.js 오케스트레이터에서 처리
    // 이 함수는 단일 슬롯 모드만 지원
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: 'industry, content_type, slot_index 파라미터가 모두 필요합니다. 전체 생성은 /api/admin-library-regenerate?mode=all 을 사용하세요.' }),
    };
  } catch (err) {
    console.error('[generate-library] 예기치 않은 오류:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류가 발생했습니다.' }) };
  }
};
