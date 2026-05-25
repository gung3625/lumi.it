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
      // 각 SCENE 의 사진과 캡션 정확히 매칭 + 사장님 본인 이야기 / 디테일 / 손님 톤 (진정성).
      const SCENES = [
        {
          photoWebp: '/assets/tutorial/cafe-1.webp',
          photoJpg:  '/assets/tutorial/cafe-1.jpg',
          alt: '위에서 본 라떼아트 잎 패턴',
          tone: '시크 · 짧은 호흡',
          text: '오후 세 시.\n손님 한 분, 저 한 명.\n\n오늘은 손이 잘 됐어요.\n잎이 깨끗하게 그려진 날.\n\n이런 시간 때문에\n아침 일찍 와요 ☕\n\n#카페 #라떼아트 #용산카페 #오후세시 #카페감성',
        },
        {
          photoWebp: '/assets/tutorial/cafe-2.webp',
          photoJpg:  '/assets/tutorial/cafe-2.jpg',
          alt: '치즈케이크 한 조각과 커피',
          tone: '친근 · 단골 톤',
          text: '치즈케이크 한 조각에\n드립커피 한 잔.\n\n단골 사장님이 "같이 먹으면 어때요?" 하셔서\n이번 주부터 세트 가격 1,000원 빼드려요.\n\n평일 오후 들러보세요 :)\n\n#치즈케이크 #드립커피 #카페디저트 #이태원카페',
        },
        {
          photoWebp: '/assets/tutorial/cafe-4.webp',
          photoJpg:  '/assets/tutorial/cafe-4.jpg',
          alt: '크로플 위 바닐라 아이스크림',
          tone: '감성 · 묘사',
          text: '바삭한 결 사이로\n바닐라가 천천히 녹습니다.\n\n빨리 드세요.\n저도 사진 찍는 사이\n한 입 사라졌어요 🍦\n\n오늘은 평일이라 자리 여유 있어요.\n\n#크로플 #바닐라아이스크림 #카페디저트 #브런치카페',
        },
        {
          photoWebp: '/assets/tutorial/cafe-7.webp',
          photoJpg:  '/assets/tutorial/cafe-7.jpg',
          alt: '오늘 구운 사워도우 통빵',
          tone: '친근 · 이야기',
          text: '새벽 다섯 시 반죽,\n오후 두 시 굽기.\n\n오늘은 발효가 평소보다 잘 됐어요.\n오븐 열었더니\n매장 가득 빵 냄새 🍞\n\n식기 전에 한 덩이 사가실 분?\n\n#베이커리 #사워도우 #천연발효 #이태원베이커리',
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

    // ── Hero 우하단 미리보기 카드: 사진+캡션 슬라이드 자동 회전 ────────────
    // 라떼아트 한 장만 보여주지 말고, 5장 (카페·디저트·푸드) 이 순환해서
    // "같은 매장 사진도 매번 다른 캡션" 이라는 lumi 의 핵심을 한눈에 보여주기.
    (function () {
      const root = document.querySelector('[data-hero-preview]');
      if (!root) return;

      const sourceEl   = root.querySelector('[data-hero-preview-source]');
      const imgEl      = root.querySelector('[data-hero-preview-img]');
      const toneEl     = root.querySelector('[data-hero-preview-tone]');
      const captionEl  = root.querySelector('[data-hero-preview-caption]');
      const tagsEl     = root.querySelector('[data-hero-preview-tags]');
      const likesEl    = root.querySelector('[data-hero-preview-likes]');
      const commentsEl = root.querySelector('[data-hero-preview-comments]');
      const contentEl  = root.querySelector('[data-hero-preview-content]');
      const dots       = root.querySelectorAll('[data-hero-preview-dot]');

      if (!imgEl || !captionEl || !contentEl) return;

      // 슬라이드 5장 — cases-carousel 의 사진+캡션 중 다양성이 가장 큰 5개 선별.
      // 각 슬라이드의 likes/comments 도 메뉴 성격에 맞게 자연스럽게 변화시킴.
      const SLIDES = [
        {
          webp: '/assets/tutorial/cafe-1.webp',
          jpg:  '/assets/tutorial/cafe-1.jpg',
          alt:  '라떼아트 잎 패턴',
          tone: '시크 · 짧은 호흡',
          captionHtml: '오후 세 시.<br>손님 한 분, 저 한 명.<br><br>오늘은 손이 잘 됐어요.<br>잎이 깨끗하게 그려진 날.<br><br>이런 시간 때문에<br>아침 일찍 와요 ☕',
          tags: '#카페 #라떼아트 #용산카페 #오후세시 #카페감성',
          likes: '❤️ 127',
          comments: '💬 8',
        },
        {
          webp: '/assets/tutorial/cafe-2.webp',
          jpg:  '/assets/tutorial/cafe-2.jpg',
          alt:  '치즈케이크 한 조각과 커피',
          tone: '친근 · 단골 톤',
          captionHtml: '치즈케이크 한 조각에<br>드립커피 한 잔.<br><br>단골 사장님이 "같이 먹으면 어때요?" 하셔서<br>이번 주부터 세트 가격 1,000원 빼드려요.<br><br>평일 오후 들러보세요 :)',
          tags: '#치즈케이크 #드립커피 #카페디저트 #이태원카페',
          likes: '❤️ 89',
          comments: '💬 4',
        },
        {
          webp: '/assets/tutorial/cafe-3.webp',
          jpg:  '/assets/tutorial/cafe-3.jpg',
          alt:  '파스텔 마카롱 5개',
          tone: '감성 · 시각 톤',
          captionHtml: '오늘 만든 마카롱.<br><br>바닐라 · 민트 · 살구 · 라벤더 · 라즈베리.<br><br>색 보고 고르는 분도,<br>향 맡고 고르는 분도 있어요.<br><br>저는 오늘 라벤더가 손에 잡혀요 💜',
          tags: '#마카롱 #홈베이킹 #카페디저트 #파스텔디저트',
          likes: '❤️ 203',
          comments: '💬 15',
        },
        {
          webp: '/assets/tutorial/cafe-4.webp',
          jpg:  '/assets/tutorial/cafe-4.jpg',
          alt:  '크로플 위 바닐라 아이스크림',
          tone: '감성 · 묘사',
          captionHtml: '바삭한 결 사이로<br>바닐라가 천천히 녹습니다.<br><br>빨리 드세요.<br>저도 사진 찍는 사이<br>한 입 사라졌어요 🍦<br><br>오늘은 평일이라 자리 여유 있어요.',
          tags: '#크로플 #바닐라아이스크림 #카페디저트 #브런치카페',
          likes: '❤️ 156',
          comments: '💬 11',
        },
        {
          webp: '/assets/tutorial/cafe-8.webp',
          jpg:  '/assets/tutorial/cafe-8.jpg',
          alt:  '블루베리 스무디와 딸기 스무디',
          tone: '재미 · 여름 톤',
          captionHtml: '오늘 더워요.<br><br>블루베리 한 잔, 딸기 한 잔.<br>"하나만 골라야 해요?" 손님 질문에<br>"둘 다 드세요" 답변 드립니다 🍓<br><br>오후 5시까지 2잔 9,000원.',
          tags: '#스무디 #베리스무디 #여름음료 #카페신메뉴',
          likes: '❤️ 94',
          comments: '💬 6',
        },
      ];

      const ROTATE_MS = 4500;
      const FADE_MS = 320;
      let idx = 0;
      let rotateTimer = null;
      let inView = false;

      function applySlide(i) {
        const s = SLIDES[i];
        if (sourceEl) sourceEl.setAttribute('srcset', s.webp);
        imgEl.setAttribute('src', s.jpg);
        imgEl.setAttribute('alt', s.alt);
        if (toneEl) toneEl.textContent = s.tone;
        captionEl.innerHTML = s.captionHtml;
        if (tagsEl) tagsEl.textContent = s.tags;
        if (likesEl) likesEl.textContent = s.likes;
        if (commentsEl) commentsEl.textContent = s.comments;
        dots.forEach((d, di) => {
          const active = di === i;
          d.classList.toggle('is-active', active);
          d.setAttribute('aria-current', active ? 'true' : 'false');
        });
      }

      function goTo(i) {
        if (i === idx) return;
        contentEl.classList.add('is-fading');
        setTimeout(() => {
          idx = (i + SLIDES.length) % SLIDES.length;
          applySlide(idx);
          contentEl.classList.remove('is-fading');
        }, FADE_MS);
      }

      function next() {
        goTo((idx + 1) % SLIDES.length);
      }

      function startRotate() {
        if (rotateTimer) return;
        rotateTimer = setInterval(next, ROTATE_MS);
      }

      function stopRotate() {
        if (!rotateTimer) return;
        clearInterval(rotateTimer);
        rotateTimer = null;
      }

      // dot 클릭 → 해당 슬라이드. 자동 회전 타이머도 reset.
      dots.forEach((d) => {
        d.addEventListener('click', () => {
          const target = parseInt(d.getAttribute('data-hero-preview-dot'), 10);
          if (Number.isNaN(target)) return;
          goTo(target);
          if (inView) { stopRotate(); startRotate(); }
        });
      });

      // 호버 시 자동 회전 일시 정지 (사장님이 캡션 읽는 중 방해 X)
      root.addEventListener('mouseenter', stopRotate);
      root.addEventListener('mouseleave', () => { if (inView) startRotate(); });

      // prefers-reduced-motion → 첫 슬라이드만 고정
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        applySlide(0);
        return;
      }

      // 화면에 보일 때만 회전 (off-screen CPU 낭비 X)
      if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              inView = true;
              startRotate();
            } else {
              inView = false;
              stopRotate();
            }
          }
        }, { threshold: 0.2 });
        io.observe(root);
      } else {
        inView = true;
        startRotate();
      }
    })();
