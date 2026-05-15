// Netlify Background Function: /api/process-video
// 서버 내장 FFmpeg로 REELS 영상 후처리 (블러 패딩 + 자막 burn-in).
// 내부 호출 전용(LUMI_SECRET). Modal 의존성 없음.

const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
// ffmpeg binary 선택 — @ffmpeg-installer/ffmpeg 우선 (full build, drawtext/subtitles 포함).
// 실패 시 ffmpeg-static fallback (minimal build, drawtext 없음 — 텍스트 박기 불가).
// 검증 2026-05-15: ffmpeg-static 만 쓰면 'Filter not found' 에러.
let ffmpegPath;
try {
  ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
} catch (_) {
  ffmpegPath = require('ffmpeg-static');
}
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

// 한글 폰트 — 함수 디렉토리 옆 _fonts/ 에서 Pretendard-Bold.ttf 로드.
// lumi 사이트 전체가 Pretendard 사용 — 브랜드 일관 + SNS 영상 자막 표준 폰트.
// netlify.toml 의 included_files 로 번들.
const FONT_DIR = __dirname + '/_fonts';
const FONT_FAMILY = 'Pretendard Bold';
function findFontFile() {
  const candidates = [
    FONT_DIR + '/Pretendard-Bold.ttf',
    FONT_DIR + '/NanumGothic-Regular.ttf',
    FONT_DIR + '/NotoSansKR-Regular.otf',
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
  // 자막 burn-in (srt 있을 때) — libass 가 fontsdir 의 Pretendard-Bold.ttf 로드
  if (srtPath) {
    const esc = escapeSubtitlePath(srtPath);
    const fontsDirOpt = fontFile
      ? `:fontsdir='${escapeSubtitlePath(FONT_DIR)}'`
      : '';
    parts.push(`${stage}subtitles='${esc}'${fontsDirOpt}:force_style='Fontname=${FONT_FAMILY},Fontsize=22,PrimaryColour=&HFFFFFFFF&,OutlineColour=&H00000000&,BorderStyle=3,Outline=2,MarginV=80'[v1]`);
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

// post_mode='immediate' 인 REELS 만 즉시 select-and-post 호출.
// 'scheduled' / 'best-time' / brand-auto 는 scheduler cron 이 다음 cycle 에 픽업.
async function triggerSelectAndPostIfImmediate(supabase, reservationKey) {
  try {
    const { data: row } = await supabase
      .from('reservations')
      .select('post_mode, is_brand_auto, selected_caption_index, caption_status')
      .eq('reserve_key', reservationKey)
      .maybeSingle();
    if (!row) return;
    if (row.is_brand_auto === true) return;
    if (row.post_mode !== 'immediate') return;
    if (row.caption_status !== 'scheduled') return;

    const captionIndex = (row.selected_caption_index ?? 0);
    const base = process.env.URL || process.env.DEPLOY_URL || 'https://lumi.it.kr';
    const res = await fetch(`${base.replace(/\/$/, '')}/.netlify/functions/select-and-post-background`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.LUMI_SECRET}`,
      },
      body: JSON.stringify({ reservationKey, captionIndex }),
    });
    console.log('[process-video] select-and-post 핸드오프:', res.status);
  } catch (e) {
    console.warn('[process-video] select-and-post 핸드오프 실패:', e.message);
  }
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

  // 진단 trace 헬퍼 — 단계마다 DB 의 subtitle_status 에 marker.
  // Netlify CLI logs API 가 process-video 의 stdout 을 capture 못 함 (2026-05-15 검증).
  // dashboard 캡쳐 없이 DB 폴링으로 어디서 stuck 되는지 추적.
  const trace = async (stage) => {
    try { await supabase.from('reservations').update({ subtitle_status: `trace:${stage}` }).eq('reserve_key', reservationKey); } catch(_) {}
  };

  const t0 = Date.now();
  try {
    console.log('[process-video] 시작:', reservationKey);
    await trace('start');
    await downloadTo(videoUrl, inPath);
    await trace('downloaded');
    const { width, height } = await probeVideo(inPath);
    await trace(`probed:${width}x${height}`);
    console.log('[process-video] 해상도:', `${width}x${height}`);

    // ─── 자막 결정: Whisper 우선, 실패 시 fallback ───
    let srtUsed = '';
    if (wantSubtitle) {
      try {
        await trace('pre-extractAudio');
        await extractAudio(inPath, audioPath);
        await trace('audioExtracted');
        console.log('[process-video] 오디오 추출 완료');
        const whisperSrt = await transcribeWithWhisper(audioPath);
        await trace(whisperSrt ? 'whisperOK' : 'whisperEmpty');
        if (whisperSrt) {
          srtUsed = whisperSrt;
          console.log('[process-video] Whisper SRT 사용 (음성 기반)');
        } else if (fallbackSrt) {
          srtUsed = fallbackSrt;
          console.log('[process-video] Whisper 결과 없음 → 캡션 기반 SRT fallback');
        }
      } catch (whErr) {
        await trace(`whisperFail:${(whErr.message || '').slice(0, 80)}`);
        console.warn('[process-video] Whisper 실패 → 캡션 SRT fallback:', whErr.message);
        if (fallbackSrt) srtUsed = fallbackSrt;
      }
    }

    const useSrt = !!srtUsed;
    if (useSrt) fs.writeFileSync(srtPath, srtUsed, 'utf8');

    const fontFile = findFontFile();
    if (!fontFile) console.warn('[process-video] 한글 폰트 파일 없음 — 시스템 fallback (한글 깨질 수 있음)');

    // ffmpeg args 생성 헬퍼 — withSubtitles 토글로 subtitles 필터 ON/OFF.
    // ffmpeg-static binary 가 libass 미포함이라 subtitles 필터 시도 시 exit=8 가능.
    // 1차 시도 (자막+drawtext) → fail 시 drawtext 만으로 재시도 (overlay text 만은 확실히 박힘).
    const buildArgs = (withSubtitles) => {
      const { filter } = buildFilter({
        width,
        height,
        srtPath: withSubtitles && useSrt ? srtPath : null,
        overlayText: hasOverlay ? overlayText : null,
        fontFile,
      });
      return [
        '-hide_banner', '-y',
        '-i', inPath,
        '-t', String(MAX_DURATION_SEC),
        '-filter_complex', filter,
        '-map', '[vout]',
        '-map', '0:a?',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '20',
        '-maxrate', MAX_VIDEO_BITRATE,
        '-bufsize', VIDEO_BUFSIZE,
        '-c:a', 'aac',
        '-b:a', AUDIO_BITRATE,
        '-ar', AUDIO_SAMPLE_RATE,
        '-movflags', '+faststart',
        '-pix_fmt', 'yuv420p',
        outPath,
      ];
    };

    console.log('[process-video] 블러패딩:', '자막:', useSrt, '화면텍스트:', hasOverlay);
    let subtitlesAttempted = useSrt;
    let subtitlesApplied = false;
    if (useSrt) {
      await trace('pre-ffmpeg-with-subtitles');
      try {
        await runFfmpeg(buildArgs(true));
        subtitlesApplied = true;
        await trace('ffmpegDone-with-subtitles');
      } catch (e) {
        // libass 또는 subtitles 필터 fail — drawtext 만으로 재시도.
        await trace(`subtitleFail-retry:${(e.message || '').slice(0, 60)}`);
        console.warn('[process-video] 자막 필터 fail, drawtext-only 재시도:', e.message);
        try { fs.unlinkSync(outPath); } catch(_) {}
        await runFfmpeg(buildArgs(false));
        await trace('ffmpegDone-no-subtitles');
      }
    } else {
      await trace('pre-ffmpeg-no-subtitles');
      await runFfmpeg(buildArgs(false));
      await trace('ffmpegDone-no-subtitles');
    }
    console.log('[process-video] ffmpeg 완료:', Date.now() - t0, 'ms', 'subtitles=', subtitlesApplied);

    await trace('pre-upload');
    const destKey = `${userId}/${reservationKey}/processed-${ts}.mp4`;
    const publicUrl = await uploadToSupabase({ filepath: outPath, destKey });
    await trace('uploaded');
    console.log('[process-video] 업로드 완료:', destKey);

    const { error: upErr } = await supabase
      .from('reservations')
      .update({
        video_url: publicUrl,
        subtitle_status: 'applied',
        video_processed_at: new Date().toISOString(),
      })
      .eq('reserve_key', reservationKey);
    if (upErr) console.error('[process-video] 예약 업데이트 실패:', upErr.message);

    // 후처리 완료 → select-and-post 핸드오프.
    // race 차단: process-and-post 는 REELS 일 때 select-and-post 를 트리거하지 않는다.
    // immediate 만 즉시 트리거. scheduled / best-time 은 scheduler cron 이 video_processed_at 세팅된
    // row 를 다음 cycle 에 픽업.
    await triggerSelectAndPostIfImmediate(supabase, reservationKey);

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, videoUrl: publicUrl }) };
  } catch (err) {
    console.error('[process-video] 에러:', err.message, err.stack);
    try {
      // 실패 시에도 video_processed_at 마킹 → 원본 video_url 로라도 게시 진행 (overlay/자막만 누락).
      // 에러 메시지를 subtitle_status 에 prefix 로 저장 → 사장님이 history UI 또는 DB 에서
      // 진단 가능 (검증 2026-05-15: 'skipped' 만 저장 시 원인 추적 불가).
      const errSummary = String(err && err.message || 'unknown').slice(0, 180);
      await supabase.from('reservations').update({
        subtitle_status: `skipped:${errSummary}`,
        video_processed_at: new Date().toISOString(),
      }).eq('reserve_key', reservationKey);
      await triggerSelectAndPostIfImmediate(supabase, reservationKey);
    } catch(_) {}
    return { statusCode: 500, headers, body: JSON.stringify({ error: '영상 후처리 실패' }) };
  } finally {
    safeUnlink(inPath);
    safeUnlink(outPath);
    safeUnlink(audioPath);
    safeUnlink(srtPath);
  }
};

