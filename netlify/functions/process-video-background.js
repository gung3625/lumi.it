// Netlify Background Function: /api/process-video
// 서버 내장 FFmpeg로 REELS 영상 후처리 (블러 패딩 + 자막 burn-in).
// 내부 호출 전용(LUMI_SECRET). Modal 의존성 없음.

const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const ffmpegPath = require('ffmpeg-static');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { getAdminClient } = require('./_shared/supabase-admin');


const TARGET_W = 1080;
const TARGET_H = 1920;
const TARGET_AR = TARGET_W / TARGET_H;
const AR_TOLERANCE = 0.02;

function runFfmpeg(args, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const to = setTimeout(() => { try { proc.kill('SIGKILL'); } catch(_) {} reject(new Error('ffmpeg timeout')); }, timeoutMs);
    proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    proc.on('error', (e) => { clearTimeout(to); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(to);
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg exit=${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function probeVideo(filepath) {
  const out = await runFfmpeg(['-hide_banner', '-i', filepath, '-f', 'null', '-'], 30_000).catch((e) => e.message);
  const m = String(out).match(/Stream.*Video:.*?(\d+)x(\d+)/);
  if (!m) throw new Error('영상 해상도 파싱 실패');
  return { width: Number(m[1]), height: Number(m[2]) };
}

function escapeSubtitlePath(p) {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function buildFilter({ width, height, srtPath }) {
  const ar = width / height;
  const needPad = Math.abs(ar - TARGET_AR) > AR_TOLERANCE;
  const parts = [];
  if (needPad) {
    parts.push(
      `[0:v]split=2[a][b];` +
      `[b]scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=increase,crop=${TARGET_W}:${TARGET_H},boxblur=30:1[bg];` +
      `[a]scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[v0]`
    );
  } else {
    parts.push(`[0:v]scale=${TARGET_W}:${TARGET_H}[v0]`);
  }
  if (srtPath) {
    const esc = escapeSubtitlePath(srtPath);
    parts.push(`[v0]subtitles='${esc}':force_style='Fontname=NanumGothic,Fontsize=20,PrimaryColour=&HFFFFFFFF&,OutlineColour=&H00000000&,BorderStyle=3,Outline=2,MarginV=80'[vout]`);
  } else {
    parts.push(`[v0]null[vout]`);
  }
  return { filter: parts.join(';'), needPad };
}

async function downloadTo(url, dest, timeoutMs = 60_000) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    const contentLen = Number(res.headers.get('content-length') || 0);
    if (contentLen && contentLen > 400 * 1024 * 1024) {
      throw new Error(`video too large: ${contentLen} bytes`);
    }
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
    return fs.statSync(dest).size;
  } finally {
    clearTimeout(tid);
  }
}

async function uploadToSupabase({ filepath, destKey, contentType = 'video/mp4' }) {
  const url = `${process.env.SUPABASE_URL}/storage/v1/object/lumi-videos/${destKey}`;
  const size = fs.statSync(filepath).size;
  const stream = fs.createReadStream(filepath);
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': contentType,
        'Content-Length': String(size),
        'x-upsert': 'true',
      },
      body: stream,
      duplex: 'half',
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`upload HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
    return `${process.env.SUPABASE_URL}/storage/v1/object/public/lumi-videos/${destKey}`;
  } finally {
    clearTimeout(tid);
  }
}

function safeUnlink(p) { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch(_) {} }

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  const authHeader = (event.headers['authorization'] || '').replace('Bearer ', '');
  if (!safeEqual(authHeader, process.env.LUMI_SECRET)) {
    console.error('[process-video] 인증 실패');
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'unauthorized' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(_) {}
  const { reservationKey, videoUrl, srt, userId } = body;
  if (!reservationKey || !videoUrl || !userId) {
    console.error('[process-video] 필수 파라미터 누락');
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing params' }) };
  }

  const supabase = getAdminClient();
  const ts = Date.now();
  const safeKey = reservationKey.replace(/[^a-zA-Z0-9-_]/g, '_');
  const inPath = `/tmp/in_${safeKey}_${ts}.mp4`;
  const outPath = `/tmp/out_${safeKey}_${ts}.mp4`;
  const srtPath = srt ? `/tmp/sub_${safeKey}_${ts}.srt` : null;

  const t0 = Date.now();
  try {
    console.log('[process-video] 시작:', reservationKey);
    await downloadTo(videoUrl, inPath);
    const { width, height } = await probeVideo(inPath);
    console.log('[process-video] 해상도:', `${width}x${height}`);

    const ar = width / height;
    const needPad = Math.abs(ar - TARGET_AR) > AR_TOLERANCE;
    if (!needPad && !srt) {
      console.log('[process-video] 처리 불필요 — 원본 유지');
      await supabase.from('reservations').update({ subtitle_status: 'skipped' }).eq('reserve_key', reservationKey);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, skipped: true }) };
    }

    if (srtPath) fs.writeFileSync(srtPath, srt, 'utf8');

    const { filter } = buildFilter({ width, height, srtPath });
    console.log('[process-video] 블러패딩:', needPad, '자막:', !!srtPath);

    const args = [
      '-hide_banner', '-y',
      '-i', inPath,
      '-filter_complex', filter,
      '-map', '[vout]',
      '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-pix_fmt', 'yuv420p',
      outPath,
    ];
    await runFfmpeg(args);
    console.log('[process-video] ffmpeg 완료:', Date.now() - t0, 'ms');

    const destKey = `${userId}/${reservationKey}/processed-${ts}.mp4`;
    const publicUrl = await uploadToSupabase({ filepath: outPath, destKey });
    console.log('[process-video] 업로드 완료:', destKey);

    const { error: upErr } = await supabase
      .from('reservations')
      .update({ video_url: publicUrl, subtitle_status: 'applied' })
      .eq('reserve_key', reservationKey);
    if (upErr) console.error('[process-video] 예약 업데이트 실패:', upErr.message);

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, videoUrl: publicUrl }) };
  } catch (err) {
    console.error('[process-video] 에러:', err.message);
    try {
      await supabase.from('reservations').update({ subtitle_status: 'skipped' }).eq('reserve_key', reservationKey);
    } catch(_) {}
    return { statusCode: 500, headers, body: JSON.stringify({ error: '영상 후처리 실패' }) };
  } finally {
    safeUnlink(inPath);
    safeUnlink(outPath);
    if (srtPath) safeUnlink(srtPath);
  }
};

exports.headers = headers;
