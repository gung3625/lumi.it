    (function () {
      // ── Hero/Bento 데모: 캡션 typewriter 자동 루프 ────────────────────
      // 사장님이 페이지에 머무는 동안 "라이브" 인지를 강화 (2026 트렌드 #4).
      // IntersectionObserver 로 카드가 보일 때만 타이핑 시작 → 모바일 배터리 보호.
      const captionEl = document.querySelector('[data-landing-caption]');
      const CAPTION =
        '오늘도 천천히 흘러가는 시간을 한 잔에 담아봤어요.\n\n#카페 #라떼아트 #오늘의한잔 #카페일상';
      const TYPE_MS = 38;
      const PAUSE_AFTER = 3600;

      let timer = null;
      let cycling = false;

      function typewrite(target, text) {
        return new Promise((resolve) => {
          if (timer) { clearInterval(timer); timer = null; }
          target.textContent = '';
          target.classList.remove('is-done');
          let i = 0;
          timer = setInterval(() => {
            target.textContent += text[i];
            i++;
            if (i >= text.length) {
              clearInterval(timer); timer = null;
              target.classList.add('is-done');
              resolve();
            }
          }, TYPE_MS);
        });
      }

      async function loop() {
        if (!captionEl) return;
        // prefers-reduced-motion 존중 — 정적 표시만
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          captionEl.textContent = CAPTION;
          captionEl.classList.add('is-done');
          return;
        }
        cycling = true;
        while (cycling) {
          await typewrite(captionEl, CAPTION);
          await new Promise((r) => setTimeout(r, PAUSE_AFTER));
        }
      }

      // 데모 카드가 보일 때만 시작 (off-screen 에서 CPU 낭비 X)
      const demoCard = document.querySelector('.bento__card--hero');
      if (demoCard && 'IntersectionObserver' in window) {
        const io = new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (e.isIntersecting && !cycling) {
              loop();
            } else if (!e.isIntersecting && cycling) {
              cycling = false;
              if (timer) { clearInterval(timer); timer = null; }
            }
          }
        }, { threshold: 0.3 });
        io.observe(demoCard);
      } else {
        // IO 미지원 fallback — 즉시 시작
        loop();
      }
    })();
