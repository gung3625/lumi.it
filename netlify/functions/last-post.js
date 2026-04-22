// 최근 게시물 1건 조회 — Bearer 토큰 검증.
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

// Supabase Storage URL 여부 판단
function isSupabaseUrl(url) {
  const supabaseUrl = process.env.SUPABASE_URL || '';
  if (supabaseUrl && url.startsWith(supabaseUrl)) return true;
  // 일반적인 Supabase storage 패턴
  return /supabase\.co\/storage\/v1\//.test(url);
}

// image_urls가 Supabase Storage를 가리키거나 비어 있어 갱신이 필요한지 판단
function needsRefresh(row) {
  if (!row || !row.ig_post_id) return false;
  if (!Array.isArray(row.image_urls) || row.image_urls.length === 0) return true;
  return isSupabaseUrl(row.image_urls[0]);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  try {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('reservations')
      .select('*')
      .eq('user_id', user.id)
      .eq('caption_status', 'posted')
      .order('posted_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('[last-post] select error:', error.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '최근 게시물 조회 실패' }) };
    }

    // fallback refresh: Supabase Storage URL이거나 image_urls가 비어 있으면 IG CDN URL로 교체 시도
    if (data && needsRefresh(data)) {
      try {
        const { data: igRow } = await admin
          .from('ig_accounts_decrypted')
          .select('access_token, page_access_token')
          .eq('user_id', user.id)
          .maybeSingle();
        const igAccessToken = (igRow && (igRow.page_access_token || igRow.access_token)) || null;

        if (igAccessToken) {
          const igCtrl = new AbortController();
          const igTid = setTimeout(() => igCtrl.abort(), 5000);
          let igMediaRes;
          try {
            igMediaRes = await fetch(
              `https://graph.facebook.com/v25.0/${data.ig_post_id}?fields=media_type,media_url,thumbnail_url,children{media_url,thumbnail_url}&access_token=${igAccessToken}`,
              { signal: igCtrl.signal }
            );
          } finally {
            clearTimeout(igTid);
          }

          if (igMediaRes.ok) {
            const igMedia = await igMediaRes.json();
            if (!igMedia.error) {
              const mt = igMedia.media_type;
              const cdnUpdate = {};
              if (mt === 'CAROUSEL_ALBUM' && igMedia.children && igMedia.children.data) {
                cdnUpdate.image_urls = igMedia.children.data.map((c) => c.media_url).filter(Boolean);
              } else if (mt === 'IMAGE') {
                if (igMedia.media_url) cdnUpdate.image_urls = [igMedia.media_url];
              } else if (mt === 'VIDEO' || mt === 'REELS') {
                const cdnUrl = igMedia.media_url || igMedia.thumbnail_url;
                if (cdnUrl) cdnUpdate.image_urls = [cdnUrl];
                if (igMedia.media_url) cdnUpdate.video_url = igMedia.media_url;
              }

              if (Object.keys(cdnUpdate).length) {
                await admin
                  .from('reservations')
                  .update(cdnUpdate)
                  .eq('reserve_key', data.reserve_key);
                console.log('[last-post] IG CDN URL 갱신 완료 media_type=' + mt);
                // 갱신된 값으로 응답
                return { statusCode: 200, headers: CORS, body: JSON.stringify({ post: { ...data, ...cdnUpdate } }) };
              }
            } else {
              console.warn('[last-post] IG media API 오류:', igMedia.error.message);
            }
          } else {
            console.warn('[last-post] IG media HTTP 오류:', igMediaRes.status);
          }
        }
      } catch (refreshErr) {
        console.warn('[last-post] CDN URL 갱신 예외(무시):', refreshErr.message);
      }
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ post: data || null }) };
  } catch (err) {
    console.error('[last-post] unexpected:', err && err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '서버 오류' }) };
  }
};
