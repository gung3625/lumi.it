// OpenAI Sora 2 영상 생성 클라이언트 래퍼 (비동기 폴링).
// Job 생성: POST https://api.openai.com/v1/videos
// 폴링:    GET  https://api.openai.com/v1/videos/{id}
// 다운로드: GET https://api.openai.com/v1/videos/{id}/content?variant=video
//
// 환경변수: OPENAI_API_KEY (필수). 값은 절대 로그·응답에 노출 금지.
// 주의: URL은 1시간만 유효 → 완료 즉시 Supabase Storage에 저장 필수.

const OPENAI_BASE = 'https://api.openai.com/v1';
const VIDEO_MODEL = 'sora-2';

const VIDEO_JOB_TIMEOUT_MS = 30_000;
const VIDEO_TOTAL_TIMEOUT_MS = 15 * 60 * 1000;  // 15분
const VIDEO_POLL_INTERVAL_MS = 10_000;           // 10초 기본 간격
const DOWNLOAD_TIMEOUT_MS = 120_000;             // 다운로드 2분

function requireApiKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY 환경변수가 설정되지 않았습니다.');
  return key;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function readErrorSnippet(res) {
  try {
    const t = await res.text();
    return (t || '').slice(0, 300);
  } catch (_) {
    return '';
  }
}

/**
 * Sora 2 영상 생성 (비동기 폴링) → Buffer + mimeType
 * URL은 1시간 유효 — 반환 즉시 Supabase Storage에 저장 필수.
 * @param {{ prompt: string, size?: string, seconds?: number }} options
 * @returns {Promise<{ buffer: Buffer, mimeType: string }>}
 */
async function generateVideo({ prompt, size = '720x1280', seconds = 8 } = {}) {
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('generateVideo: prompt 필수');
  }
  const apiKey = requireApiKey();

  // 1) Job 생성
  const jobBody = {
    model: VIDEO_MODEL,
    prompt,
    size,
    seconds,
  };

  const jobCtrl = new AbortController();
  const jobTid = setTimeout(() => jobCtrl.abort(), VIDEO_JOB_TIMEOUT_MS);
  let jobRes;
  try {
    jobRes = await fetch(`${OPENAI_BASE}/videos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(jobBody),
      signal: jobCtrl.signal,
    });
  } catch (e) {
    clearTimeout(jobTid);
    throw new Error(`Sora 2 job 생성 요청 실패: ${e.message || 'network error'}`);
  }
  clearTimeout(jobTid);

  // 403: 조직 인증 미완료
  if (jobRes.status === 403) {
    throw new Error('Sora 2 사용 불가: OpenAI 조직 인증이 필요합니다. 조직 인증 완료 후 재시도하세요.');
  }

  if (!jobRes.ok) {
    const snippet = await readErrorSnippet(jobRes);
    throw new Error(`Sora 2 job HTTP ${jobRes.status}: ${snippet}`);
  }

  let jobData;
  try { jobData = await jobRes.json(); }
  catch (e) { throw new Error(`Sora 2 job 응답 파싱 실패: ${e.message}`); }

  const jobId = jobData?.id;
  if (!jobId) throw new Error('Sora 2 job 응답에 id가 없습니다.');
  console.log('[sora-video-client] job 생성:', jobId);

  // 2) 폴링 (exponential backoff — 10s → 15s → 20s 최대)
  const deadline = Date.now() + VIDEO_TOTAL_TIMEOUT_MS;
  let pollInterval = VIDEO_POLL_INTERVAL_MS;
  let completed = false;

  while (Date.now() < deadline) {
    await sleep(pollInterval);
    pollInterval = Math.min(pollInterval + 5_000, 30_000);  // 최대 30초

    const pollCtrl = new AbortController();
    const pollTid = setTimeout(() => pollCtrl.abort(), 20_000);
    let pollRes;
    try {
      pollRes = await fetch(`${OPENAI_BASE}/videos/${encodeURIComponent(jobId)}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: pollCtrl.signal,
      });
    } catch (e) {
      clearTimeout(pollTid);
      console.warn('[sora-video-client] 폴링 네트워크 오류(재시도):', e.message);
      continue;
    }
    clearTimeout(pollTid);

    if (!pollRes.ok) {
      const snippet = await readErrorSnippet(pollRes);
      if (pollRes.status >= 500) {
        console.warn('[sora-video-client] 폴링 일시 오류(재시도):', pollRes.status, snippet);
        continue;
      }
      throw new Error(`Sora 2 폴링 HTTP ${pollRes.status}: ${snippet}`);
    }

    let pollData;
    try { pollData = await pollRes.json(); }
    catch (e) {
      console.warn('[sora-video-client] 폴링 JSON 파싱 실패(재시도):', e.message);
      continue;
    }

    const status = pollData?.status;
    console.log('[sora-video-client] 폴링 상태:', status);

    if (status === 'completed') {
      completed = true;
      break;
    }
    if (status === 'failed') {
      throw new Error(`Sora 2 job 실패(failed): ${pollData?.error || '알 수 없는 오류'}`);
    }
    // queued | in_progress → 계속 폴링
  }

  if (!completed) {
    throw new Error(`Sora 2 영상 생성 타임아웃 (${VIDEO_TOTAL_TIMEOUT_MS / 60000}분). DB에 failed 상태로 기록됩니다.`);
  }

  // 3) 다운로드 (URL 1시간 유효 — 즉시 처리)
  const dlCtrl = new AbortController();
  const dlTid = setTimeout(() => dlCtrl.abort(), DOWNLOAD_TIMEOUT_MS);
  let dlRes;
  try {
    dlRes = await fetch(`${OPENAI_BASE}/videos/${encodeURIComponent(jobId)}/content?variant=video`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: dlCtrl.signal,
    });
  } catch (e) {
    clearTimeout(dlTid);
    throw new Error(`Sora 2 영상 다운로드 실패: ${e.message || 'network error'}`);
  }
  clearTimeout(dlTid);

  if (!dlRes.ok) {
    const snippet = await readErrorSnippet(dlRes);
    throw new Error(`Sora 2 영상 다운로드 HTTP ${dlRes.status}: ${snippet}`);
  }

  const mimeType = dlRes.headers.get('content-type') || 'video/mp4';
  const buffer = Buffer.from(await dlRes.arrayBuffer());
  console.log('[sora-video-client] 영상 다운로드 완료. 크기:', buffer.length, 'bytes');
  return { buffer, mimeType };
}

module.exports = { generateVideo };
