// cron-* trends row category prefix 통일 — cron-guard / cron-health / cron-watchdog /
// cleanup-stale-background 4개 파일에서 흩어져 사용되던 매직 스트링 단일 source 화.
//
// trends 테이블 row layout:
//   - heartbeat:    category = 'cron-heartbeat:{name}'    (cron 진입/완료 sentinel)
//   - last-error:   category = 'cron-last-error:{name}'   (마지막 실패 stack/message)
//   - stage:        category = 'cron-stage:{name}'        (현재 단계 트래킹)
//
// 추가 prefix 가 필요해지면 여기에 정의하고 import 한 측에서 재사용.

const HEARTBEAT_PREFIX = 'cron-heartbeat:';
const ERROR_PREFIX = 'cron-last-error:';
const STAGE_PREFIX = 'cron-stage:';

const heartbeatKey = (name) => `${HEARTBEAT_PREFIX}${name}`;
const errorKey = (name) => `${ERROR_PREFIX}${name}`;
const stageKey = (name) => `${STAGE_PREFIX}${name}`;

module.exports = {
  HEARTBEAT_PREFIX,
  ERROR_PREFIX,
  STAGE_PREFIX,
  heartbeatKey,
  errorKey,
  stageKey,
};
