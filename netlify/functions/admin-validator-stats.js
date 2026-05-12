// admin-validator-stats.js — 캡션 v2 Validator 운영 통계
// GET /api/admin-validator-stats?days=30
//
// 응답:
// {
//   ok: true,
//   range: { days, since, until },
//   counts: { total, pass, fail, regenerated },
//   passRate: 0.0~1.0,
//   regenRate: 0.0~1.0,
//   axisAverages: { photo_match, tone_appropriate, tone_match, cliche_free, brand_safe, length_ok },
//   axisFailureBreakdown: { tone_match: 12, cliche_free: 3, ... }   // 각 축 점수<4 발생 횟수
//   topIssues: [{ text, count }, ...]                                 // validator issues 상위 빈도
// }
//
// 인증: Bearer 토큰 + sellers.is_admin=true 또는 LUMI_ADMIN_EMAILS 환경변수 통과.
// 데이터 소스: caption_history WHERE caption_type='generated' AND validator_scores IS NOT NULL.

const { corsHeaders, getOrigin } = require('./_shared/auth');
const { getAdminClient } = require('./_shared/supabase-admin');
const { requireAdmin } = require('./_shared/admin-guard');

const AXIS_KEYS = ['photo_match', 'tone_appropriate', 'tone_match', 'cliche_free', 'brand_safe', 'length_ok'];
const FAIL_THRESHOLD = 4; // 4 미만이면 failure 카운트

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'GET only' }) };
  }

  const admin = getAdminClient();
  const auth = await requireAdmin(event, admin);
  if (!auth.ok) {
    return { statusCode: auth.status, headers, body: JSON.stringify({ error: auth.error }) };
  }

  // ?days 파라미터 — 기본 30, 최대 365
  const qs = event.queryStringParameters || {};
  let days = parseInt(qs.days || '30', 10);
  if (!Number.isFinite(days) || days < 1) days = 30;
  if (days > 365) days = 365;

  const sinceIso = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const untilIso = new Date().toISOString();

  try {
    // generated row 만 조회. validator_scores 가 있어야 통계 의미.
    const { data: rows, error } = await admin
      .from('caption_history')
      .select('validator_scores, validator_pass, regenerated, created_at')
      .eq('caption_type', 'generated')
      .gte('created_at', sinceIso)
      .not('validator_scores', 'is', null)
      .limit(5000);

    if (error) {
      console.error('[admin-validator-stats] 조회 실패:', error.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }

    const total = (rows || []).length;
    if (total === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: true,
          range: { days, since: sinceIso, until: untilIso },
          counts: { total: 0, pass: 0, fail: 0, regenerated: 0 },
          passRate: null,
          regenRate: null,
          axisAverages: {},
          axisFailureBreakdown: {},
          topIssues: [],
          note: '아직 generated row 없음. 사장님 게시가 누적되면 채워짐.',
        }),
      };
    }

    let passCount = 0;
    let regenCount = 0;
    const axisSum = {};
    const axisN = {};
    const axisFail = {};
    const issueCount = new Map();

    for (const r of rows) {
      if (r.validator_pass === true) passCount++;
      if (r.regenerated === true) regenCount++;

      const meta = r.validator_scores || {};
      // 재생성된 row 는 firstAttempt 의 점수가 "원래" 캡션 점수 — 그게 분포에 더 의미 있음.
      // 단 firstAttempt 없으면 최종 scores 사용.
      const scores = (meta.firstAttempt && meta.firstAttempt.scores) || meta.scores || {};
      for (const k of AXIS_KEYS) {
        const v = scores[k];
        if (typeof v === 'number') {
          axisSum[k] = (axisSum[k] || 0) + v;
          axisN[k] = (axisN[k] || 0) + 1;
          if (v < FAIL_THRESHOLD) axisFail[k] = (axisFail[k] || 0) + 1;
        }
      }
      // issues 빈도
      const issues = Array.isArray(meta.issues) ? meta.issues
        : (meta.firstAttempt && Array.isArray(meta.firstAttempt.issues)) ? meta.firstAttempt.issues
        : [];
      for (const it of issues) {
        const text = String(it || '').trim();
        if (!text) continue;
        issueCount.set(text, (issueCount.get(text) || 0) + 1);
      }
    }

    const axisAverages = {};
    for (const k of AXIS_KEYS) {
      if (axisN[k]) axisAverages[k] = Number((axisSum[k] / axisN[k]).toFixed(2));
    }

    const topIssues = Array.from(issueCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([text, count]) => ({ text, count }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        range: { days, since: sinceIso, until: untilIso },
        counts: { total, pass: passCount, fail: total - passCount, regenerated: regenCount },
        passRate: Number((passCount / total).toFixed(3)),
        regenRate: Number((regenCount / total).toFixed(3)),
        axisAverages,
        axisFailureBreakdown: axisFail,
        topIssues,
      }),
    };
  } catch (e) {
    console.error('[admin-validator-stats] 예외:', e && e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'server_error' }) };
  }
};
