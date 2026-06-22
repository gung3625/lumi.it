// 현재 보고 있는 상품 페이지에서 제목·대표이미지를 추출 → 루미 API로 상세페이지 생성.
var API = 'https://lumi.it.kr/api/generate-detail';

// 페이지 컨텍스트에서 실행됨(content). og / JSON-LD(Product) / 가장 큰 이미지 순으로 추출.
function pageExtract() {
  function og(p) { var m = document.querySelector('meta[property="' + p + '"]'); return m ? m.content : ''; }
  var title = og('og:title') || document.title || '';
  var image = og('og:image') || '';
  try {
    var els = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < els.length; i++) {
      var d = JSON.parse(els[i].textContent); var arr = Array.isArray(d) ? d : [d];
      for (var j = 0; j < arr.length; j++) {
        var o = arr[j] || {}; var t = o['@type'] || ''; t = Array.isArray(t) ? t.join(',') : String(t);
        if (/Product/i.test(t)) { if (o.name) title = o.name; if (o.image) image = Array.isArray(o.image) ? o.image[0] : o.image; }
      }
    }
  } catch (e) {}
  if (!image) {
    var best = '', area = 0, ims = document.images;
    for (var k = 0; k < ims.length; k++) { var a = ims[k].naturalWidth * ims[k].naturalHeight; if (a > area && ims[k].naturalWidth > 200) { area = a; best = ims[k].currentSrc || ims[k].src; } }
    image = best;
  }
  if (image && image.indexOf('//') === 0) image = location.protocol + image;
  return { title: (title || '').trim().slice(0, 120), image: image };
}

function blobToB64(blob) {
  return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = rej; fr.readAsDataURL(blob); });
}

var goBtn = document.getElementById('go');
var msg = document.getElementById('msg');
var preview = document.getElementById('preview');
var thumb = document.getElementById('thumb');
var ptitle = document.getElementById('ptitle');

goBtn.addEventListener('click', function () {
  goBtn.disabled = true; preview.style.display = 'none'; msg.textContent = '상품 정보를 읽는 중...';
  (async function () {
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      var tab = tabs[0];
      var out = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageExtract });
      var data = out && out[0] && out[0].result;
      if (!data || !data.title || !data.image) { msg.textContent = '상품 정보를 못 읽었어요. 상품 상세 페이지에서 눌러주세요.'; goBtn.disabled = false; return; }

      thumb.src = data.image; ptitle.textContent = data.title; preview.style.display = 'block';
      msg.textContent = '사진을 가져오는 중...';
      var resp = await fetch(data.image);
      if (!resp.ok) throw new Error('이미지를 가져오지 못했습니다');
      var b64 = await blobToB64(await resp.blob());

      msg.textContent = 'AI가 화보·카피를 만드는 중... (약 1분)';
      var r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: data.title, imageBase64: b64, quality: 'low' }) });
      var jj = await r.json();
      if (!jj.success || !jj.html) { msg.textContent = jj.error || '생성에 실패했습니다.'; goBtn.disabled = false; return; }

      var w = window.open('', '_blank');
      if (w) { w.document.open(); w.document.write(jj.html); w.document.close(); msg.textContent = '✨ 완성! 새 탭에서 확인하세요.'; }
      else { msg.textContent = '팝업이 차단됐어요. 팝업 허용 후 다시 시도해 주세요.'; }
      goBtn.disabled = false;
    } catch (e) {
      msg.textContent = '오류: ' + ((e && e.message) || '실패'); goBtn.disabled = false;
    }
  })();
});
