const https = require('https');

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

function getDateStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

exports.handler = async (event) => {
  const corsHeaders = { 'Content-Type': 'application/json' };
  const params = event.queryStringParameters || {};
  const sidoCode = params.sido || '';
  const sigunguCode = params.sigungu || '';
  const serviceKey = process.env.PUBLIC_DATA_API_KEY;

  if (!sidoCode || !serviceKey) {
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ festivals: [], count: 0 }) };
  }

  const today = getDateStr(0);
  const twoWeeksLater = getDateStr(14);

  try {
    let url = `https://apis.data.go.kr/B551011/KorService2/searchFestival2?` +
      `numOfRows=3&pageNo=1&MobileOS=WEB&MobileApp=lumi&_type=json&arrange=R` +
      `&eventStartDate=${today}&eventEndDate=${twoWeeksLater}` +
      `&serviceKey=${encodeURIComponent(serviceKey)}` +
      `&lDongRegnCd=${sidoCode}`;

    if (sigunguCode) url += `&lDongSignguCd=${sigunguCode}`;

    const result = await httpsGet(url);

    if (result.status !== 200) {
      console.error('행사 API 오류:', result.status, result.body.substring(0, 200));
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ festivals: [], count: 0 }) };
    }

    const data = JSON.parse(result.body);
    const items = data?.response?.body?.items?.item;

    if (!items) {
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ festivals: [], count: 0 }) };
    }

    const list = Array.isArray(items) ? items : [items];
    const festivals = list.map(item => ({
      title: item.title || '',
      startDate: item.eventstartdate || '',
      endDate: item.eventenddate || '',
      addr: item.addr1 || '',
    }));

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ festivals, count: festivals.length })
    };

  } catch(e) {
    console.error('get-festival error:', e.message);
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ festivals: [], count: 0 }) };
  }
};
