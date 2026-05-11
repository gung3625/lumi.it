// Scheduled Background Function — reservations row 가 없는 storage orphan 파일 제거.
// 매일 04:00 KST (= 19:00 UTC) 실행 (netlify.toml: "0 19 * * *").
//
// 왜 필요?
//  cleanup-stale-background.js 는 reservations row 를 기준으로 storage 를 지움.
//  반대로, row 가 없는데 storage 만 남아있는 경우 (예: reserve.js 가 업로드는 성공했는데
//  insert 가 실패했을 때 롤백이 한 번 더 실패한 케이스, 옛 마이그레이션·테스트 SQL 직삭제,
//  account-delete cascade 누락 시점 등) 는 영원히 누적됨. PIPA 보유기간 관점에서도 제거 필요.
//
// 안전장치:
//  - `brand-library/` prefix 보호 (브랜드 자체 자산 — DB row 와 무관)
//  - reserve_key 의 timestamp(`reserve:{ms}`) 가 24h 이내면 스킵 (in-flight upload 보호)
//  - reserve_key 형식이 인식 안 되는 폴더는 스킵 (모르는 건 안 건드림)
//  - 최대 사용자 100명 × 폴더 100개 / 회 — 한도 도달 시 다음 실행에서 마저 처리
//  - DB 조회는 단일 IN 쿼리 (N+1 방지)

const { getAdminClient } = require('./_shared/supabase-admin');

const BUCKET = 'lumi-images';
const PROTECTED_PREFIXES = new Set(['brand-library']);
const RESERVE_KEY_RE = /^reserve:(\d+)$/;
const SAFE_AGE_MS = 24 * 60 * 60 * 1000; // 24h 미만 폴더는 in-flight 가능 → 스킵
const MAX_USERS_PER_RUN = 100;
const MAX_RESERVE_KEYS_PER_USER = 100;
const LIST_PAGE = 1000;
const DELETE_BATCH = 100;

async function listFolder(supabase, prefix) {
  const all = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(prefix, { limit: LIST_PAGE, offset });
    if (error) throw new Error(`list(${prefix || '/'}) 실패: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < LIST_PAGE) break;
    offset += LIST_PAGE;
  }
  return all;
}

// 폴더 entry 판별 — Supabase 의 list() 는 file 은 id 가 있고 folder 는 id 가 null.
function isFolder(entry) {
  return entry && entry.id == null;
}

async function collectOrphanCandidates(supabase) {
  // 1) 루트에서 user_id 폴더 수집
  const root = await listFolder(supabase, '');
  const userFolders = root
    .filter(isFolder)
    .map(e => e.name)
    .filter(name => !PROTECTED_PREFIXES.has(name))
    .slice(0, MAX_USERS_PER_RUN);

  const candidates = []; // { userId, reserveKey, prefix }
  const cutoffMs = Date.now() - SAFE_AGE_MS;

  for (const userId of userFolders) {
    let userEntries;
    try {
      userEntries = await listFolder(supabase, userId);
    } catch (e) {
      console.warn(`[cleanup-orphan] ${userId} list 실패:`, e.message);
      continue;
    }
    const reserveKeys = userEntries
      .filter(isFolder)
      .map(e => e.name)
      .slice(0, MAX_RESERVE_KEYS_PER_USER);

    for (const name of reserveKeys) {
      const m = RESERVE_KEY_RE.exec(name);
      if (!m) continue; // 모르는 형식 → 안전을 위해 스킵
      const ms = Number(m[1]);
      if (!Number.isFinite(ms) || ms > cutoffMs) continue; // 너무 최근 → in-flight 가능
      candidates.push({ userId, reserveKey: name, prefix: `${userId}/${name}/` });
    }
  }
  return candidates;
}

async function findExistingReserveKeys(supabase, reserveKeys) {
  if (!reserveKeys.length) return new Set();
  // chunk — IN 절 너무 길면 URL 한도 / SQL parser 부담
  const CHUNK = 200;
  const found = new Set();
  for (let i = 0; i < reserveKeys.length; i += CHUNK) {
    const slice = reserveKeys.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('reservations')
      .select('reserve_key')
      .in('reserve_key', slice);
    if (error) {
      // 에러 시 보수적으로 전부 "존재함" 처리 → 이번 회는 아무것도 안 지움
      console.error('[cleanup-orphan] reservations 조회 실패:', error.message);
      return new Set(reserveKeys);
    }
    for (const row of data || []) found.add(row.reserve_key);
  }
  return found;
}

async function deleteOrphanFiles(supabase, prefix) {
  // 폴더 안 파일 전체 나열 후 일괄 삭제
  const entries = await listFolder(supabase, prefix.replace(/\/$/, ''));
  const paths = entries
    .filter(e => !isFolder(e))
    .map(e => prefix + e.name);
  if (!paths.length) return 0;

  let deleted = 0;
  for (let i = 0; i < paths.length; i += DELETE_BATCH) {
    const slice = paths.slice(i, i + DELETE_BATCH);
    const { data, error } = await supabase.storage.from(BUCKET).remove(slice);
    if (error) {
      console.warn(`[cleanup-orphan] remove(${prefix}) 실패:`, error.message);
      continue;
    }
    deleted += (data || []).length;
  }
  return deleted;
}

exports.handler = async () => {
  try {
    const supabase = getAdminClient();
    const candidates = await collectOrphanCandidates(supabase);
    if (!candidates.length) {
      console.log('[cleanup-orphan] 후보 없음');
      return { statusCode: 200, body: JSON.stringify({ success: true, scanned: 0, orphans: 0, filesDeleted: 0 }) };
    }

    const existing = await findExistingReserveKeys(supabase, candidates.map(c => c.reserveKey));
    const orphans = candidates.filter(c => !existing.has(c.reserveKey));

    let filesDeleted = 0;
    for (const o of orphans) {
      const n = await deleteOrphanFiles(supabase, o.prefix);
      filesDeleted += n;
      if (n) console.log(`[cleanup-orphan] ${o.userId}/${o.reserveKey} → ${n}개 삭제`);
    }

    console.log(`[cleanup-orphan] scanned=${candidates.length} orphans=${orphans.length} filesDeleted=${filesDeleted}`);
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        scanned: candidates.length,
        orphans: orphans.length,
        filesDeleted,
      }),
    };
  } catch (err) {
    console.error('[cleanup-orphan] 실행 실패:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
