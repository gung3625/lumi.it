const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };

  const authHeader = event.headers['authorization'] || '';
  const secret = authHeader.replace('Bearer ', '').trim();
  if (secret !== process.env.LUMI_SECRET) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'forbidden' }) };
  }

  const result = {
    now: new Date().toISOString(),
    env: {
      NETLIFY_SITE_ID_present: !!process.env.NETLIFY_SITE_ID,
      NETLIFY_SITE_ID_value: process.env.NETLIFY_SITE_ID || null,
      NETLIFY_TOKEN_present: !!process.env.NETLIFY_TOKEN,
      NETLIFY_TOKEN_length: (process.env.NETLIFY_TOKEN || '').length,
      NETLIFY_TOKEN_prefix: (process.env.NETLIFY_TOKEN || '').slice(0, 4),
      NETLIFY_BLOBS_CONTEXT_present: !!process.env.NETLIFY_BLOBS_CONTEXT,
      NETLIFY_BLOBS_CONTEXT_length: (process.env.NETLIFY_BLOBS_CONTEXT || '').length,
      AWS_REGION: process.env.AWS_REGION || null,
      DEPLOY_ID: process.env.DEPLOY_ID || null,
    },
    sdkVersion: null,
    tests: {},
  };

  try {
    result.sdkVersion = require('@netlify/blobs/package.json').version;
  } catch (e) { result.sdkVersion = 'unknown: ' + e.message; }

  // Test 1: auto context (no siteID/token)
  try {
    const s = getStore({ name: 'users', consistency: 'strong' });
    const probe = await s.get('__diag_nonexistent__');
    result.tests.autoContext = { ok: true, probe: probe === null ? 'null(normal)' : 'gotValue' };
  } catch (e) {
    result.tests.autoContext = { ok: false, err: e.message, name: e.name };
  }

  // Test 2: manual siteID+token (current path)
  try {
    const s = getStore({
      name: 'users',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
      token: process.env.NETLIFY_TOKEN,
    });
    const probe = await s.get('__diag_nonexistent__');
    result.tests.manualSiteToken = { ok: true, probe: probe === null ? 'null(normal)' : 'gotValue' };
  } catch (e) {
    result.tests.manualSiteToken = { ok: false, err: e.message, name: e.name };
  }

  // Test 3: manual siteID only (no token) — see if auto-token injection happens
  try {
    const s = getStore({
      name: 'users',
      consistency: 'strong',
      siteID: process.env.NETLIFY_SITE_ID || '28d60e0e-6aa4-4b45-b117-0bcc3c4268fc',
    });
    const probe = await s.get('__diag_nonexistent__');
    result.tests.siteIDOnly = { ok: true, probe: probe === null ? 'null(normal)' : 'gotValue' };
  } catch (e) {
    result.tests.siteIDOnly = { ok: false, err: e.message, name: e.name };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify(result, null, 2) };
};
