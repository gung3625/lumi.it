const https = require('https');

// 위도/경도 → 기상청 격자 좌표 변환
function latLonToGrid(lat, lon) {
    const RE = 6371.00877;
    const GRID = 5.0;
    const SLAT1 = 30.0;
    const SLAT2 = 60.0;
    const OLON = 126.0;
    const OLAT = 38.0;
    const XO = 43;
    const YO = 136;
    const DEGRAD = Math.PI / 180.0;

    const re = RE / GRID;
    const slat1 = SLAT1 * DEGRAD;
    const slat2 = SLAT2 * DEGRAD;
    const olon = OLON * DEGRAD;
    const olat = OLAT * DEGRAD;

    let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
    sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
    let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
    sf = Math.pow(sf, sn) * Math.cos(slat1) / sn;
    let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
    ro = re * sf / Math.pow(ro, sn);

    let ra = Math.tan(Math.PI * 0.25 + lat * DEGRAD * 0.5);
    ra = re * sf / Math.pow(ra, sn);
    let theta = lon * DEGRAD - olon;
    if (theta > Math.PI) theta -= 2.0 * Math.PI;
    if (theta < -Math.PI) theta += 2.0 * Math.PI;
    theta *= sn;

    const x = Math.floor(ra * Math.sin(theta) + XO + 0.5);
    const y = Math.floor(ro - ra * Math.cos(theta) + YO + 0.5);
    return { nx: x, ny: y };
}

// 시도명 → 기상청 대표 격자 좌표 매핑
const SIDO_GRID = {
    '서울': { nx: 60, ny: 127 },
    '부산': { nx: 98, ny: 76 },
    '대구': { nx: 89, ny: 90 },
    '인천': { nx: 55, ny: 124 },
    '광주': { nx: 58, ny: 74 },
    '대전': { nx: 67, ny: 100 },
    '울산': { nx: 102, ny: 84 },
    '세종': { nx: 66, ny: 103 },
    '경기': { nx: 60, ny: 120 },
    '강원': { nx: 73, ny: 134 },
    '충북': { nx: 69, ny: 107 },
    '충남': { nx: 68, ny: 100 },
    '전북': { nx: 63, ny: 89 },
    '전남': { nx: 51, ny: 67 },
    '경북': { nx: 91, ny: 106 },
    '경남': { nx: 91, ny: 77 },
    '제주': { nx: 52, ny: 38 },
};

// 강수형태 코드
function getPtyState(pty) {
    const v = parseInt(pty);
    if (v === 1) return 'rain';
    if (v === 2) return 'rain'; // 비/눈
    if (v === 3) return 'snow';
    if (v === 4) return 'rain'; // 소나기
    return 'clear';
}

// 기상청 basetime 계산 (초단기실황: 매시 30분 생성, 40분 이후 조회 가능)
function getBaseDateTime() {
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const mm = kst.getUTCMinutes();

    let base = new Date(kst);
    if (mm < 40) {
        base.setUTCHours(base.getUTCHours() - 1);
    }
    base.setUTCMinutes(30);
    base.setUTCSeconds(0);

    const baseDate = base.toISOString().slice(0, 10).replace(/-/g, '');
    const hh = String(base.getUTCHours()).padStart(2, '0');
    const baseTime = `${hh}30`;
    return { baseDate, baseTime };
}

function httpsGet(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
    });
}

exports.handler = async (event) => {
    const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    const serviceKey = process.env.PUBLIC_DATA_API_KEY;

    if (!serviceKey) {
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'API 키 없음' }) };
    }

    const params = event.queryStringParameters || {};
    let nx, ny, locationName;

    // GPS 좌표가 있으면 격자 변환
    if (params.lat && params.lon) {
        const grid = latLonToGrid(parseFloat(params.lat), parseFloat(params.lon));
        nx = grid.nx;
        ny = grid.ny;
        locationName = params.name || '현재 위치';
    } else {
        // 시도명으로 조회
        const sido = params.sido || '서울';
        const grid = SIDO_GRID[sido] || SIDO_GRID['서울'];
        nx = grid.nx;
        ny = grid.ny;
        locationName = sido;
    }

    const { baseDate, baseTime } = getBaseDateTime();

    try {
        const url = `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst`
            + `?serviceKey=${serviceKey}&numOfRows=10&pageNo=1&dataType=JSON`
            + `&base_date=${baseDate}&base_time=${baseTime}&nx=${nx}&ny=${ny}`;

        const result = await httpsGet(url);
        if (result.status !== 200) throw new Error('HTTP ' + result.status);

        const data = JSON.parse(result.body);
        const header = data?.response?.header;
        if (header?.resultCode !== '00') throw new Error('기상청 오류: ' + header?.resultMsg);

        const items = data?.response?.body?.items?.item || [];

        const obs = {};
        items.forEach(item => { obs[item.category] = item.obsrValue; });

        // T1H: 기온, PTY: 강수형태, REH: 습도, WSD: 풍속, RN1: 1시간강수량
        const temp = obs['T1H'] !== undefined ? Math.round(parseFloat(obs['T1H'])) : null;
        const pty = obs['PTY'] || '0';
        const humidity = obs['REH'] || null;
        const windSpeed = obs['WSD'] || null;
        const state = getPtyState(pty);

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                source: 'kma',
                locationName,
                temperature: temp,
                state,
                pty: parseInt(pty),
                humidity: humidity ? parseInt(humidity) : null,
                windSpeed: windSpeed ? parseFloat(windSpeed) : null,
                baseDate,
                baseTime,
                nx,
                ny
            })
        };
    } catch (e) {
        console.error('get-weather-kma error:', e.message);
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({ error: e.message, source: 'kma_error' })
        };
    }
};
