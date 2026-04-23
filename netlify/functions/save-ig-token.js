// 내부 서버-서버 호출용: Instagram 토큰 저장
// - LUMI_SECRET 인증(timingSafeEqual) 유지
// - Supabase Vault RPC(set_ig_access_token / set_ig_page_access_token)로 암호화 저장
// - ig_accounts 테이블 upsert (secret_id uuid만 보관, 평문 토큰 저장 금지)
const crypto = require('crypto');
const { corsHeaders, getOrigin } = require('./_shared/auth');
const { getAdminClient } = require('./_shared/supabase-admin');


function checkSecret(provided) {
  const secret = process.env.LUMI_SECRET;
  if (!secret) return false;
  try { return crypto.timingSafeEqual(Buffer.from(provided || ''), Buffer.from(secret)); }
  catch { return false; }
}

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const secret = event.headers['x-lumi-secret'];
  if (!checkSecret(secret)) {
    return { statusCode: 401, headers: headers, body: JSON.stringify({ error: '인증 실패' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'Bad Request' }) };
  }

  const { igUserId, accessToken, pageAccessToken, igUsername, pageId, email, tokenExpiresAt } = body;

  if (!igUserId || !accessToken) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'igUserId, accessToken 필수' }) };
  }

  try {
    const supabase = getAdminClient();

    // 1) user_id 해석 (email 우선, 없으면 기존 ig_accounts 행에서 재사용)
    let userId = null;
    if (email) {
      const { data: userRow } = await supabase
        .from('users')
        .select('id')
        .eq('email', email)
        .maybeSingle();
      if (userRow) userId = userRow.id;
    }

    const { data: existingRow } = await supabase
      .from('ig_accounts')
      .select('user_id, access_token_secret_id, page_access_token_secret_id')
      .eq('ig_user_id', igUserId)
      .maybeSingle();

    if (!userId && existingRow && existingRow.user_id) {
      userId = existingRow.user_id;
    }

    if (!userId) {
      return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'user_id 해석 실패 (email 또는 기존 연동 필요)' }) };
    }

    // 2) ig_accounts 기본 row upsert
    const nowIso = new Date().toISOString();
    const upsertPayload = {
      ig_user_id: igUserId,
      user_id: userId,
      connected_at: existingRow?.connected_at || nowIso,
      updated_at: nowIso,
    };
    if (igUsername) upsertPayload.ig_username = igUsername;
    if (pageId) upsertPayload.page_id = pageId;
    if (tokenExpiresAt) upsertPayload.token_expires_at = tokenExpiresAt;

    const { error: upsertErr } = await supabase
      .from('ig_accounts')
      .upsert(upsertPayload, { onConflict: 'ig_user_id' });
    if (upsertErr) {
      console.error('[save-ig-token] ig_accounts upsert 실패:', upsertErr.message);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '저장 실패' }) };
    }

    // 3) Vault RPC — access_token (필수)
    const { data: accessSecretId, error: accessErr } = await supabase.rpc('set_ig_access_token', {
      p_ig_user_id: igUserId,
      p_existing_secret: existingRow?.access_token_secret_id ?? null,
      p_access_token: accessToken,
    });
    if (accessErr) {
      console.error('[save-ig-token] set_ig_access_token 실패:', accessErr.message);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '토큰 암호화 실패' }) };
    }

    // 4) Vault RPC — page_access_token (옵션)
    let pageSecretId = null;
    if (pageAccessToken) {
      const { data: pid, error: pageErr } = await supabase.rpc('set_ig_page_access_token', {
        p_ig_user_id: igUserId,
        p_existing_secret: existingRow?.page_access_token_secret_id ?? null,
        p_page_token: pageAccessToken,
      });
      if (pageErr) {
        console.error('[save-ig-token] set_ig_page_access_token 실패:', pageErr.message);
      } else {
        pageSecretId = pid;
      }
    }

    // 5) secret_id 반영
    const secretUpdate = {
      access_token_secret_id: accessSecretId,
      updated_at: new Date().toISOString(),
    };
    if (pageSecretId) secretUpdate.page_access_token_secret_id = pageSecretId;

    const { error: idUpdateErr } = await supabase
      .from('ig_accounts')
      .update(secretUpdate)
      .eq('ig_user_id', igUserId);
    if (idUpdateErr) {
      console.error('[save-ig-token] secret_id 업데이트 실패:', idUpdateErr.message);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '토큰 저장 실패' }) };
    }

    console.log('[lumi] Instagram 토큰 저장 완료:', igUserId);
    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ success: true, igUserId })
    };
  } catch (e) {
    console.error('[save-ig-token] 오류:', e.message);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: '저장 실패' })
    };
  }
};
