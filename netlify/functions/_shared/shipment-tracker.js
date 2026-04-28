// 배송 추적 — Sprint 3
// 스마트택배(스위트트래커) 무료 API + 우체국택배(공공API) 모킹
// 1시간마다 갱신, 배송완료 시 셀러 푸시 (cron 별도)

const { getCourier } = require('./courier-codes');

const SMART_TRACKER_HOST = 'https://info.sweettracker.co.kr';
const SMART_TRACKER_PATH = '/api/v1/trackingInfo';

/**
 * 스마트택배 API 응답 → 루미 표준 이벤트 배열
 * @param {Object} apiResponse
 * @returns {Array<{ status, description, location, occurred_at, source, raw }>}
 */
function normalizeSmartTrackerResponse(apiResponse) {
  if (!apiResponse || !Array.isArray(apiResponse.trackingDetails)) return [];
  return apiResponse.trackingDetails.map((d) => ({
    status: mapKindToStatus(d.kind),
    description: d.kind || '',
    location: d.where || '',
    occurred_at: parseTimestamp(d.timeString || d.time),
    source: 'smart_tracker',
    raw: d,
  })).filter((e) => e.occurred_at);
}

function mapKindToStatus(kind) {
  const k = String(kind || '').toLowerCase();
  if (/(배달완료|배송완료|delivered)/.test(kind || '')) return 'delivered';
  if (/(배송출발|배달출발|out for delivery)/.test(kind || '')) return 'out_for_delivery';
  if (/(간선상차|간선하차|이동중|in transit)/.test(kind || '')) return 'in_transit';
  if (/(집화|픽업|shipped)/.test(kind || '')) return 'shipping';
  if (/(반송|미배달|exception)/.test(kind || '')) return 'exception';
  if (k.includes('delivered')) return 'delivered';
  return 'in_transit';
}

function parseTimestamp(s) {
  if (!s) return null;
  const t = new Date(s);
  if (Number.isNaN(t.getTime())) return null;
  return t.toISOString();
}

/**
 * 단일 송장 추적 조회
 * @param {Object} input
 * @param {string} input.courier_code
 * @param {string} input.tracking_number
 * @param {boolean} [input.mock]
 * @returns {Promise<{ ok: boolean, events: Array, current_status?: string, error?: string }>}
 */
async function trackShipment({ courier_code, tracking_number, mock }) {
  if (!courier_code || !tracking_number) {
    return { ok: false, error: '택배사 코드와 송장번호가 필요해요.', events: [] };
  }
  const courier = getCourier(courier_code);
  if (!courier) {
    return { ok: false, error: '지원하지 않는 택배사예요.', events: [] };
  }

  const isMock = mock === true
    || (process.env.SHIPMENT_TRACK_MOCK || 'true').toLowerCase() !== 'false'
    || !process.env.SMART_TRACKER_API_KEY;

  if (isMock) {
    // 모킹: 송장번호 끝자리 % 3 으로 상태 분기
    const lastDigit = parseInt(String(tracking_number).slice(-1), 10) || 0;
    const phase = lastDigit % 3;
    const now = Date.now();
    const events = [];
    const baseTimes = [
      now - 3 * 24 * 3600 * 1000,
      now - 2 * 24 * 3600 * 1000,
      now - 1 * 24 * 3600 * 1000,
      now - 6 * 3600 * 1000,
    ];
    events.push({ status: 'shipping', description: '집화 처리', location: '판매자 출고지', occurred_at: new Date(baseTimes[0]).toISOString(), source: 'mock', raw: {} });
    if (phase >= 1) events.push({ status: 'in_transit', description: '간선 상차', location: '대전 HUB', occurred_at: new Date(baseTimes[1]).toISOString(), source: 'mock', raw: {} });
    if (phase >= 1) events.push({ status: 'out_for_delivery', description: '배송 출발', location: '서울 강남 지점', occurred_at: new Date(baseTimes[2]).toISOString(), source: 'mock', raw: {} });
    if (phase >= 2) events.push({ status: 'delivered', description: '배송 완료', location: '문 앞', occurred_at: new Date(baseTimes[3]).toISOString(), source: 'mock', raw: {} });
    return {
      ok: true,
      events,
      current_status: events[events.length - 1].status,
      mock: true,
    };
  }

  // 실연동
  try {
    const fetch = require('node-fetch');
    const params = new URLSearchParams({
      t_key: process.env.SMART_TRACKER_API_KEY,
      t_code: courier.smart_tracker_code,
      t_invoice: tracking_number,
    });
    const res = await fetch(`${SMART_TRACKER_HOST}${SMART_TRACKER_PATH}?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      return { ok: false, error: `추적 API 응답 오류 (${res.status})`, events: [] };
    }
    const json = await res.json();
    if (json.status === false) {
      return { ok: false, error: json.msg || '추적 정보 없음', events: [] };
    }
    const events = normalizeSmartTrackerResponse(json);
    return {
      ok: true,
      events,
      current_status: events.length > 0 ? events[events.length - 1].status : 'shipping',
    };
  } catch (e) {
    return { ok: false, error: '추적 네트워크 오류: ' + e.message, events: [], retryable: true };
  }
}

module.exports = {
  trackShipment,
  normalizeSmartTrackerResponse,
};
