// cron-watchdog-background.js — cron heartbeat 감시 + stale 시 이메일 알림
//
// 배경: 2026-05-01 ~ 2026-05-08 동안 scheduled-trends-v2 가 .catch 안티패턴으로
// 매일 자정 실행하자마자 죽었다. cron-health 엔드포인트는 있었지만 자동 감시가
// 없어 9일 동안 발견되지 않았다. 본 함수가 같은 잠수를 두 번 다시 일어나지 않게 한다.
//
// 스케줄: 매시간 (netlify.toml: 0 * * * *)
// 동작:
//   1. cron-guard 가 기록하는 trends 테이블의 heartbeat 행 조회
//      (scheduled-trends, scheduled-trends-longtail, scheduled-trends-embeddings)
//   2. 각 cron 별 임계치(=주기 + 안전마진) 와 비교
//   3. minutesSinceLastRun 초과 OR lastSuccess === false 인 경우 ALERT
//   4. + 발행 flow stuck reservation 감지 (Blocker B, 2026-05-19):
//      - caption_status='pending' 가 10분 이상 → process-and-post 시작 실패
//      - caption_status='generating' 가 15분 이상 → process-and-post 중간 죽음
//      - caption_status='posting' 가 10분 이상 → select-and-post 중간 죽음
//      - caption_status='scheduled' 인데 scheduled_at 지난지 10분+ 이고 ig_post_id null
//        → select-and-post 가 아예 트리거 안 됨
//   5. ALERT → LUMI_ADMIN_EMAILS 로 Resend 메일 발송
//   6. 같은 항목 ALERT 가 6시간 안에 이미 발송되었으면 중복 발송 안 함 (cooldown)
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
const { heartbeatKey } = require('./_shared/cron-keys');

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

// ── 발행 flow stuck 감지 정의 (Blocker B, 2026-05-19) ─────
// 임계치 = 정상 실행 시간 + 안전마진. 초과하면 silent fail 가능성 높음.
// 정상 실행 시간:
//   process-and-post: ~30s (caption gen + storage + IG container 등)
//   select-and-post:  ~20s (selected caption 확정 + IG publish)
const STUCK_TARGETS = [
  // 2026-05-20 fix: 모든 stuck check 에 deleted_at/cancelled/is_sent 필터 추가.
  {
    key: 'pending',
    label: 'pending (process-and-post 시작 안됨)',
    thresholdMin: 10,
    filter: q => q.eq('caption_status', 'pending').is('deleted_at', null).eq('cancelled', false).eq('is_sent', false),
    timeColumn: 'created_at',
  },
  {
    key: 'generating',
    label: 'generating (process-and-post 중간 죽음)',
    thresholdMin: 15,
    filter: q => q.eq('caption_status', 'generating').is('deleted_at', null).eq('cancelled', false).eq('is_sent', false),
    timeColumn: 'created_at',
  },
  {
    key: 'posting',
    label: 'posting (select-and-post 중간 죽음)',
    thresholdMin: 10,
    filter: q => q.eq('caption_status', 'posting').is('deleted_at', null).eq('cancelled', false).eq('is_sent', false),
    timeColumn: 'updated_at',
  },
  {
    // 2026-05-20 fix: deleted_at IS NULL + cancelled=false + is_sent=false 필터 추가.
    // 사장님이 취소/삭제한 reservation 도 stuck 으로 잡혀서 false alert 가능.
    key: 'scheduled-overdue',
    label: 'scheduled overdue (select-and-post 트리거 안됨)',
    thresholdMin: 10,
    filter: q => q
      .eq('caption_status', 'scheduled')
      .is('ig_post_id', null)
      .is('deleted_at', null)
      .eq('cancelled', false)
      .eq('is_sent', false),
    timeColumn: 'scheduled_at',
  },
];

async function loadHeartbeat(supa, name) {
  const { data, error } = await safeAwait(
    supa.from('trends').select('keywords').eq('category', heartbeatKey(name)).maybeSingle()
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

// ── stuck reservation 감지 ──────────────────────────────
// 각 STUCK_TARGETS 항목별로 카운트 + sample 3건 조회.
// 반환: [{ kind, label, thresholdMin, count, sample[] }, ...]  alert 대상만
async function checkStuckReservations(supa, now) {
  const out = [];
  const perTargetTrace = [];  // 진단용 — 각 STUCK_TARGETS 결과
  console.log(`[cron-watchdog] stuck check start (targets=${STUCK_TARGETS.length})`);
  for (const t of STUCK_TARGETS) {
    const cutoff = new Date(now - t.thresholdMin * 60000).toISOString();
    let q = supa
      .from('reservations')
      .select('reserve_key, user_id, scheduled_at, created_at, updated_at, caption_status, ig_post_id')
      .lt(t.timeColumn, cutoff)
      .order(t.timeColumn, { ascending: true })
      .limit(20);
    q = t.filter(q);
    const { data, error } = await safeAwait(q);
    perTargetTrace.push({
      key: t.key,
      cutoff,
      timeColumn: t.timeColumn,
      count: data?.length || 0,
      errorMsg: error?.message || null,
      sampleKeys: (data || []).slice(0, 3).map(r => r.reserve_key),
    });
    if (error) {
      console.error(`[cron-watchdog] stuck check ${t.key} 실패:`, error.message);
      continue;
    }
    console.log(`[cron-watchdog] stuck check ${t.key}: ${data?.length || 0}건 (cutoff=${cutoff})`);
    if (data && data.length > 0) {
      out.push({
        kind: `stuck-${t.key}`,
        label: t.label,
        thresholdMin: t.thresholdMin,
        count: data.length,
        sample: data.slice(0, 3).map(r => ({
          reserve_key: r.reserve_key,
          user_id: r.user_id,
          status: r.caption_status,
          time: r[t.timeColumn],
        })),
      });
    }
  }
  // 진단용 trace 도 함께 반환
  out._trace = perTargetTrace;
  return out;
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

  // ── stuck reservation 검사 (cron heartbeat 와 같은 cooldown 메커니즘) ──
  await ctx.stage('loading-stuck-reservations');
  const stuckList = await checkStuckReservations(supa, now);
  // 진단 (2026-05-20): stuck check 결과를 trends 테이블에 기록 — Netlify logs 가
  // background function stdout 안 잡아서 직접 dump.
  try {
    await safeAwait(supa.from('trends').upsert({
      category: 'watchdog-diagnostic:stuck-check',
      keywords: {
        ts: new Date().toISOString(),
        stuckListLen: stuckList.length,
        stuckList: stuckList.map(s => ({ kind: s.kind, count: s.count, threshold: s.thresholdMin })),
        perTargetTrace: stuckList._trace || [],
      },
      collected_at: new Date().toISOString(),
    }, { onConflict: 'category' }));
  } catch (e) { console.warn('diag write 실패:', e.message); }
  const stuckIssues = [];
  for (const stuck of stuckList) {
    const stateKey = `stuck:${stuck.kind}`;
    const state = await loadAlertState(supa, stateKey);
    if (state && state.lastAlertAt) {
      const ageH = (now - new Date(state.lastAlertAt).getTime()) / 3600000;
      if (ageH < COOLDOWN_HOURS) {
        console.log(`[cron-watchdog] ${stuck.kind}: alert 억제 (cooldown ${ageH.toFixed(1)}h < ${COOLDOWN_HOURS}h, count=${stuck.count})`);
        continue;
      }
    }
    stuckIssues.push(stuck);
  }

  if (issues.length === 0 && stuckIssues.length === 0) {
    console.log('[cron-watchdog] 모든 cron + 발행 flow 정상 (또는 cooldown 중)');
    return { statusCode: 200, body: JSON.stringify({ checked: WATCH_TARGETS.length, stuckChecked: STUCK_TARGETS.length, alerts: 0 }) };
  }

  await ctx.stage('alerting', { cronCount: issues.length, stuckCount: stuckIssues.length });

  // 메일 1통에 묶어 발송 (cron + stuck reservation 모두)
  const lines = [];
  for (const { target, verdict } of issues) {
    lines.push(`[cron] ${target.name} (${target.periodLabel})\n  → ${verdict.reason}`);
  }
  for (const stuck of stuckIssues) {
    const samples = stuck.sample.map(s => `    - ${s.reserve_key} (user=${s.user_id.slice(0, 8)}…, ${stuck.kind.replace('stuck-', '')} since ${s.time})`).join('\n');
    lines.push(`[발행 stuck] ${stuck.label}\n  → ${stuck.count}건이 ${stuck.thresholdMin}분 이상 stuck. sample (최대 3):\n${samples}`);
  }
  const subjectParts = [];
  if (issues.length > 0) subjectParts.push(`cron stale ${issues.length}건`);
  if (stuckIssues.length > 0) subjectParts.push(`발행 stuck ${stuckIssues.reduce((s, x) => s + x.count, 0)}건`);
  const subject = `[루미] ${subjectParts.join(' + ')}`;

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
  const nowIso = new Date().toISOString();
  for (const { target, verdict } of issues) {
    await saveAlertState(supa, target.name, {
      lastAlertAt: nowIso,
      reason: verdict.reason,
      minutesSinceLastRun: verdict.minutesSinceLastRun ?? null,
    });
  }
  for (const stuck of stuckIssues) {
    await saveAlertState(supa, `stuck:${stuck.kind}`, {
      lastAlertAt: nowIso,
      count: stuck.count,
      thresholdMin: stuck.thresholdMin,
    });
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      checked: WATCH_TARGETS.length,
      stuckChecked: STUCK_TARGETS.length,
      alerts: issues.length + stuckIssues.length,
      cronNames: issues.map(i => i.target.name),
      stuckKinds: stuckIssues.map(s => s.kind),
    }),
  };
}

exports.handler = runGuarded({ name: 'cron-watchdog', handler: watchdogHandler });
