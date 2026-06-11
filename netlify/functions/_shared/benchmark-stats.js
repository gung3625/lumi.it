// benchmark-stats.js — 벤치마크 통계 계산 (순수 함수, 외부 의존 없음)
// 입력: 정규화된 게시물 배열 + 팔로워수 → 비교 가능한 지표 객체
// 내 계정(IG Graph)·상대 계정(Apify) 양쪽 모두 같은 normalized 형태로 통과시킨다:
//   { takenAt: ISO문자열|null, mediaType: 'Image'|'Video'|'Sidecar'|null,
//     caption: string, hashtags: string[], likes: number|null,
//     comments: number|null, views: number|null, url: string|null }

const DAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

function kstParts(iso) {
  if (!iso) return null;
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return { hour: d.getUTCHours(), day: d.getUTCDay() };
}

/**
 * @param {Array} posts  normalized 게시물 (최신순 권장)
 * @param {number|null} followers
 * @returns {object} stats
 */
function computeStats(posts, followers) {
  const valid = (posts || []).filter((p) => p && p.takenAt);
  const n = valid.length;
  if (n === 0) {
    return { n: 0, followers: followers ?? null };
  }

  const times = valid.map((p) => new Date(p.takenAt).getTime()).sort((a, b) => a - b);
  const spanDays = Math.max(1, (times[times.length - 1] - times[0]) / 86400000);
  const perWeek = +(n / (spanDays / 7)).toFixed(1);

  let reel = 0, image = 0, carousel = 0;
  const hourCount = {}, dayCount = {}, tagCount = {};
  let likeSum = 0, likeN = 0, comSum = 0, comN = 0, capLenSum = 0;
  let viewSum = 0, viewN = 0;

  for (const p of valid) {
    if (p.mediaType === 'Video') reel += 1;
    else if (p.mediaType === 'Sidecar') carousel += 1;
    else image += 1;

    const kp = kstParts(p.takenAt);
    if (kp) {
      hourCount[kp.hour] = (hourCount[kp.hour] || 0) + 1;
      dayCount[kp.day] = (dayCount[kp.day] || 0) + 1;
    }
    for (const t of p.hashtags || []) {
      const tag = String(t).trim();
      if (tag) tagCount[tag] = (tagCount[tag] || 0) + 1;
    }
    if (typeof p.likes === 'number' && p.likes >= 0) { likeSum += p.likes; likeN += 1; }
    if (typeof p.comments === 'number' && p.comments >= 0) { comSum += p.comments; comN += 1; }
    if (typeof p.views === 'number' && p.views > 0) { viewSum += p.views; viewN += 1; }
    capLenSum += (p.caption || '').length;
  }

  const avgLikes = likeN ? Math.round(likeSum / likeN) : null;
  const avgComments = comN ? Math.round(comSum / comN) : null;
  const engagementRate = (followers && avgLikes !== null)
    ? +(((avgLikes + (avgComments || 0)) / followers) * 100).toFixed(2)
    : null;

  const topOf = (obj, k) => Object.entries(obj)
    .sort((a, b) => b[1] - a[1]).slice(0, k)
    .map(([key, count]) => ({ key, count }));

  const topPosts = valid
    .slice()
    .sort((a, b) => ((b.likes || 0) + (b.comments || 0)) - ((a.likes || 0) + (a.comments || 0)))
    .slice(0, 3)
    .map((p) => ({
      url: p.url || null,
      takenAt: p.takenAt,
      mediaType: p.mediaType,
      likes: p.likes ?? null,
      comments: p.comments ?? null,
      views: p.views ?? null,
      capHead: (p.caption || '').replace(/\s+/g, ' ').slice(0, 60),
    }));

  return {
    n,
    followers: followers ?? null,
    sinceDays: Math.round(spanDays),
    perWeek,
    formatMix: {
      reel: Math.round((reel / n) * 100),
      image: Math.round((image / n) * 100),
      carousel: Math.round((carousel / n) * 100),
    },
    avgLikes,
    avgComments,
    engagementRate,
    reelAvgViews: viewN ? Math.round(viewSum / viewN) : null,
    topHours: topOf(hourCount, 3).map(({ key, count }) => ({ hour: +key, count })),
    topDays: topOf(dayCount, 3).map(({ key, count }) => ({ day: DAY_LABELS[+key], count })),
    topHashtags: topOf(tagCount, 10).map(({ key, count }) => ({ tag: key, count })),
    capLenAvg: Math.round(capLenSum / n),
    topPosts,
  };
}

module.exports = { computeStats, DAY_LABELS };
