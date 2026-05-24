// admin-hook-videos.js — lumi 어그로 hook 영상 풀 관리 (admin-only).
//
// GET    /api/admin-hook-videos                → list (모든 영상, active/inactive 다)
// POST   /api/admin-hook-videos                → 새 영상 row insert (Storage 업로드 후 호출)
// PATCH  /api/admin-hook-videos?id=...         → active 토글 또는 notes 수정
// DELETE /api/admin-hook-videos?id=...         → row + Storage 파일 삭제
//
// 인증: Bearer 토큰 + sellers.is_admin=true (admin-guard 모듈)
// Storage 업로드는 클라이언트에서 직접 (supabase-js 로 lumi-hook-videos 버킷에 PUT)
//   → 클라이언트가 storage_path, public_url, file_size 알고 있어야 POST 호출 가능

'use strict';

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { getAdminClient } = require('./_shared/supabase-admin');
const { requireAdmin } = require('./_shared/admin-guard');

const STORAGE_BUCKET = 'lumi-hook-videos';

const VALID_CATEGORIES = new Set([
  'cafe', 'food', 'beauty', 'hair', 'nail', 'flower', 'fashion', 'fitness', 'general',
]);

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const admin = getAdminClient();
  const auth = await requireAdmin(event, admin);
  if (!auth.ok) {
    return { statusCode: auth.status, headers, body: JSON.stringify({ error: auth.error }) };
  }
  const adminSellerId = auth.sellerId;

  try {
    switch (event.httpMethod) {
      case 'GET':    return await handleList(admin, headers);
      case 'POST':   return await handleInsert(admin, event, headers, adminSellerId);
      case 'PATCH':  return await handlePatch(admin, event, headers);
      case 'DELETE': return await handleDelete(admin, event, headers);
      default:
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }
  } catch (e) {
    console.error('[admin-hook-videos] 예외:', e && e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'server_error', detail: e.message }) };
  }
};

// ─────────── GET (list) ───────────
async function handleList(admin, headers) {
  const { data, error } = await admin
    .from('hook_videos')
    .select('id, category, title, prompt, source_model, video_url, duration_sec, width, height, file_size, thumb_url, active, usage_count, last_used_at, notes, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[admin-hook-videos] list 실패:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }

  // 카테고리별 active 개수 요약 (사장님이 어느 카테고리 풀이 약한지 한눈에)
  const summary = {};
  for (const row of data || []) {
    if (!summary[row.category]) summary[row.category] = { total: 0, active: 0 };
    summary[row.category].total++;
    if (row.active) summary[row.category].active++;
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, videos: data || [], summary }),
  };
}

// ─────────── POST (router) ───────────
// 2가지 action 지원:
//   { action: 'request_upload_url', filename, contentType, category } → signed URL 발급
//   { action: 'insert', ...metadata }                                  → row insert (default)
async function handleInsert(admin, event, headers, adminSellerId) {
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid_json' }) };
  }

  if (body.action === 'request_upload_url') {
    return await handleRequestUploadUrl(admin, body, headers);
  }
  // default = insert
  return await handleInsertRow(admin, body, headers, adminSellerId);
}

// signed upload URL 발급 (클라이언트가 직접 PUT 으로 Storage 업로드 가능)
async function handleRequestUploadUrl(admin, body, headers) {
  const category = String(body.category || 'general').toLowerCase().trim();
  if (!VALID_CATEGORIES.has(category)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'category 형식 오류' }) };
  }
  const filename = String(body.filename || '').trim();
  if (!filename || filename.length > 200) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'filename 누락 또는 너무 김' }) };
  }
  const contentType = String(body.contentType || 'video/mp4');
  if (!['video/mp4', 'video/quicktime', 'video/webm'].includes(contentType)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'mp4 / mov / webm 만 허용' }) };
  }

  // 파일명: 카테고리/timestamp-random-원본.ext (충돌 방지)
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-50);
  const storagePath = `${category}/${ts}-${rand}-${safeName}`;

  // Supabase signed upload URL — 5분 TTL
  const { data, error } = await admin.storage
    .from(STORAGE_BUCKET)
    .createSignedUploadUrl(storagePath, { upsert: false });

  if (error) {
    console.error('[admin-hook-videos] signed URL 발급 실패:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }

  // public URL (Storage 가 public 버킷이라 그대로 사용 가능)
  const supabaseUrl = process.env.SUPABASE_URL;
  const publicUrl = `${supabaseUrl}/storage/v1/object/public/${STORAGE_BUCKET}/${storagePath}`;

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      uploadUrl: data.signedUrl,
      token: data.token,
      storagePath,
      publicUrl,
      expiresIn: 300,  // 5분
    }),
  };
}

async function handleInsertRow(admin, body, headers, adminSellerId) {
  // 필수 필드 검증
  const category = String(body.category || '').toLowerCase().trim();
  const title    = String(body.title || '').trim().slice(0, 80);
  const videoUrl = String(body.video_url || '').trim();
  const duration = Number(body.duration_sec);

  if (!VALID_CATEGORIES.has(category)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `category 는 ${[...VALID_CATEGORIES].join(', ')} 중 하나` }) };
  }
  if (!title) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '제목(title)을 입력해주세요.' }) };
  }
  if (!videoUrl || !/^https?:\/\//.test(videoUrl)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'video_url 누락 또는 형식 오류' }) };
  }
  if (!Number.isFinite(duration) || duration <= 0 || duration > 60) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'duration_sec 는 0~60 초 사이' }) };
  }

  const insertPayload = {
    category,
    title,
    prompt: body.prompt ? String(body.prompt).slice(0, 1000) : null,
    source_model: body.source_model ? String(body.source_model).slice(0, 50) : null,
    video_url: videoUrl,
    duration_sec: duration,
    width: body.width ? parseInt(body.width, 10) || null : null,
    height: body.height ? parseInt(body.height, 10) || null : null,
    file_size: body.file_size ? parseInt(body.file_size, 10) || null : null,
    thumb_url: body.thumb_url ? String(body.thumb_url).trim() : null,
    notes: body.notes ? String(body.notes).slice(0, 500) : null,
    active: body.active !== false,  // 기본 true
    created_by: adminSellerId,
  };

  const { data, error } = await admin
    .from('hook_videos')
    .insert(insertPayload)
    .select()
    .single();

  if (error) {
    console.error('[admin-hook-videos] insert 실패:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }

  return { statusCode: 201, headers, body: JSON.stringify({ ok: true, video: data }) };
}

// ─────────── PATCH (toggle active / update notes / update title) ───────────
async function handlePatch(admin, event, headers) {
  const qs = event.queryStringParameters || {};
  const id = qs.id;
  if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id 쿼리 파라미터 필수' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid_json' }) };
  }

  const updates = { updated_at: new Date().toISOString() };
  if (typeof body.active === 'boolean')                 updates.active = body.active;
  if (typeof body.notes === 'string')                   updates.notes = body.notes.slice(0, 500);
  if (typeof body.title === 'string' && body.title.trim()) updates.title = body.title.trim().slice(0, 80);
  if (typeof body.category === 'string' && VALID_CATEGORIES.has(body.category.toLowerCase())) {
    updates.category = body.category.toLowerCase();
  }

  if (Object.keys(updates).length === 1) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: '변경할 필드가 없습니다.' }) };
  }

  const { data, error } = await admin
    .from('hook_videos')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('[admin-hook-videos] patch 실패:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
  if (!data) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: '영상을 찾을 수 없습니다.' }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, video: data }) };
}

// ─────────── DELETE (row + Storage 파일) ───────────
async function handleDelete(admin, event, headers) {
  const qs = event.queryStringParameters || {};
  const id = qs.id;
  if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id 쿼리 파라미터 필수' }) };

  // 1) row 조회 → video_url 추출 (Storage 파일 경로 파싱)
  const { data: row, error: selErr } = await admin
    .from('hook_videos')
    .select('id, video_url, thumb_url')
    .eq('id', id)
    .maybeSingle();

  if (selErr) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: selErr.message }) };
  }
  if (!row) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: '영상을 찾을 수 없습니다.' }) };
  }

  // 2) Storage 파일 경로 추출 (public URL → bucket 이후 경로)
  // 예: https://....supabase.co/storage/v1/object/public/lumi-hook-videos/cafe/abc.mp4 → cafe/abc.mp4
  function extractStoragePath(url) {
    if (!url) return null;
    const m = url.match(new RegExp(`/storage/v1/object/public/${STORAGE_BUCKET}/(.+?)(?:\\?|$)`));
    return m ? decodeURIComponent(m[1]) : null;
  }
  const videoPath = extractStoragePath(row.video_url);
  const thumbPath = extractStoragePath(row.thumb_url);
  const pathsToDelete = [videoPath, thumbPath].filter(Boolean);

  // 3) Storage 파일 삭제 (실패해도 DB row 는 삭제 — orphan 파일은 별도 cleanup cron 으로 처리)
  if (pathsToDelete.length) {
    try {
      const { error: storageErr } = await admin.storage.from(STORAGE_BUCKET).remove(pathsToDelete);
      if (storageErr) console.warn('[admin-hook-videos] Storage 삭제 경고:', storageErr.message);
    } catch (e) {
      console.warn('[admin-hook-videos] Storage 삭제 예외:', e && e.message);
    }
  }

  // 4) DB row 삭제
  const { error: delErr } = await admin.from('hook_videos').delete().eq('id', id);
  if (delErr) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: delErr.message }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, deleted: id, storage_files: pathsToDelete.length }) };
}
