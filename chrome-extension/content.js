// 상품 페이지를 감지하면 화면에 "루미로 상세페이지 만들기" 버튼을 자동으로 띄운다.
// 고객은 확장 아이콘을 찾을 필요 없이, 보이는 버튼만 누르면 된다.
(function () {
  if (window.__lumiInjected) return;
  window.__lumiInjected = true;

  function og(p) { var m = document.querySelector('meta[property="' + p + '"]'); return m ? m.content : ''; }

  // 상품 페이지 휴리스틱: og:type=product / JSON-LD Product / (대표이미지 + 가격 표기)
  function looksLikeProduct() {
    if (document.querySelector('meta[property="og:type"][content="product"]')) return true;
    var lds = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < lds.length; i++) { if (/"@type"\s*:\s*"?Product/i.test(lds[i].textContent || '')) return true; }
    if (og('og:image') && /[₩원]\s*\d|\d{1,3}(,\d{3})+\s*원/.test((document.body.innerText || '').slice(0, 6000))) return true;
    return false;
  }

  function extract() {
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

  if (!looksLikeProduct()) return;

  var btn = document.createElement('div');
  btn.id = 'lumi-fab';
  btn.setAttribute('style', 'position:fixed;right:20px;bottom:20px;z-index:2147483647;background:#C8507A;color:#fff;font-family:-apple-system,"Malgun Gothic",sans-serif;font-size:14px;font-weight:700;padding:13px 18px;border-radius:980px;box-shadow:0 6px 20px rgba(0,0,0,.28);cursor:pointer;user-select:none;transition:filter .15s;');
  btn.textContent = '✨ 루미로 상세페이지 만들기';
  btn.onmouseenter = function () { btn.style.filter = 'brightness(.93)'; };
  btn.onmouseleave = function () { btn.style.filter = 'none'; };
  document.body.appendChild(btn);

  function set(t, busy) { btn.textContent = (busy ? '⏳ ' : '✨ ') + t; }

  btn.addEventListener('click', function () {
    if (btn.dataset.busy) return;
    var d = extract();
    if (!d.title || !d.image) { set('상품 정보를 못 읽었어요', false); return; }
    btn.dataset.busy = '1';
    set('만드는 중... 약 2분', true);
    chrome.runtime.sendMessage({ type: 'lumi-start', title: d.title, image: d.image }, function (resp) {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        set((resp && resp.error) || '실패 — 다시 눌러주세요', false); btn.dataset.busy = ''; return;
      }
      pollLumi(resp.jobId, 0);
    });
  });

  function pollLumi(jobId, n) {
    if (n > 160) { set('시간이 너무 오래 걸려요 — 다시', false); btn.dataset.busy = ''; return; }
    chrome.runtime.sendMessage({ type: 'lumi-poll', jobId: jobId }, function (j) {
      if (chrome.runtime.lastError) { setTimeout(function () { pollLumi(jobId, n + 1); }, 3000); return; }
      if (j && j.status === 'done' && j.html) {
        set('완성! 새 탭 확인', false); btn.dataset.busy = '';
        var w = window.open('', '_blank');
        if (w) { w.document.open(); w.document.write(j.html); w.document.close(); } else set('팝업 허용 후 다시', false);
      } else if (j && j.status === 'error') { set(j.error || '실패 — 다시', false); btn.dataset.busy = ''; }
      else { setTimeout(function () { pollLumi(jobId, n + 1); }, 3000); }
    });
  }
})();
