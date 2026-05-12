// kst-utils.js — KST (Korea Standard Time, UTC+9) 변환 헬퍼
//
// Node 환경엔 timezone 라이브러리 없이 단순 offset 산술. 0.5초 단위까지 정확.
// 사용처: scheduled-followers-snapshot / scheduled-post-insights / get-best-time /
//        brand-stats / daily-content / process-and-post 등 19곳 흩어져 있던 중복을 통합.
//
// 주의: 반환되는 Date 객체는 "KST 시각이 UTC 처럼 출력되는" 가짜 UTC. 그래서
// getUTCHours()·getUTCDay()·getUTCFullYear() 로 KST 시간/요일/날짜 추출.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// UTC Date 또는 ISO 문자열 → KST 시각이 들어있는 가짜 UTC Date
function utcToKstDate(utcInput) {
  const d = utcInput instanceof Date ? utcInput : new Date(utcInput);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getTime() + KST_OFFSET_MS);
}

// KST 기준 'YYYY-MM-DD' 문자열
function kstDateString(utcInput = Date.now()) {
  const kst = utcToKstDate(utcInput);
  if (!kst) return null;
  return kst.toISOString().slice(0, 10);
}

// KST hour + day_of_week (0=일 ~ 6=토) 추출
function kstHourDow(utcInput) {
  const kst = utcToKstDate(utcInput);
  if (!kst) return null;
  return {
    hour: kst.getUTCHours(),
    dow: kst.getUTCDay(),
    minute: kst.getUTCMinutes(),
  };
}

// UTC hour (0~23 정수) → KST hour (0~23 정수). Meta online_followers 같은
// 시간 축 응답을 KST 로 변환할 때 사용. 인라인 `(utcHour + 9) % 24` 패턴 통합.
function utcHourToKstHour(utcHour) {
  if (!Number.isFinite(utcHour)) return null;
  return ((Math.trunc(utcHour) + 9) % 24 + 24) % 24;
}

module.exports = {
  KST_OFFSET_MS,
  utcToKstDate,
  kstDateString,
  kstHourDow,
  utcHourToKstHour,
};
