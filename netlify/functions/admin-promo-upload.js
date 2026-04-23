const { corsHeaders, getOrigin } = require('./_shared/auth');
// 관리자 전용 홍보 이미지 업로드 — base64 이미지 1장을 Supabase Storage(link-assets) 에 저장 후 공개 URL 반환.
// 인증: Authorization: Bearer ${LUMI_SECRET}. 로그·응답에 토큰/사용자 식별자 노출 금지.
const { getAdminClient } = require('./_shared/supabase-admin');


function sanitizeFilename(name) {
  // 영숫자, 하이픈, 점만 허용 — 그 외 문자는 '-' 로 치환
  return String(name).replace(/[^A-Za-z0-9.\-]/g, '-');
}

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST 전용 엔드포인트입니다.' }) };
  }

  const authHeader = (event.headers.authorization || event.headers.Authorization || '').replace('Bearer ', '');
  if (!process.env.LUMI_SECRET || authHeader !== process.env.LUMI_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 실패' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { filename, base64, contentType } = body;

    if (!filename || typeof filename !== 'string') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'filename이 필요합니다.' }) };
    }
    if (!contentType || typeof contentType !== 'string') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'contentType이 필요합니다.' }) };
    }
    if (!base64 || typeof base64 !== 'string' || base64.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'base64 본문이 비어있습니다.' }) };
    }

    // data: prefix 가 붙어 있으면 제거 — 안전장치
    const cleanBase64 = base64.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');
    if (!buffer.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'base64 디코딩 실패' }) };
    }

    const safeName = sanitizeFilename(filename);
    const path = `promo/${Date.now()}-${safeName}`;

    const supabase = getAdminClient();

    const { error: upErr } = await supabase
      .storage
      .from('link-assets')
      .upload(path, buffer, { contentType, upsert: false });

    if (upErr) {
      console.error('[admin-promo-upload] 업로드 실패:', upErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: '이미지 업로드에 실패했습니다.' }) };
    }

    const { data: pub } = supabase
      .storage
      .from('link-assets')
      .getPublicUrl(path);

    const url = pub && pub.publicUrl;
    if (!url) {
      console.error('[admin-promo-upload] 공개 URL 생성 실패');
      return { statusCode: 500, headers, body: JSON.stringify({ error: '공개 URL 생성 실패' }) };
    }

    console.log('[admin-promo-upload] 업로드 완료:', path);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, url, path }) };
  } catch (err) {
    console.error('[admin-promo-upload] 예외:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류가 발생했습니다.' }) };
  }
};

exports.headers = headers;
