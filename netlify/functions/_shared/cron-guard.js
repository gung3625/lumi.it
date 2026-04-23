// _shared/cron-guard.js — 재사용 가능한 cron 방어 헬퍼
// 사용법:
//   const { runGuarded } = require('./_shared/cron-guard');
//   exports.handler = runGuarded({
//     name: 'scheduled-trends',          // cron 이름 (heartbeat key 접미사)
//     handler: async (event, context) => { ... },  // 실제 핸들러 로직
//   });
//
// runGuarded 가 자동으로:
//   1. 진입 시 cron-heartbeat:{name} row upsert (startedAt, version, nodeVersion)
//   2. 핸들러 전체를 outer try/catch 로 감쌈
//   3. 완료 시 성공/실패 기록 (completedAt + success 또는 cron-last-error:{name})
//   4. 200/500 응답

const { getAdminClient } = require('./supabase-admin');

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

/**
 * @param {{ name: string, handler: function }} options
 * @returns {function} Netlify handler
 */
function runGuarded({ name, handler }) {
  if (!name) throw new Error('cron-guard: name is required');
  if (typeof handler !== 'function') throw new Error('cron-guard: handler must be a function');

  return async function guardedHandler(event, context) {
    const startedAt = new Date().toISOString();
    const heartbeatKey = `cron-heartbeat:${name}`;
    const errorKey = `cron-last-error:${name}`;

    let supa;
    try {
      supa = getAdminClient();
    } catch (initErr) {
      console.error(`[cron-guard:${name}] Supabase 초기화 실패:`, initErr.message);
      return {
        statusCode: 500,
        headers: HEADERS,
        body: JSON.stringify({ error: 'Supabase 초기화 실패', name }),
      };
    }

    // 1. Sentinel heartbeat — 진입 즉시 기록 (실패해도 계속 진행)
    try {
      await supa.from('trends').upsert(
        {
          category: heartbeatKey,
          keywords: {
            startedAt,
            version: '2',
            nodeVersion: process.version,
            completedAt: null,
            success: null,
          },
          collected_at: startedAt,
        },
        { onConflict: 'category' }
      );
    } catch (hbErr) {
      console.error(`[cron-guard:${name}] heartbeat 쓰기 실패 (계속 진행):`, hbErr.message);
    }

    // 2. 전역 try/catch — 핸들러 실행
    let result;
    try {
      result = await handler(event, context);
    } catch (handlerErr) {
      console.error(`[cron-guard:${name}] 핸들러 크래시:`, handlerErr.message, handlerErr.stack);

      // 실패 기록
      const errorAt = new Date().toISOString();
      try {
        await supa.from('trends').upsert(
          {
            category: errorKey,
            keywords: {
              errorAt,
              message: handlerErr.message || String(handlerErr),
              stack: (handlerErr.stack || '').slice(0, 2000),
              name,
            },
            collected_at: errorAt,
          },
          { onConflict: 'category' }
        );
      } catch (errWriteErr) {
        console.error(`[cron-guard:${name}] 에러 기록 실패:`, errWriteErr.message);
      }

      // heartbeat 실패 상태 업데이트
      try {
        await supa.from('trends').upsert(
          {
            category: heartbeatKey,
            keywords: {
              startedAt,
              completedAt: errorAt,
              success: false,
              version: '2',
              nodeVersion: process.version,
            },
            collected_at: errorAt,
          },
          { onConflict: 'category' }
        );
      } catch (_) { /* 무시 */ }

      return {
        statusCode: 500,
        headers: HEADERS,
        body: JSON.stringify({ error: handlerErr.message, name }),
      };
    }

    // 3. 성공 — heartbeat completedAt 업데이트
    const completedAt = new Date().toISOString();
    try {
      await supa.from('trends').upsert(
        {
          category: heartbeatKey,
          keywords: {
            startedAt,
            completedAt,
            success: true,
            version: '2',
            nodeVersion: process.version,
          },
          collected_at: completedAt,
        },
        { onConflict: 'category' }
      );
    } catch (hbEndErr) {
      console.error(`[cron-guard:${name}] 완료 heartbeat 쓰기 실패:`, hbEndErr.message);
    }

    return result || {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ success: true, name, completedAt }),
    };
  };
}

module.exports = { runGuarded };
