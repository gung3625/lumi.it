// tiktok-post-video.js — TikTok 비디오 직접 게시 (Content Posting API, PULL_FROM_URL)
//
// 공식 문서: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
// 엔드포인트: POST https://open.tiktokapis.com/v2/post/publish/video/init/
// 필요 스코프: video.publish
//
// 입력 (JSON body):
//   seller_id       — Supabase user.id
//   video_url       — 게시할 영상 URL (PULL_FROM_URL 방식, MP4/H.264, max 300초)
//   caption         — 캡션 (title, max 2200 UTF-16 runes)
//   privacy_level   — PUBLIC_TO_EVERYONE | MUTUAL_FOLLOW_FRIENDS | FOLLOWER_OF_CREATOR | SELF_ONLY
//   disable_comment — (boolean, optional, default false)
//   disable_duet    — (boolean, optional, default false)
//   disable_stitch  — (boolean, optional, default false)
//
// 출력: { success, publish_id }
//
// 토큰 조회: tiktok_accounts_decrypted 뷰 (service_role 전용, Vault 복호화)

const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');
const { safeAwait } = require('./_shared/supa-safe');

const TIKTOK_VIDEO_ENDPOINT = 'https://open.tiktokapis.com/v2/post/publish/video/init/';

const ALLOWED_ORIGINS = ['https://lumi.it.kr', 'https://www.lumi.it.kr'];

function corsHeaders(event) {
  const origin = (event.headers || {}).origin || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
    'Content-Type': 'application/json',
  };
}

const VALID_PRIVACY = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];

// TikTok access_token 조회 — tiktok_accounts_decrypted 뷰 (Vault 복호화 뷰, service_role 전용)
async function getTikTokToken(supabase, sellerId) {
  const { data, error } = await supabase
    .from('tiktok_accounts_decrypted')
    .select('open_id, access_token')
    .eq('seller_id', sellerId)
    .maybeSingle();
  if (error) throw new Error(`TikTok 토큰 조회 실패: ${error.message}`);
  if (!data || !data.access_token) throw new Error('TikTok 연동 정보가 없습니다. 설정 페이지에서 TikTok을 연동해 주세요.');
  return data;
}

exports.handler = async (event) => {
  // OPTIONS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(event), body: '' };
  }

  // JWT 인증 — Bearer 토큰 검증
  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    return {
      statusCode: 401,
      headers: corsHeaders(event),
      body: JSON.stringify({ error: '인증이 필요합니다.' }),
    };
  }

  const supabase = getAdminClient();

  try {
    // 입력 파싱
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (_) {
      return {
        statusCode: 400,
        headers: corsHeaders(event),
        body: JSON.stringify({ error: 'request body JSON 파싱 실패' }),
      };
    }

    const {
      seller_id,
      video_url,
      caption,
      privacy_level: requestedPrivacy = 'SELF_ONLY',
      disable_comment = false,
      disable_duet = false,
      disable_stitch = false,
    } = body;

    const privacy_level = VALID_PRIVACY.includes(requestedPrivacy) ? requestedPrivacy : 'SELF_ONLY';

    // 필수 필드 검증
    if (!seller_id) {
      return { statusCode: 400, headers: corsHeaders(event), body: JSON.stringify({ error: 'seller_id 필수' }) };
    }
    // 본인 계정만 게시 가능 (JWT user.id === seller_id)
    if (user.id !== seller_id) {
      return { statusCode: 403, headers: corsHeaders(event), body: JSON.stringify({ error: '타인 계정에 게시할 수 없습니다.' }) };
    }
    if (!video_url || typeof video_url !== 'string') {
      return { statusCode: 400, headers: corsHeaders(event), body: JSON.stringify({ error: 'video_url 필수' }) };
    }

    // TikTok 토큰 조회 (Vault 복호화 뷰)
    const { access_token } = await getTikTokToken(supabase, seller_id);

    // TikTok Content Posting API 요청 본문 (PULL_FROM_URL 방식)
    // 참조: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
    const requestBody = {
      post_info: {
        title: String(caption || '').slice(0, 2200), // max 2200 UTF-16 runes
        privacy_level,
        disable_comment: Boolean(disable_comment),
        disable_duet: Boolean(disable_duet),
        disable_stitch: Boolean(disable_stitch),
      },
      source_info: {
        source: 'PULL_FROM_URL',
        video_url,
      },
    };

    // TikTok API 호출 (60초 타임아웃)
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 60_000);
    let apiRes;
    try {
      apiRes = await fetch(TIKTOK_VIDEO_ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify(requestBody),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(tid);
    }

    const apiData = await apiRes.json();

    // TikTok API 오류 처리
    if (!apiRes.ok || (apiData.error && apiData.error.code && apiData.error.code !== 'ok')) {
      const errCode = apiData.error?.code || `HTTP_${apiRes.status}`;
      const errMsg = apiData.error?.message || '알 수 없는 TikTok API 오류';
      console.error(`[tiktok-post-video] API 오류: ${errCode} — ${errMsg}`);

      // 토큰 만료 감지 → tiktok_accounts 상태 초기화
      if (errCode === 'access_token_invalid' || errCode === 'scope_not_authorized' || apiRes.status === 401) {
        const { error: updErr } = await safeAwait(
          supabase
            .from('tiktok_accounts')
            .update({ token_status: 'expired', updated_at: new Date().toISOString() })
            .eq('seller_id', seller_id)
        );
        if (updErr) console.error('[tiktok-post-video] 토큰 만료 상태 기록 실패:', updErr.message);
      }

      return {
        statusCode: apiRes.status === 429 ? 429 : 502,
        headers: corsHeaders(event),
        body: JSON.stringify({ error: errMsg, code: errCode, log_id: apiData.error?.log_id }),
      };
    }

    const publishId = apiData.data?.publish_id;
    console.log(`[tiktok-post-video] 게시 완료: seller_id=${seller_id} publish_id=${publishId}`);

    return {
      statusCode: 200,
      headers: corsHeaders(event),
      body: JSON.stringify({ success: true, publish_id: publishId }),
    };

  } catch (err) {
    console.error('[tiktok-post-video] 서버 오류:', err);
    return {
      statusCode: 500,
      headers: corsHeaders(event),
      body: JSON.stringify({ error: '서버 오류가 발생했습니다.' }),
    };
  }
};
