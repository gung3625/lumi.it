// netlify/functions/scheduled-followers-snapshot-background.js
// Meta `online_followers` 메트릭의 7일치 응답을 follower_activity_snapshots
// 에 누적 저장하는 cron. 28일 이상 누적되면 요일×시간 매트릭스 신뢰성 확보.
//
// 의도:
//   현 get-best-time.js 의 Tier 1a 는 7일치를 시간 축으로 합산해 peak 1점만
//   산출 — 정보 손실. 누적된 매트릭스를 쓰면 요일×시간 차원 그대로 분석 가능
//   하고, 사용자가 매번 Graph 호출하지 않아도 됨.
//
// 처리 정책:
//   - 활성 사장님(onboarded=true, IG 연동)만 대상
//   - 메트릭은 IG 측에서 7일치를 항상 줌. 같은 날짜 row 가 다시 와도 PK
//     (user_id, snapshot_date, hour) 충돌 → upsert 로 follower_count 갱신.
//   - 팔로워 100명 미만은 Meta 가 빈 응답 → row 0건 insert. cron 비용 최소.
//
// 스케줄: 매일 04:00 KST = UTC 19:00 (netlify.toml)
//         post-insights cron(03:30) 직후라 IG 토큰 키체인이 hot. 일관성 ↑

const { getAdminClient } = require('./_shared/supabase-admin');
const { getIgTokenForSeller } = require('./_shared/ig-graph');

const META_GRAPH = 'https://graph.facebook.com/v25.0';
const FETCH_TIMEOUT_MS = 10000;
const SELLER_BATCH = 200;   // 한 cron 실행에서 처리할 사장님 최대

async function fetchOnlineFollowers(igUserId, accessToken) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${META_GRAPH}/${igUserId}/insights?metric=online_followers&period=lifetime&access_token=${accessToken}`;
    const res = await fetch(url, { signal: ctrl.signal });
    const data = await res.json();
    if (data.error) {
      console.warn('[followers-snapshot] Graph 오류:', { code: data.error.code, msg: data.error.message });
      return null;
    }
    if (!data.data || !data.data[0]?.values) return null;
    return data.data[0].values;   // 7일치 row 배열
  } catch (e) {
    console.warn('[followers-snapshot] fetch 예외:', e && e.message);
    return null;
  } finally {
    clearTimeout(tid);
  }
}

// Meta 응답 1 row 의 value (UTC hour → count 맵) 를 KST 기준 (snapshot_date, hour, dow) 으로 변환.
// end_time 은 그 row 의 24시간 윈도우 끝(=다음 날 00:00 UTC 추정). 안전하게 그날 자정으로 잡기 위해
// end_time 의 KST 일자에서 1일 빼는 게 정확. Meta 가 같은 date 를 여러 번 줄 가능성 적지만 upsert PK 가
// 충돌 해소.
function expandValueToRows(userId, valueRow) {
  if (!valueRow || !valueRow.value || !valueRow.end_time) return [];
  const endUtc = new Date(valueRow.end_time);
  if (isNaN(endUtc.getTime())) return [];
  // end_time 의 KST 기준 일자 = 그 row 가 대표하는 "어제" (KST 자정 기준 종료)
  const endKst = new Date(endUtc.getTime() + 9 * 3600 * 1000);
  // 자정 종료 → 그 전 24시간이 대상 일자. KST 시각이 00:00 이면 전날.
  let baseKst = new Date(endKst.getTime() - 1);
  baseKst.setUTCHours(0, 0, 0, 0);
  const yyyy = baseKst.getUTCFullYear();
  const mm = String(baseKst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(baseKst.getUTCDate()).padStart(2, '0');
  const snapshotDate = `${yyyy}-${mm}-${dd}`;
  const dayOfWeek = baseKst.getUTCDay();   // 0=일 ~ 6=토

  const rows = [];
  for (const [hourStr, count] of Object.entries(valueRow.value)) {
    const utcHour = Number(hourStr);
    if (Number.isNaN(utcHour) || utcHour < 0 || utcHour > 23) continue;
    const kstHour = (utcHour + 9) % 24;
    // KST 변환으로 인해 한 row 의 24시간이 2개 날짜에 걸침 — 단순화:
    // utcHour < 15 면 baseKst 일자, ≥15 면 baseKst-1 (전날) — 이건 정확히 보면
    // 24시간이 모두 같은 KST 일자에 속하는 게 아니라 일부는 다음 KST 일자에 속함.
    // 데이터 의미상 큰 영향 없지만 정확도를 위해 분리:
    let date = snapshotDate;
    let dow = dayOfWeek;
    if (utcHour >= 15) {
      // UTC 15시 = KST 00시 → 이전 KST 일자에서 이 hour 는 다음 KST 일자.
      // 즉 baseKst+1 일자에 속함. 다만 baseKst 가 이미 어제이므로 baseKst+1 = 오늘 KST.
      const next = new Date(baseKst.getTime() + 24 * 3600 * 1000);
      const ny = next.getUTCFullYear();
      const nm = String(next.getUTCMonth() + 1).padStart(2, '0');
      const nd = String(next.getUTCDate()).padStart(2, '0');
      date = `${ny}-${nm}-${nd}`;
      dow = next.getUTCDay();
    }
    rows.push({
      user_id: userId,
      snapshot_date: date,
      hour: kstHour,
      day_of_week: dow,
      follower_count: Number(count) || 0,
    });
  }
  return rows;
}

exports.handler = async () => {
  const supabase = getAdminClient();

  // 활성 사장님 + IG 연동된 분만 후보
  const { data: sellers, error: sellersErr } = await supabase
    .from('sellers')
    .select('id')
    .eq('onboarded', true)
    .limit(SELLER_BATCH);
  if (sellersErr) {
    console.error('[followers-snapshot] sellers 조회 실패:', sellersErr.message);
    return { statusCode: 500, body: JSON.stringify({ error: sellersErr.message }) };
  }
  if (!sellers || sellers.length === 0) {
    console.log('[followers-snapshot] 활성 사장님 없음');
    return { statusCode: 200, body: JSON.stringify({ ok: true, sellers: 0 }) };
  }

  let processed = 0;
  let inserted = 0;
  let noFollowers = 0;
  let noToken = 0;

  for (const s of sellers) {
    const ig = await getIgTokenForSeller(s.id, supabase);
    if (!ig) { noToken++; continue; }

    const values = await fetchOnlineFollowers(ig.igUserId, ig.accessToken);
    if (!values || values.length === 0) {
      // Meta 가 빈 응답 — 팔로워 100명 미만 또는 메트릭 미지원
      noFollowers++;
      continue;
    }

    const rows = [];
    for (const v of values) {
      rows.push(...expandValueToRows(s.id, v));
    }
    if (rows.length === 0) { noFollowers++; continue; }

    // 같은 (user_id, snapshot_date, hour) 가 여러 row 에서 중복 가능 — 마지막 값으로 dedupe
    const dedupe = new Map();
    for (const r of rows) dedupe.set(`${r.snapshot_date}|${r.hour}`, r);
    const finalRows = Array.from(dedupe.values());

    const { error: upsertErr } = await supabase
      .from('follower_activity_snapshots')
      .upsert(finalRows, { onConflict: 'user_id,snapshot_date,hour' });
    if (upsertErr) {
      console.warn('[followers-snapshot] upsert 실패:', s.id, upsertErr.message);
    } else {
      inserted += finalRows.length;
      processed++;
    }
  }

  console.log(`[followers-snapshot] sellers=${sellers.length} processed=${processed} rows=${inserted} no_followers=${noFollowers} no_token=${noToken}`);
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, sellers: sellers.length, processed, rows: inserted, no_followers: noFollowers, no_token: noToken }),
  };
};
