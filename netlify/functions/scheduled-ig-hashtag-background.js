// scheduled-ig-hashtag-background.js — 매일 IG 해시태그 트렌드 수집 (3일 업종 로테이션)
// IG Graph API rate limit 회피: 하루 3업종 × 3태그 = 9개/일, 고유 27개/주 (한도 30개 이내)
// 이 캐시는 scheduled-trends-v2-background.js 가 fetchInstagram 단계에서 읽음.
// 스케줄: 매일 UTC 18:00 = KST 03:00

const { getAdminClient } = require('./_shared/supabase-admin');
const https = require('https');

// 9업종 × 3개 해시태그 (고유 27개, 주 30개 한도 이내)
// 사장님 결정 (2026-05-15): pet 업종 폐기. 8업종으로 4일 rotation (2업종 × 4일).
const IG_HASHTAGS = {
  cafe:    ['카페추천', '디저트', '카페스타그램'],
  food:    ['맛집', '오마카세', '맛스타그램'],
  beauty:  ['뷰티', '화장품', '피부관리'],
  hair:    ['헤어스타일', '미용실', '펌'],
  nail:    ['네일아트', '젤네일', '네일샵'],
  flower:  ['꽃집', '드라이플라워', '플라워샵'],
  fashion: ['패션', '코디', 'Y2K'],
  fitness: ['필라테스', '바디프로필', '헬스타그램'],
};

// 4일 주기 로테이션 그룹 (8업종 → 매일 2업종)
const ROTATION_GROUPS = [
  ['cafe', 'food'],       // rotation 0
  ['beauty', 'hair'],     // rotation 1
  ['nail', 'flower'],     // rotation 2
  ['fashion', 'fitness'], // rotation 3
];

// 오늘의 3업종 반환 (연중 일수 % 3)
function getTodayCategories() {
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now - startOfYear) / (24 * 60 * 60 * 1000));
  const rotation = dayOfYear % ROTATION_GROUPS.length;
  return ROTATION_GROUPS[rotation];
}

// trends 테이블 캐시로 7일 신선도 판단
async function isCategoryStale(supa, category) {
  const { data } = await supa
    .from('trends')
    .select('collected_at')
    .eq('category', `ig-hashtag-cache:${category}`)
    .maybeSingle();
  if (!data) return true;
  const lastFetched = new Date(data.collected_at).getTime();
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return lastFetched < sevenDaysAgo;
}

function httpsGetRaw(urlOrOptions, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlOrOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
  });
}

async function fetchIgHashtag({ businessId, accessToken, tag }) {
  try {
    // Step 1: ig_hashtag_search로 tag_id 조회
    const searchPath = `/v19.0/ig_hashtag_search?user_id=${encodeURIComponent(businessId)}` +
      `&q=${encodeURIComponent(tag)}&access_token=${encodeURIComponent(accessToken)}`;
    const idRes = await httpsGetRaw({
      hostname: 'graph.facebook.com',
      path: searchPath,
      method: 'GET',
    }, 8000);
    if (idRes.status !== 200) {
      console.error(`[ig-hashtag] hashtag_search 실패 status=${idRes.status} tag=${tag}`);
      return [];
    }
    const idData = JSON.parse(idRes.body);
    const tagId = idData?.data?.[0]?.id;
    if (!tagId) {
      console.error(`[ig-hashtag] tag_id 없음 tag=${tag}`);
      return [];
    }

    // Step 2: top_media 캡션 조회
    const mediaPath = `/v19.0/${tagId}/top_media?user_id=${encodeURIComponent(businessId)}` +
      `&fields=caption&limit=25&access_token=${encodeURIComponent(accessToken)}`;
    const mRes = await httpsGetRaw({
      hostname: 'graph.facebook.com',
      path: mediaPath,
      method: 'GET',
    }, 8000);
    if (mRes.status !== 200) {
      console.error(`[ig-hashtag] top_media 실패 status=${mRes.status} tag=${tag}`);
      return [];
    }
    const mData = JSON.parse(mRes.body);
    return (mData?.data || [])
      .map(x => (x.caption || '').slice(0, 200))
      .filter(Boolean);
  } catch (e) {
    console.error(`[ig-hashtag] fetchIgHashtag 오류 tag=${tag}:`, e.message);
    return [];
  }
}

exports.handler = async (event) => {
  const bodyObj = (() => { try { return JSON.parse(event?.body || '{}'); } catch(_) { return {}; } })();
  const isScheduled = !event || !event.httpMethod || !!bodyObj.next_run;
  // 수동 트리거도 허용: x-lumi-secret 헤더 체크
  if (!isScheduled) {
    const secret = (event.headers && (event.headers['x-lumi-secret'] || event.headers['X-Lumi-Secret'])) || '';
    if (!process.env.LUMI_SECRET || secret !== process.env.LUMI_SECRET) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: '인증 실패' }),
      };
    }
  }

  const supa = getAdminClient();

  // 1) 브랜드 IG 토큰 조회
  const { data: igRow, error: igErr } = await supa
    .from('ig_accounts_decrypted')
    .select('ig_user_id, access_token, page_access_token')
    .eq('user_id', process.env.LUMI_BRAND_USER_ID)
    .maybeSingle();
  if (igErr || !igRow || !igRow.ig_user_id || !igRow.access_token) {
    console.error('[ig-hashtag] 브랜드 IG 토큰 조회 실패');
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'IG 토큰 없음' }),
    };
  }
  const businessId = igRow.ig_user_id;
  const accessToken = igRow.page_access_token || igRow.access_token;

  // 2) 오늘 로테이션 업종 선택
  const todayCats = getTodayCategories();
  console.log(`[ig-rotation] today's cats: [${todayCats.join(', ')}]`);

  // 3) 업종별 수집 (7일 신선도 체크 후 skip 또는 fetch)
  const updatedAt = new Date().toISOString();
  const results = {};
  const skipped = [];

  for (const cat of todayCats) {
    const stale = await isCategoryStale(supa, cat);
    if (!stale) {
      console.log(`[ig-rotation] ${cat}: 7일 이내 갱신됨, skip`);
      skipped.push(cat);
      continue;
    }

    const tags = IG_HASHTAGS[cat] || [];
    const allCaptions = [];

    for (const tag of tags) {
      try {
        const captions = await fetchIgHashtag({ businessId, accessToken, tag });
        allCaptions.push(...captions);
        console.log(`[ig-hashtag] ${cat}/${tag}: ${captions.length}건`);
        // rate limit 여유 (호출 간 1초)
        await new Promise(r => setTimeout(r, 1000));
      } catch (e) {
        console.error(`[ig-hashtag] ${cat}/${tag} 실패:`, e.message);
      }
    }

    results[cat] = allCaptions;

    // Supabase 캐시 저장 (기존 키 형식 유지 — scheduled-trends-v2 읽기 쪽 호환)
    await supa.from('trends').upsert(
      {
        category: `ig-hashtag-cache:${cat}`,
        keywords: { captions: allCaptions, tags, updatedAt },
        collected_at: updatedAt,
      },
      { onConflict: 'category' }
    );
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({
      success: true,
      updatedAt,
      rotation: todayCats,
      skipped,
      counts: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.length])),
    }),
  };
};

module.exports.config = {
  schedule: '0 18 * * *', // 매일 KST 03:00 (= UTC 18:00)
};
