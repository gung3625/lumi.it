    (function () {
      // ── Hero/Bento 데모: 캡션 typewriter 자동 루프 ────────────────────
      // 사장님이 페이지에 머무는 동안 "라이브" 인지를 강화 (2026 트렌드 #4).
      // IntersectionObserver 로 카드가 보일 때만 타이핑 시작 → 모바일 배터리 보호.
      //
      // 2026-05-23 카피 보강: 1개 고정 → 4개 톤 rotation. 같은 사진 (라떼아트 ·
      // 우드 테이블) 에 대해 lumi 가 매장 톤별로 다른 캡션 생성하는 능력 시연.
      // 톤 라벨 (sub) 도 같이 바꿔 "어떤 톤인지" 명시.
      const captionEl = document.querySelector('[data-landing-caption]');
      const labelEl = document.querySelector('.demo__label');
      const CAPTIONS = [
        {
          tone: '시크 · 짧은 호흡',
          text: '오후 세 시.\n우드 테이블 위 라떼 한 잔.\n오늘 두 번째예요.\n\n#스페셜티커피 #이태원카페 #핸드드립 #라떼아트',
        },
        {
          tone: '친근 · 단골 톤',
          text: '사장 손이 또 떨렸어요 ㅋㅋ\n하트가 살짝 기울어졌는데 맛은 진짜예요.\n\n오늘 단골 손님이 추천한 메뉴 — 라떼 어떠세요?\n\n#용산구카페 #라떼아트초보 #카페추천 #이태원동',
        },
        {
          tone: '감성 · 묘사',
          text: '바닐라 빛 우유의 그라데이션, 우드 테이블의 결, 그리고 흐트러지는 김.\n세 번 그려야 한 잔이 나와요.\n\n12시 30분 오픈, 평일 8시까지.\n\n#용산카페 #이태원동카페 #핸드드립카페 #라떼',
        },
        {
          tone: '분위기 · 추천',
          text: '창가 자리, 평일 오후.\n사장이 가장 좋아하는 시간대예요.\n\n라떼 한 잔과 책 한 권. 노트북도 환영합니다.\n\n#작업하기좋은카페 #용산카페 #이태원디저트 #스터디카페',
        },
      ];
      const TYPE_MS = 38;
      const PAUSE_AFTER = 3800;

      let timer = null;
      let cycling = false;
      let captionIdx = 0;

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

      function setLabel(tone) {
        if (!labelEl) return;
        labelEl.textContent = `루미가 캡션 쓰는 중 · ${tone}`;
      }

      async function loop() {
        if (!captionEl) return;
        // prefers-reduced-motion 존중 — 정적 표시만 (첫 캡션)
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          setLabel(CAPTIONS[0].tone);
          captionEl.textContent = CAPTIONS[0].text;
          captionEl.classList.add('is-done');
          return;
        }
        cycling = true;
        while (cycling) {
          const cap = CAPTIONS[captionIdx];
          setLabel(cap.tone);
          await typewrite(captionEl, cap.text);
          await new Promise((r) => setTimeout(r, PAUSE_AFTER));
          captionIdx = (captionIdx + 1) % CAPTIONS.length;
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
