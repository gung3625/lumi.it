// content.js의 요청을 받아 이미지를 가져와 base64로 변환하고, 루미 API로 상세페이지를 생성한다.
// (이미지 fetch는 host_permissions로 cross-origin 허용 → 차단 사이트 이미지도 가져옴)
var API = 'https://lumi.it.kr/api/generate-detail';

function abToB64(ab, type) {
  var bytes = new Uint8Array(ab), bin = '', ch = 0x8000;
  for (var i = 0; i < bytes.length; i += ch) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + ch));
  return 'data:' + (type || 'image/jpeg') + ';base64,' + btoa(bin);
}

chrome.runtime.onMessage.addListener(function (req, sender, sendResponse) {
  if (!req || req.type !== 'lumi-generate') return;
  (async function () {
    try {
      var ir = await fetch(req.image);
      if (!ir.ok) throw new Error('이미지를 가져오지 못했습니다');
      var blob = await ir.blob();
      var b64 = abToB64(await blob.arrayBuffer(), blob.type);

      var r = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: req.title, imageBase64: b64, quality: 'low' }),
      });
      var jj = await r.json();
      if (!jj.success || !jj.html) { sendResponse({ ok: false, error: jj.error || '생성에 실패했습니다' }); return; }
      sendResponse({ ok: true, html: jj.html });
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) || '오류가 발생했습니다' });
    }
  })();
  return true; // async sendResponse
});
