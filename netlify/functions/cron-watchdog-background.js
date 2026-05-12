// cron-watchdog-background.js — cron heartbeat 감시 + stale 시 이메일 알림
//
// 배경: 2026-05-01 ~ 2026-05-08 동안 scheduled-trends-v2 가 .catch 안티패턴으로
// 매일 자정 실행하자마자 죽었다. cron-health 엔드포인트는 있었지만 자동 감시가
// 없어 9일 동안 발견되지 않았다. 본 함수가 같은 잠수를 두 번 다시 일어나지 않게 한다.
//
// 스케줄: 매시간 (netlify.toml: 0 * * * *)
// 동작:
//   1. cron-guard 가 기록하는 trends 테이블의 heartbeat 행 4건 조회
//      (scheduled-trends, scheduled-trends-longtail,
//       scheduled-trends-embeddings)
//   2. 각 cron 별 임계치(=주기 + 안전마진) 와 비교
//   3. minutesSinceLastRun 초과 OR lastSuccess === false 인 경우 ALERT
//   4. ALERT → LUMI_ADMIN_EMAILS 로 Resend 메일 발송
//   5. 같은 cron 의 ALERT 가 6시간 안에 이미 발송되었으면 중복 발송 안 함 (cooldown)
//      cooldown 상태는 trends 테이블의 watchdog-alert-state:{name} 행에 저장
//
// 환경변수:
//   RESEND_API_KEY        — Resend (필수)
//   LUMI_ADMIN_EMAILS     — 알림 받을 관리자 이메일 (쉼표 구분, 필수)

'use strict';

const { Resend } = require('resend');
const { runGuarded } = require('./_shared/cron-guard');
const { getAdminClient } = require('./_shared/supabase-admin');
const { safeAwait } = require('./_shared/supa-safe');

// ── 감시 대상 cron 정의 ─────────────────────────────────
// thresholdMin = cron 주기 + 안전마진. 이 시간을 넘기면 ALERT.
// scheduled-trends 는 매일 cron 이라 24h + 1.5h grace = 25.5h = 1530분
// 주간 cron 은 7일 + 12h grace = 7.5일 = 10800분
const WATCH_TARGETS = [
  { name: 'scheduled-trends',            thresholdMin:  1530, periodLabel: '매일 KST 00:00' },
  { name: 'scheduled-trends-longtail',   thresholdMin: 10800, periodLabel: '매주 월 KST 04:00' },
  { name: 'scheduled-trends-embeddings', thresholdMin: 10800, periodLabel: '매주 화 KST 03:00' },
];

const COOLDOWN_HOURS = 6;

async function loadHeartbeat(supa, name) {
  const { data, error } = await safeAwait(
    supa.from('trends').select('keywords').eq('category', `cron-heartbeat:${name}`).maybeSingle()
  );
  if (error || !data) return null;
  return data.keywords || null;
}

async function loadAlertState(supa, name) {
  const { data, error } = await safeAwait(
    supa.from('trends').select('keywords').eq('category', `watchdog-alert-state:${name}`).maybeSingle()
  );
  if (error || !data) return null;
  return data.keywords || null;
}

async function saveAlertState(supa, name, payload) {
  const nowIso = new Date().toISOString();
  await safeAwait(
    supa.from('trends').upsert(
      { category: `watchdog-alert-state:${name}`, keywords: payload, collected_at: nowIso },
      { onConflict: 'category' }
    )
  );
}

function evaluateTarget(target, hb, now) {
  if (!hb) {
    return { alert: true, reason: `heartbeat 행 자체가 없음 (한 번도 실행되지 않았거나 trends 테이블 row 가 삭제됨)` };
  }
  const startedAt = hb.startedAt ? new Date(hb.startedAt).getTime() : null;
  if (!startedAt) {
    return { alert: true, reason: 'heartbeat startedAt 없음' };
  }
  const minutesSinceLastRun = Math.floor((now - startedAt) / 60000);
  if (minutesSinceLastRun > target.thresholdMin) {
    return {
      alert: true,
      reason: `${minutesSinceLastRun}분째 실행 안 됨 (임계치 ${target.thresholdMin}분 초과). lastStartedAt=${hb.startedAt}`,
      minutesSinceLastRun,
    };
  }
  if (hb.success === false) {
    return {
      alert: true,
      reason: `최근 실행 실패 (lastSuccess=false). lastCompletedAt=${hb.completedAt || 'null'}`,
      minutesSinceLastRun,
    };
  }
  return { alert: false, minutesSinceLastRun };
}

async function sendAlertEmail(resend, to, subject, lines) {
  const html = `
<html><body style="font-family: -apple-system, sans-serif; line-height: 1.6; color: #222;">
  <h2 style="color:#c0392b;">루미 cron 감시 경보</h2>
  <pre style="background:#f6f8fa; padding:12px; border-radius:6px; white-space:pre-wrap;">${lines.join('\n')}</pre>
  <p style="color:#888; font-size:12px;">자동 발송 — cron-watchdog-background. 6시간 cooldown 적용. 라이브 상태: <a href="https://lumi.it.kr/api/cron-health">/api/cron-health</a></p>
</body></html>`;
  const result = await resend.emails.send({
    from: 'lumi <noreply@lumi.it.kr>',
    to,
    subject,
    html,
  });
  return result;
}

async function watchdogHandler(event, ctx) {
  const apiKey = process.env.RESEND_API_KEY;
  const adminEmailsRaw = process.env.LUMI_ADMIN_EMAILS || '';
  const adminEmails = adminEmailsRaw.split(',').map(s => s.trim()).filter(Boolean);

  const supa = getAdminClient();
  const now = Date.now();
  const issues = [];

  await ctx.stage('loading-heartbeats');

  for (const target of WATCH_TARGETS) {
    const hb = await loadHeartbeat(supa, target.name);
    const verdict = evaluateTarget(target, hb, now);
    if (!verdict.alert) continue;

    // cooldown 검사
    const state = await loadAlertState(supa, target.name);
    if (state && state.lastAlertAt) {
      const ageH = (now - new Date(state.lastAlertAt).getTime()) / 3600000;
      if (ageH < COOLDOWN_HOURS) {
        console.log(`[cron-watchdog] ${target.name}: alert 억제 (cooldown ${ageH.toFixed(1)}h < ${COOLDOWN_HOURS}h)`);
        continue;
      }
    }

    issues.push({ target, verdict });
  }

  if (issues.length === 0) {
    console.log('[cron-watchdog] 모든 cron 정상 (또는 cooldown 중)');
    return { statusCode: 200, body: JSON.stringify({ checked: WATCH_TARGETS.length, alerts: 0 }) };
  }

  await ctx.stage('alerting', { count: issues.length });

  // 메일 1통에 묶어 발송
  const lines = issues.map(({ target, verdict }) =>
    `[${target.name}] ${target.periodLabel}\n  → ${verdict.reason}`
  );
  const subject = `[루미] cron stale ${issues.length}건 — ${issues.map(i => i.target.name).join(', ')}`;

  // 발송 — 환경변수 부재 시 콘솔로만
  if (!apiKey || adminEmails.length === 0) {
    console.error(
      '[cron-watchdog] RESEND_API_KEY 또는 LUMI_ADMIN_EMAILS 미설정 — 이메일 발송 스킵.\n',
      `subject=${subject}\n`,
      lines.join('\n')
    );
  } else {
    const resend = new Resend(apiKey);
    try {
      await sendAlertEmail(resend, adminEmails, subject, lines);
      console.log(`[cron-watchdog] alert 메일 발송 완료 → ${adminEmails.join(', ')}`);
    } catch (e) {
      console.error('[cron-watchdog] alert 메일 발송 실패:', e.message);
    }
  }

  // cooldown 기록 (발송 성공/실패 무관 — 실패 시 재시도하면 매시간 메일 폭탄)
  for (const { target, verdict } of issues) {
    await saveAlertState(supa, target.name, {
      lastAlertAt: new Date().toISOString(),
      reason: verdict.reason,
      minutesSinceLastRun: verdict.minutesSinceLastRun ?? null,
    });
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      checked: WATCH_TARGETS.length,
      alerts: issues.length,
      names: issues.map(i => i.target.name),
    }),
  };
}

exports.handler = runGuarded({ name: 'cron-watchdog', handler: watchdogHandler });
