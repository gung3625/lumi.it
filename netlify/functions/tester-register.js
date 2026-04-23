const { corsHeaders, getOrigin } = require('./_shared/auth');
// 베타 테스터 등록 — GET: 상태 조회 / POST: 핸들 등록
const { getAdminClient } = require('./_shared/supabase-admin');
const { verifyBearerToken, extractBearerToken } = require('./_shared/supabase-auth');


// 핸들 유효성: 1~30자, 영문/숫자/._ 만 허용
function isValidHandle(handle) {
  return /^[a-zA-Z0-9._]{1,30}$/.test(handle);
}

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers, body: '' };

  const token = extractBearerToken(event);
  const { user, error: authErr } = await verifyBearerToken(token);
  if (authErr || !user) {
    return { statusCode: 401, headers: headers, body: JSON.stringify({ error: '인증이 필요합니다.' }) };
  }

  const admin = getAdminClient();

  // GET: 상태 조회
  if (event.httpMethod === 'GET') {
    try {
      const { data, error } = await admin
        .from('users')
        .select('tester_ig_handle, tester_invite_status')
        .eq('id', user.id)
        .single();

      if (error) {
        console.error('[tester-register] GET error:', error.message);
        return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '조회 실패' }) };
      }

      let status = 'none';
      if (data && data.tester_ig_handle) {
        status = (data.tester_invite_status === 'invited') ? 'invited' : 'pending';
      }

      const resp = { status };
      if (data && data.tester_ig_handle) resp.ig_handle = data.tester_ig_handle;
      return { statusCode: 200, headers: headers, body: JSON.stringify(resp) };
    } catch (err) {
      console.error('[tester-register] GET unexpected:', err && err.message);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '서버 오류' }) };
    }
  }

  // POST: 핸들 등록
  if (event.httpMethod === 'POST') {
    try {
      let body = {};
      try { body = JSON.parse(event.body || '{}'); } catch (e) {}

      const rawHandle = (body.ig_handle || '').replace(/^@/, '').trim();
      if (!rawHandle || !isValidHandle(rawHandle)) {
        return { statusCode: 400, headers: headers, body: JSON.stringify({ error: '유효하지 않은 핸들이에요. 영문, 숫자, ., _ 만 사용 가능해요.' }) };
      }

      const { error } = await admin
        .from('users')
        .update({
          tester_ig_handle: rawHandle,
          tester_invite_status: 'pending',
          tester_submitted_at: new Date().toISOString(),
        })
        .eq('id', user.id);

      if (error) {
        console.error('[tester-register] POST update error:', error.message);
        return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '등록 실패' }) };
      }

      console.log('[tester-register] 테스터 등록 완료');
      return { statusCode: 200, headers: headers, body: JSON.stringify({ success: true, status: 'pending' }) };
    } catch (err) {
      console.error('[tester-register] POST unexpected:', err && err.message);
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: '서버 오류' }) };
    }
  }

  return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
