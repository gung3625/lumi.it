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
const MAX_DURATION_SEC = 90;       // Meta Reels 탭 노출 자격
const MAX_VIDEO_BITRATE = '25M';   // Meta API 한도
const VIDEO_BUFSIZE = '50M';
const AUDIO_BITRATE = '192k';      // 화질 보존 (128k → 192k)
const AUDIO_SAMPLE_RATE = '48000'; // Meta 권장

// 한글 폰트 — 함수 디렉토리 옆 _fonts/ 에 있으면 사용, 없으면 시스템 fallback.
// 별도 step 에서 NanumGothic.ttf 또는 NotoSansKR.otf 번들 예정.
const FONT_DIR = __dirname + '/_fonts';
function findFontFile() {
  const candidates = [
    FONT_DIR + '/NanumGothic-Regular.ttf',
    FONT_DIR + '/NotoSansKR-Regular.otf',
    FONT_DIR + '/NotoSansKR-Bold.otf',
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

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

function escapeDrawText(s) {
  // ffmpeg drawtext 의 text 옵션은 ':, ', \, % 를 escape 해야 함
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/%/g, '\\%');
}

function buildFilter({ width, height, srtPath, overlayText, fontFile }) {
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

  let stage = '[v0]';
  // 자막 burn-in (srt 있을 때)
  if (srtPath) {
    const esc = escapeSubtitlePath(srtPath);
    const fontname = fontFile ? 'NanumGothic' : 'NanumGothic'; // force_style fontname은 시스템 폰트 의존
    parts.push(`${stage}subtitles='${esc}':force_style='Fontname=${fontname},Fontsize=20,PrimaryColour=&HFFFFFFFF&,OutlineColour=&H00000000&,BorderStyle=3,Outline=2,MarginV=80'[v1]`);
    stage = '[v1]';
  }

  // 화면 텍스트 (overlayText) — 상단 중앙
  if (overlayText) {
    const text = escapeDrawText(overlayText);
    // 폰트 파일 있으면 fontfile, 없으면 fontconfig 의 default
    const fontOpt = fontFile ? `fontfile='${fontFile.replace(/'/g, "\\'")}'` : '';
    const drawArgs = [
      fontOpt,
      `text='${text}'`,
      `fontsize=56`,
      `fontcolor=white`,
      `borderw=4`,
      `bordercolor=black@0.85`,
      `x=(w-text_w)/2`,
      `y=120`,
    ].filter(Boolean).join(':');
    parts.push(`${stage}drawtext=${drawArgs}[vout]`);
  } else {
    parts.push(`${stage}null[vout]`);
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

// 영상에서 오디오만 추출 (Whisper API 전송용)
async function extractAudio(videoPath, audioPath) {
  await runFfmpeg([
    '-hide_banner', '-y',
    '-i', videoPath,
    '-vn',                       // 비디오 제외
    '-acodec', 'libmp3lame',     // mp3 (Whisper 친화 + 작은 크기)
    '-ar', '16000',              // 16kHz (Whisper 권장)
    '-ac', '1',                  // mono
    '-b:a', '64k',
    audioPath,
  ], 60_000);
}

// Whisper API 호출 → SRT 자막 텍스트 반환
async function transcribeWithWhisper(audioPath) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY missing');
  if (!fs.existsSync(audioPath)) throw new Error('audio file not found');

  const stat = fs.statSync(audioPath);
  if (stat.size < 1024) {
    // 너무 작으면 거의 무음 — Whisper 호출 비용 아낌
    console.log('[process-video] audio too small, skip Whisper');
    return '';
  }

  // OpenAI Whisper API 는 multipart/form-data
  const FormData = require('form-data');
  const fd = new FormData();
  fd.append('file', fs.createReadStream(audioPath), {
    filename: 'audio.mp3',
    contentType: 'audio/mpeg',
  });
  fd.append('model', 'whisper-1');         // srt 출력 지원하는 유일 모델
  fd.append('response_format', 'srt');
  fd.append('language', 'ko');             // 한국어 명시 (정확도 ↑)

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, ...fd.getHeaders() },
      body: fd,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Whisper HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    const srt = await res.text();
    if (!/-->/.test(srt)) return '';
    return srt.trim();
  } finally {
    clearTimeout(tid);
  }
}

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
  // srt = process-and-post 가 전달한 fallback (캡션 기반) — 음성 없을 때 사용
  // overlayText = 사장님이 register-product 에서 입력한 화면 텍스트
  // useSubtitle = 자막 자동 생성 ON/OFF
  const { reservationKey, videoUrl, srt: fallbackSrt, userId, overlayText, useSubtitle } = body;
  if (!reservationKey || !videoUrl || !userId) {
    console.error('[process-video] 필수 파라미터 누락');
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing params' }) };
  }
  const wantSubtitle = useSubtitle !== false;       // 디폴트 ON
  const hasOverlay = !!(overlayText && String(overlayText).trim());

  const supabase = getAdminClient();
  const ts = Date.now();
  const safeKey = reservationKey.replace(/[^a-zA-Z0-9-_]/g, '_');
  const inPath = `/tmp/in_${safeKey}_${ts}.mp4`;
  const outPath = `/tmp/out_${safeKey}_${ts}.mp4`;
  const audioPath = `/tmp/audio_${safeKey}_${ts}.mp3`;
  const srtPath = `/tmp/sub_${safeKey}_${ts}.srt`;

  const t0 = Date.now();
  try {
    console.log('[process-video] 시작:', reservationKey);
    await downloadTo(videoUrl, inPath);
    const { width, height } = await probeVideo(inPath);
    console.log('[process-video] 해상도:', `${width}x${height}`);

    // ─── 자막 결정: Whisper 우선, 실패 시 fallback ───
    let srtUsed = '';
    if (wantSubtitle) {
      try {
        await extractAudio(inPath, audioPath);
        console.log('[process-video] 오디오 추출 완료');
        const whisperSrt = await transcribeWithWhisper(audioPath);
        if (whisperSrt) {
          srtUsed = whisperSrt;
          console.log('[process-video] Whisper SRT 사용 (음성 기반)');
        } else if (fallbackSrt) {
          srtUsed = fallbackSrt;
          console.log('[process-video] Whisper 결과 없음 → 캡션 기반 SRT fallback');
        }
      } catch (whErr) {
        console.warn('[process-video] Whisper 실패 → 캡션 SRT fallback:', whErr.message);
        if (fallbackSrt) srtUsed = fallbackSrt;
      }
    }

    const useSrt = !!srtUsed;
    if (useSrt) fs.writeFileSync(srtPath, srtUsed, 'utf8');

    const fontFile = findFontFile();
    if (!fontFile) console.warn('[process-video] 한글 폰트 파일 없음 — 시스템 fallback (한글 깨질 수 있음)');

    const { filter, needPad } = buildFilter({
      width,
      height,
      srtPath: useSrt ? srtPath : null,
      overlayText: hasOverlay ? overlayText : null,
      fontFile,
    });
    console.log('[process-video] 블러패딩:', needPad, '자막:', useSrt, '화면텍스트:', hasOverlay);

    // 90초 trim + CRF 20 + maxrate 25M + AAC 48kHz + preset medium (화질 보존)
    const args = [
      '-hide_banner', '-y',
      '-i', inPath,
      '-t', String(MAX_DURATION_SEC),           // 90초 trim
      '-filter_complex', filter,
      '-map', '[vout]',
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'medium',                       // veryfast → medium (압축 효율 ↑)
      '-crf', '20',                              // 23 → 20 (화질 ↑)
      '-maxrate', MAX_VIDEO_BITRATE,             // 25M (Meta 한도)
      '-bufsize', VIDEO_BUFSIZE,
      '-c:a', 'aac',
      '-b:a', AUDIO_BITRATE,                     // 128k → 192k
      '-ar', AUDIO_SAMPLE_RATE,                  // 48kHz 명시 (Meta 권장)
      '-movflags', '+faststart',                 // moov atom 앞 (Meta 필수)
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
    safeUnlink(audioPath);
    safeUnlink(srtPath);
  }
};

