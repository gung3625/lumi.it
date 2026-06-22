// content의 요청을 받아 (1) 이미지 fetch+POST로 작업 시작(jobId), (2) 폴링 GET을 대신 수행.
// 이미지 fetch·API 호출은 host_permissions로 cross-origin/CSP 무관. 폴링은 content가 주도(서비스워커 종료 회피).
var API = 'https://lumi.it.kr/api/generate-detail';

function abToB64(ab, type) {
  var bytes = new Uint8Array(ab), bin = '', ch = 0x8000;
  for (var i = 0; i < bytes.length; i += ch) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + ch));
  return 'data:' + (type || 'image/jpeg') + ';base64,' + btoa(bin);
}

chrome.runtime.onMessage.addListener(function (req, sender, sendResponse) {
  // 작업 시작: 이미지 가져와 base64 → POST → jobId
  if (req && req.type === 'lumi-start') {
    (async function () {
      try {
        var ir = await fetch(req.image);
        if (!ir.ok) throw new Error('이미지를 가져오지 못했습니다');
        var blob = await ir.blob();
        var b64 = abToB64(await blob.arrayBuffer(), blob.type);
        var r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: req.title, imageBase64: b64, quality: 'medium' }) });
        var jj = await r.json();
        if (!jj.jobId) throw new Error(jj.error || '생성을 시작하지 못했습니다');
        sendResponse({ ok: true, jobId: jj.jobId });
      } catch (e) { sendResponse({ ok: false, error: (e && e.message) || '오류가 발생했습니다' }); }
    })();
    return true;
  }
  // 상태 폴링: GET ?jobId
  if (req && req.type === 'lumi-poll') {
    fetch(API + '?jobId=' + encodeURIComponent(req.jobId))
      .then(function (r) { return r.json(); })
      .then(function (j) { sendResponse(j); })
      .catch(function () { sendResponse({ status: 'pending' }); });
    return true;
  }
});
