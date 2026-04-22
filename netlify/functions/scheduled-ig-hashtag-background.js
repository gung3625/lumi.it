// scheduled-ig-hashtag-background.js — 주간 IG 해시태그 트렌드 수집 (rate limit 회피용 캐시)
// IG Graph API ig_hashtag_search + top_media 호출을 "주 1회" 배치로 몰아서 실행.
// scheduled-trends-background.js의 fetchInstagram은 여기서 쓴 캐시만 읽음.
// 스케줄: 매주 월요일 KST 00:00 (= 일요일 UTC 15:00)

const { getAdminClient } = require('./_shared/supabase-admin');
const https = require('https');

// 업종별 seed hashtag
const IG_SEED_TAGS = {
  cafe: 'cafetrend',
  food: 'foodtrend',
  beauty: 'beautytrend',
  flower: 'flowertrend',
  fashion: 'fashiontrend',
  fitness: 'fitnesskorea',
  pet: 'pettrend',
  interior: 'interiortrend',
  education: 'edutrend',
  studio: 'photostudio',
  nail: 'nailartkorea',
  hair: 'hairtrendkorea',
};

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
  const isScheduled = !event || !event.httpMethod;
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

  // 1) 브랜드 IG 토큰 조회 (admin-promo-publish.js:129-139 패턴)
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

  // 2) 12업종 순차 수집 (병렬 금지 — rate limit 보호)
  const updatedAt = new Date().toISOString();
  const results = {};
  for (const [category, tag] of Object.entries(IG_SEED_TAGS)) {
    try {
      const captions = await fetchIgHashtag({ businessId, accessToken, tag });
      results[category] = captions;
      console.log(`[ig-hashtag] ${category} (${tag}): ${captions.length}건`);
      // Supabase 캐시 저장
      await supa.from('trends').upsert(
        {
          category: `ig-hashtag-cache:${category}`,
          keywords: { captions, tag, updatedAt },
          collected_at: updatedAt,
        },
        { onConflict: 'category' }
      );
      // rate limit 여유 (호출 간 1초)
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`[ig-hashtag] ${category} 실패:`, e.message);
      results[category] = [];
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({
      success: true,
      updatedAt,
      counts: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.length])),
    }),
  };
};

module.exports.config = {
  schedule: '0 15 * * 0', // 매주 월요일 KST 00:00 (= 일요일 UTC 15:00)
};
