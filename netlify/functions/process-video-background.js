// Netlify Background Function: /api/process-video
// 서버 내장 FFmpeg로 REELS 영상 후처리 (블러 패딩 + 자막 burn-in).
// 내부 호출 전용(LUMI_SECRET). Modal 의존성 없음.

const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
// ffmpeg binary — ffmpeg-static (minimal build). drawtext / subtitles 필터 미포함.
// 텍스트 박기 흐름:
//   1) text-to-svg: 폰트 ttf 파일 직접 파싱 → 한글 글리프를 SVG path 로 변환 (pure JS, 시스템 폰트 의존성 0)
//   2) sharp: SVG → PNG buffer (path 만 있어서 librsvg fontconfig 불필요)
//   3) ffmpeg overlay 필터: PNG 를 영상 위에 합성 (minimal build 도 overlay 포함)
const ffmpegPath = require('ffmpeg-static');
const sharp = require('sharp');
const TextToSVG = require('text-to-svg');
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

// 텍스트 PNG 생성 — text-to-svg 가 ttf 파일을 직접 파싱해서 글리프를 SVG path 로
// 변환. librsvg/fontconfig 의 시스템 폰트 fallback (tofu) 우회. 한글 OK.
async function makeOverlayTextPng({ text, fontFile, width = TARGET_W, fontSize = 64 }) {
  const safe = String(text || '').slice(0, 40);
  if (!safe.trim()) return null;
  if (!fontFile || !fs.existsSync(fontFile)) {
    console.warn('[process-video] 한글 폰트 파일 없음 — overlay PNG skip');
    return null;
  }

  // text-to-svg: 폰트 파일 직접 파싱. ttf 의 각 문자를 vector path 로 추출.
  const textToSVG = TextToSVG.loadSync(fontFile);
  // 텍스트 path 만 — 캔버스 안에 중앙 정렬. attributes 로 흰 채움 + 검은 외곽선.
  const pathSvg = textToSVG.getSVG(safe, {
    x: 0,
    y: 0,
    fontSize,
    anchor: 'top',
    attributes: {
      fill: 'white',
      stroke: 'black',
      'stroke-width': '6',
      'stroke-linejoin': 'round',
      'paint-order': 'stroke fill',
    },
  });

  // getSVG 가 fitted SVG 반환 (width/height 자동). 캔버스 크기 측정.
  const metrics = textToSVG.getMetrics(safe, { fontSize });
  const textW = Math.ceil(metrics.width);
  const textH = Math.ceil(metrics.height + 24); // 외곽선 두께 여유
  // 캔버스 너비 = TARGET_W (영상 너비), 텍스트 중앙 배치.
  const x = Math.round((width - textW) / 2);
  // pathSvg 가 자체 <svg> wrapper 라 inner path 만 추출.
  const innerMatch = pathSvg.match(/<path[^>]*\/>/);
  const innerPath = innerMatch ? innerMatch[0] : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${textH}">
  <g transform="translate(${x}, 12)">${innerPath}</g>
</svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return png;
}

function buildFilter({ width, height, hasOverlayPng }) {
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

  // 화면 텍스트 — sharp 로 만든 PNG 를 두 번째 입력 [1:v] 으로 받아 overlay 합성.
  // ffmpeg-static minimal 도 overlay 필터는 포함 (drawtext / subtitles 와 달리).
  // 위치: 상단 중앙, y=120.
  if (hasOverlayPng) {
    parts.push(`[v0][1:v]overlay=(W-w)/2:120[vout]`);
  } else {
    parts.push(`[v0]null[vout]`);
  }

  return { filter: parts.join(';'), needPad };
}

// S3 (2026-05-15): SSRF 차단 — videoUrl 의 host 화이트리스트 검증.
// 이전엔 LUMI_SECRET 만 가지면 임의 URL 다운로드 가능 → 169.254.169.254 같은
// metadata endpoint / 사설망 노출 위험. supabase storage / IG CDN 만 허용.
function assertSafeFetchUrl(url) {
  let u;
  try { u = new URL(url); } catch (_) {
    throw new Error('invalid url');
  }
  if (u.protocol !== 'https:') throw new Error('https only');
  const host = u.hostname.toLowerCase();
  // 1) Supabase project storage (사장님 영상 업로드 위치)
  if (host.endsWith('.supabase.co')) return;
  // 2) Meta CDN (이미 게시된 영상 reprocess 등)
  if (host.endsWith('.cdninstagram.com') || host.endsWith('.fbcdn.net')) return;
  // 3) lumi 도메인 (proxy/serve-image 경유 등)
  if (host === 'lumi.it.kr' || host.endsWith('.lumi.it.kr')) return;
  throw new Error(`download host not allowed: ${host}`);
}

async function downloadTo(url, dest, timeoutMs = 60_000) {
  assertSafeFetchUrl(url);
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

  // C6 (2026-05-15): 멱등성 가드 — 이미 처리 중이거나 완료된 reservation 은 즉시 종료.
  // reserve.js 가 즉시 트리거하고 process-and-post 도 동일 reservation 에 트리거 →
  // 두 process-video invocation 발생. ffmpeg + Whisper 2배 비용.
  // video_processed_at IS NOT NULL = 이미 한 번 처리됨 (성공·실패 다음 video_url 갱신됨).
  // subtitle_status='trace:start' 같은 진행 표시는 짧은 race window 라 무시.
  try {
    const { data: pre } = await supabase
      .from('reservations')
      .select('video_processed_at, subtitle_status, is_sent')
      .eq('reserve_key', reservationKey)
      .maybeSingle();
    if (pre && pre.video_processed_at) {
      console.log('[process-video] 이미 처리됨 — skip (video_processed_at=' + pre.video_processed_at + ')');
      return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'already_processed' }) };
    }
    if (pre && pre.is_sent) {
      console.log('[process-video] 이미 게시됨 — skip');
      return { statusCode: 200, headers, body: JSON.stringify({ skipped: true, reason: 'already_sent' }) };
    }
  } catch (preErr) {
    console.warn('[process-video] 멱등 체크 실패 (계속 진행):', preErr.message);
  }

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
    if (!fontFile) console.warn('[process-video] 한글 폰트 파일 없음 — SVG 안에 embed 못 함');

    // 화면 텍스트 → sharp 로 PNG 사전 렌더링 (ffmpeg-static drawtext 미포함 우회).
    // PNG 파일을 ffmpeg 의 두 번째 입력 [1:v] 으로 받아 overlay 필터로 합성.
    const overlayPngPath = `/tmp/overlay_${safeKey}_${ts}.png`;
    let hasOverlayPng = false;
    if (hasOverlay) {
      try {
        await trace('pre-overlayPng');
        const pngBuf = await makeOverlayTextPng({ text: overlayText, fontFile, width: TARGET_W, fontSize: 64 });
        if (pngBuf) {
          fs.writeFileSync(overlayPngPath, pngBuf);
          hasOverlayPng = true;
          await trace('overlayPngReady');
        }
      } catch (e) {
        await trace(`overlayPngFail:${(e.message || '').slice(0, 60)}`);
        console.warn('[process-video] overlay PNG 생성 실패:', e.message);
      }
    }

    const { filter } = buildFilter({ width, height, hasOverlayPng });
    const args = [
      '-hide_banner', '-y',
      '-i', inPath,
    ];
    if (hasOverlayPng) args.push('-i', overlayPngPath);
    args.push(
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
    );

    console.log('[process-video] 화면텍스트:', hasOverlayPng, '자막:', useSrt, '(subtitles=libass 미지원으로 일단 skip)');
    await trace('pre-ffmpeg');
    await runFfmpeg(args);
    await trace('ffmpegDone');
    console.log('[process-video] ffmpeg 완료:', Date.now() - t0, 'ms');

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
    try { safeUnlink(`/tmp/overlay_${safeKey}_${ts}.png`); } catch(_) {}
  }
};

