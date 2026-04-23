// admin-apply-trend-migration.js — Trend Hub v2 Phase 0 마이그레이션 실행기
// POST /api/admin-apply-trend-migration
// 인증: x-lumi-secret 헤더 또는 Authorization: Bearer ${LUMI_SECRET}
// SQL은 본 파일에 하드코딩 (임의 SQL 실행 차단)

const { Client } = require('pg');
const { verifyLumiSecret, corsHeaders, getOrigin } = require('./_shared/auth');
const fs = require('fs');
const path = require('path');

exports.handler = async (event) => {
  const headers = corsHeaders(getOrigin(event));
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST 전용' }) };
  }

  // 인증: x-lumi-secret 헤더 또는 Authorization Bearer
  const secretHeader = event.headers['x-lumi-secret'] || event.headers['X-Lumi-Secret'] || '';
  const bearerHeader = (event.headers.authorization || event.headers.Authorization || '').replace('Bearer ', '');
  const provided = secretHeader || bearerHeader;

  if (!verifyLumiSecret(provided)) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 실패' }) };
  }

  try {
    // migrations/002-trend-hub-schema.sql 읽기
    // Netlify Functions에서 실행 시 프로젝트 루트 기준 경로
    const sqlPath = path.join(__dirname, '..', '..', 'migrations', '002-trend-hub-schema.sql');
    let sql;
    try {
      sql = fs.readFileSync(sqlPath, 'utf8');
    } catch (readErr) {
      console.error('[admin-apply-trend-migration] SQL 파일 읽기 실패:', readErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'SQL 파일 읽기 실패' }) };
    }

    // Netlify AWS 런타임은 direct DB 호스트(db.*.supabase.co) IPv6 전용이라 resolve 실패.
    // pooler 리전을 브루트포스로 시도.
    const direct = new URL(process.env.SUPABASE_DB_URL);
    const ref = direct.hostname.replace(/^db\./, '').split('.')[0];
    // 검증된 지역 우선 (이전 성공 로그 = aws-1-ap-northeast-2)
    // password는 URL에서 이미 decoded 상태이지만 pg client가 재파싱하므로 raw 사용
    // (encodeURIComponent 하면 이중 인코딩되어 auth 실패)
    const pwd = direct.password;
    const attempts = [
      ['aws-1-ap-northeast-2', `postgresql://postgres.${ref}:${pwd}@aws-1-ap-northeast-2.pooler.supabase.com:5432${direct.pathname}`],
      // Fallback (프로젝트 이전 등 예외 케이스)
      ['aws-0-ap-northeast-2', `postgresql://postgres.${ref}:${pwd}@aws-0-ap-northeast-2.pooler.supabase.com:5432${direct.pathname}`],
      ['aws-1-ap-northeast-1', `postgresql://postgres.${ref}:${pwd}@aws-1-ap-northeast-1.pooler.supabase.com:5432${direct.pathname}`],
      ['aws-0-us-east-1',      `postgresql://postgres.${ref}:${pwd}@aws-0-us-east-1.pooler.supabase.com:5432${direct.pathname}`],
    ];

    const errors = [];
    let applied = false;
    for (const [label, connStr] of attempts) {
      const client = new Client({
        connectionString: connStr,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 3000,
      });
      try {
        await client.connect();
        await client.query(sql);
        applied = true;
        await client.end();
        console.log(`[admin-apply-trend-migration] connected via ${label}`);
        break;
      } catch (e) {
        errors.push(`${label}: ${e.message}`);
        try { await client.end(); } catch (_) {}
      }
    }

    if (!applied) {
      const dbg = `direct_host=${direct.hostname} ref=${ref}`;
      console.error(`[admin-apply-trend-migration] DB 연결 실패: ${dbg} | ${errors.join(' | ')}`);
      return { statusCode: 500, headers, body: JSON.stringify({ error: '마이그레이션 적용 실패' }) };
    }

    console.log('[admin-apply-trend-migration] 002-trend-hub-schema.sql 적용 완료');
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, file: '002-trend-hub-schema.sql' }),
    };
  } catch (err) {
    console.error('[admin-apply-trend-migration] 예외:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '마이그레이션 적용 실패' }) };
  }
};
