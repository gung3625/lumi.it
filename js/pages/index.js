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
      // 각 SCENE 의 사진과 캡션이 정확히 매칭돼야 함 (사장님 피드백 2026-05-25):
      //   cafe-1 = 라떼아트 (위에서 본 컵, 잎 패턴, 우드 테이블)
      //   cafe-2 = 치즈케이크 한 조각 + 커피 한 잔 (흰 접시, 창가)
      //   cafe-4 = 크로플(와플) + 바닐라 아이스크림 (나무 도마)  ← 메이플시럽 X
      //   cafe-7 = 사워도우 통빵 1개 (천 위, 베이커리 배경)        ← 깜빠뉴 X
      const SCENES = [
        {
          photoWebp: '/assets/tutorial/cafe-1.webp',
          photoJpg:  '/assets/tutorial/cafe-1.jpg',
          alt: '위에서 본 라떼아트 잎 패턴',
          tone: '시크 · 짧은 호흡',
          text: '오후 세 시.\n라떼 잎 한 장.\n\n조용한 시간이 좋아요 ☕\n\n#카페 #라떼아트 #용산카페 #카페감성',
        },
        {
          photoWebp: '/assets/tutorial/cafe-2.webp',
          photoJpg:  '/assets/tutorial/cafe-2.jpg',
          alt: '치즈케이크 한 조각과 커피',
          tone: '친근 · 단골 톤',
          text: '치즈케이크 한 입에 커피 한 모금.\n끝맛이 깔끔한 게 좋아요.\n\n같이 드시면 정답이에요.\n\n#치즈케이크 #카페디저트 #커피와디저트 #이태원카페',
        },
        {
          photoWebp: '/assets/tutorial/cafe-4.webp',
          photoJpg:  '/assets/tutorial/cafe-4.jpg',
          alt: '크로플 위 바닐라 아이스크림',
          tone: '감성 · 묘사',
          text: '바삭하게 갈라진 결,\n천천히 녹는 바닐라.\n\n따뜻함과 시원함의 그 순간 ✨\n\n#크로플 #바닐라아이스크림 #카페디저트 #브런치카페',
        },
        {
          photoWebp: '/assets/tutorial/cafe-7.webp',
          photoJpg:  '/assets/tutorial/cafe-7.jpg',
          alt: '오늘 구운 사워도우 통빵',
          tone: '친근 · 이야기',
          text: '오늘 새벽에 구운 사워도우 🍞\n\n겉은 단단, 안은 쫀득.\n오븐 열면 매장 가득 향이 퍼져요.\n\n#베이커리 #사워도우 #천연발효 #이태원베이커리',
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
