    (function () {
      // ── Hero/Bento 데모: 캡션 typewriter 자동 루프 ────────────────────
      // 사장님이 페이지에 머무는 동안 "라이브" 인지를 강화 (2026 트렌드 #4).
      // IntersectionObserver 로 카드가 보일 때만 타이핑 시작 → 모바일 배터리 보호.
      //
      // 2026-05-23 데모 보강: 사진 + 캡션 + 톤 동기화 rotation. lumi 의 핵심 차별점인
      // "사진에 맞는 캡션 생성" 을 시각적으로 시연. 같은 매장의 4가지 메뉴 (라떼아트 /
      // 케이크 / 크로플 / 빵) 에 대해 각각 다른 톤의 사진 적합 캡션.
      const captionEl = document.querySelector('[data-landing-caption]');
      const labelEl = document.querySelector('[data-landing-tone]');
      const photoEl = document.querySelector('[data-landing-photo]');
      const photoSourceEl = document.querySelector('[data-landing-photo-source]');
      const SCENES = [
        {
          photoWebp: '/assets/tutorial/cafe-1.webp',
          photoJpg:  '/assets/tutorial/cafe-1.jpg',
          alt: '우드 테이블 위 라떼아트',
          tone: '시크 · 짧은 호흡',
          text: '오후 세 시.\n우드 테이블 위 라떼 한 잔.\n오늘 두 번째예요.\n\n#스페셜티커피 #이태원카페 #핸드드립 #라떼아트',
        },
        {
          photoWebp: '/assets/tutorial/cafe-2.webp',
          photoJpg:  '/assets/tutorial/cafe-2.jpg',
          alt: '오늘의 디저트',
          tone: '친근 · 단골 톤',
          text: '오늘 신메뉴 — 바질 크림 케이크 들어왔어요 ㅋㅋ\n보자마자 단골 사장님 떠올라서 한 조각 챙겨뒀습니다.\n\n평일 디저트 1+1, 오후 4시까지!\n\n#홈베이킹 #이태원디저트 #용산구카페 #신메뉴',
        },
        {
          photoWebp: '/assets/tutorial/cafe-4.webp',
          photoJpg:  '/assets/tutorial/cafe-4.jpg',
          alt: '갓 구운 크로플',
          tone: '감성 · 묘사',
          text: '바삭하게 갈라진 결, 흘러내리는 메이플시럽.\n하나 더 굽고 있어요. 8분만 기다려주세요.\n\n오늘은 평일이라 자리 여유 있어요.\n\n#수제크로플 #이태원디저트 #브런치카페 #핸드드립',
        },
        {
          photoWebp: '/assets/tutorial/cafe-7.webp',
          photoJpg:  '/assets/tutorial/cafe-7.jpg',
          alt: '천연발효 깜빠뉴',
          tone: '분위기 · 추천',
          text: '새벽 5시부터 반죽한 깜빠뉴.\n오후 6시 굽기 마지막 회차예요.\n\n오늘 못 만나신 분들 — 내일 또 만나요.\n\n#수제빵 #이태원베이커리 #천연발효 #깜빠뉴',
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
        labelEl.textContent = tone;
      }

      function setScene(scene) {
        if (photoSourceEl) photoSourceEl.setAttribute('srcset', scene.photoWebp);
        if (photoEl) {
          photoEl.setAttribute('src', scene.photoJpg);
          photoEl.setAttribute('alt', scene.alt);
        }
      }

      async function loop() {
        if (!captionEl) return;
        // prefers-reduced-motion 존중 — 정적 표시만 (첫 캡션)
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          setScene(SCENES[0]);
          setLabel(SCENES[0].tone);
          captionEl.textContent = SCENES[0].text;
          captionEl.classList.add('is-done');
          return;
        }
        cycling = true;
        while (cycling) {
          const scene = SCENES[captionIdx];
          setScene(scene);
          setLabel(scene.tone);
          await typewrite(captionEl, scene.text);
          await new Promise((r) => setTimeout(r, PAUSE_AFTER));
          captionIdx = (captionIdx + 1) % SCENES.length;
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
