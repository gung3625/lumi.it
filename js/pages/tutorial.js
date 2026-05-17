    (function () {
      const STEPS = document.querySelectorAll('[data-step]');
      const TOTAL = 5;
      const MAX_PHOTOS = 9;
      const selected = new Set();

      function goTo(n) {
        if (n < 1 || n > TOTAL) return;
        // Step 2 가 아닌 다른 step 으로 가면 guided tour 강제 종료 (남아 있으면 다른 화면 가림).
        if (n !== 2 && typeof closeTour === 'function') closeTour();
        STEPS.forEach(s => {
          const isActive = Number(s.dataset.step) === n;
          s.hidden = !isActive;
          s.setAttribute('aria-hidden', String(!isActive));
        });
        // 사장님 결정 2026-05-16: 튜토리얼에는 footer 불필요. 사업자 정보·약관은
        // 소개 랜딩 (index.html) 에서 노출. 튜토리얼은 단순 미리보기 흐름만.
        window.scrollTo({ top: 0, behavior: 'instant' });
      }
      // 초기 진입 — Step 1 활성.
      goTo(1);

      // Spotlight 코치마크 — Step 1 진입 시 + 버튼만 환하게 + 안내 말풍선.
      // Step 1 → Step 2 클릭 (또는 다른 Step 로 강제 이동) 시 fade-out + remove.
      function closeSpotlight() {
        ['[data-spotlight-overlay]', '[data-spotlight-tooltip]'].forEach(sel => {
          const el = document.querySelector(sel);
          if (!el) return;
          el.classList.add('is-closing');
          setTimeout(() => { try { el.remove(); } catch (_) {} }, 320);
        });
      }

      // Step 1 → Step 2 (탭바 가운데 + 버튼 클릭) — spotlight 닫고 Step 2 진입 + tour 시작.
      const addBtn = document.querySelector('[data-tutorial-add]');
      if (addBtn) {
        addBtn.addEventListener('click', () => {
          closeSpotlight();
          goTo(2);
          // Step 2 진입 애니메이션 (step-enter 400ms) 후 tour 시작
          setTimeout(() => startUploadTour(), 500);
        });
      }

      // === Step 2 Guided Tour — 6단계 sequential spotlight ===
      // 사장님 결정: "이미지·영상 두 가지 업로드 가능 → 다음 부분 강조 → 또 설명 → 아래로 쭉".
      // 각 단계: target element scrollIntoView + cutout spotlight + tooltip (위/아래 자동) + "다음 →" 버튼.
      // 5단계 tour — 첫 step "미디어 탭" 은 페이지 최상단이라 모바일 URL bar 에 가려져 제외.
      // 미디어 탭 (이미지·영상 둘 다 가능) 정보는 dropzone step 의 hint 에 통합.
      // step 4 (옵션) 은 multi target — 스토리/날씨/쓰레드/링크 4개 .upload-field 묶음.
      // 사장님 결정 2026-05-17: 메모·게시 시점은 라벨까지 같이 강조 (textarea/button 만
       // cutout 잡으면 사장님이 "이게 뭔가" 인식 못 함). .upload-field wrap 으로 라벨 포함.
      const TOUR_STEPS = [
        { target: '.media-tabs',                         title: '먼저 종류를 골라요',                 hint: '이미지·영상 둘 다 업로드 가능' },
        { target: '.upload-dropzone[data-open-gallery]', title: '여기를 눌러 사진을 골라요',          hint: '갤러리에서 1~10장 선택' },
        { target: '.upload-field:has(#tutorial-memo)',   title: '한 줄 메모는 선택이에요',            hint: '메뉴·분위기 짧게 적으면 캡션이 더 정확해져요' },
        { target: '.upload-field:has(.upload-schedule)', title: '게시 시점을 골라요',                 hint: '지금 / 예약 / 베스트 시간 — 베스트 시간은 사장님 업종 기반 자동 계산' },
        { target: '[data-tour-option]',                  title: '스토리·날씨·쓰레드·프로필 링크',     hint: '4가지 기능을 자유롭게 ON/OFF — 필요한 것만 켜세요', multi: true },
        { target: '[data-submit-upload]',                title: '마지막! 누르면 분석이 시작돼요',     hint: '캡션·해시태그가 자동으로 만들어져요' },
      ];

      function placeSpotlight(rect) {
        let sp = document.querySelector('.tour-backdrop');
        if (!sp) {
          // SVG mask 패턴 — backdrop 이 viewport 전체 어둡게 + mask 의 검정 rect 가
          // 그 자리만 transparent (cutout). element 가 어디 있든 viewport 일관 어둡게.
          sp = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          sp.setAttribute('class', 'tour-backdrop');
          sp.setAttribute('preserveAspectRatio', 'none');
          sp.innerHTML =
            '<defs><mask id="tourCutoutMask">' +
              '<rect width="100%" height="100%" fill="white"/>' +
              '<rect class="cutout-rect" fill="black" rx="16" ry="16"/>' +
            '</mask></defs>' +
            '<rect width="100%" height="100%" fill="rgba(0,0,0,0.62)" mask="url(#tourCutoutMask)"/>';
          document.body.appendChild(sp);
        }
        const pad = 12;
        const cr = sp.querySelector('.cutout-rect');
        cr.setAttribute('x',      String(rect.left - pad));
        cr.setAttribute('y',      String(rect.top  - pad));
        cr.setAttribute('width',  String(rect.width  + pad * 2));
        cr.setAttribute('height', String(rect.height + pad * 2));
        return sp;
      }
      function placeTooltip(rect, cur, idx) {
        const old = document.querySelector('.tour-tooltip');
        if (old) old.remove();
        const tt = document.createElement('div');
        tt.className = 'tour-tooltip';
        const isLast = idx + 1 === TOUR_STEPS.length;
        tt.innerHTML =
          cur.title +
          '<span class="tour-tooltip__hint">' + cur.hint + '</span>' +
          '<div class="tour-tooltip__nav">' +
            '<span class="tour-tooltip__step">' + (idx + 1) + '/' + TOUR_STEPS.length + '</span>' +
            '<button class="tour-tooltip__next" type="button" data-tour-next>' +
              (isLast ? '시작! ▶' : '다음 →') +
            '</button>' +
          '</div>';
        document.body.appendChild(tt);
        // 위치 — target 아래 공간 충분하면 below, 아니면 above
        const ttRect = tt.getBoundingClientRect();
        const belowSpace = window.innerHeight - rect.bottom;
        const aboveSpace = rect.top;
        const placeBelow = belowSpace > ttRect.height + 24 || belowSpace > aboveSpace;
        tt.dataset.arrow = placeBelow ? 'up' : 'down';
        const gap = 14;
        const top = placeBelow ? (rect.bottom + gap) : (rect.top - ttRect.height - gap);
        const centerLeft = rect.left + rect.width / 2 - ttRect.width / 2;
        const left = Math.max(12, Math.min(window.innerWidth - ttRect.width - 12, centerLeft));
        tt.style.top  = top  + 'px';
        tt.style.left = left + 'px';
        tt.querySelector('[data-tour-next]').addEventListener('click', () => {
          if (isLast) {
            closeTour();
            const submit = document.querySelector('[data-submit-upload]');
            if (submit && !submit.disabled) submit.click();
          } else {
            showTourStep(idx + 1);
          }
        });
      }
      // 현재 tour step + scroll listener — 사장님 스크롤 시 spotlight 따라가게 (CTA 가 cutout
      // 자리로 들어오면 안 가리는 버그 fix, 2026-05-17).
      // var 사용 — closeTour() 가 goTo(1) → IIFE 초기화 단계에서 호출되어 currentTourIdx
      // 접근 시 let TDZ 위반으로 IIFE 전체 throw 했던 버그 fix (2026-05-17).
      var currentTourIdx = null;
      function calcCurrentRect() {
        if (currentTourIdx == null) return null;
        const cur = TOUR_STEPS[currentTourIdx];
        const els = cur.multi
          ? Array.from(document.querySelectorAll(cur.target))
          : [document.querySelector(cur.target)].filter(Boolean);
        if (!els.length) return null;
        const rects = els.map(e => e.getBoundingClientRect());
        const top    = Math.min(...rects.map(r => r.top));
        const left   = Math.min(...rects.map(r => r.left));
        const right  = Math.max(...rects.map(r => r.right));
        const bottom = Math.max(...rects.map(r => r.bottom));
        return { top, left, right, bottom, width: right - left, height: bottom - top };
      }
      function repositionTooltip(rect) {
        const tt = document.querySelector('.tour-tooltip');
        if (!tt) return;
        const ttRect = tt.getBoundingClientRect();
        const belowSpace = window.innerHeight - rect.bottom;
        const aboveSpace = rect.top;
        const placeBelow = belowSpace > ttRect.height + 24 || belowSpace > aboveSpace;
        tt.dataset.arrow = placeBelow ? 'up' : 'down';
        const gap = 14;
        const top = placeBelow ? (rect.bottom + gap) : (rect.top - ttRect.height - gap);
        const centerLeft = rect.left + rect.width / 2 - ttRect.width / 2;
        const left = Math.max(12, Math.min(window.innerWidth - ttRect.width - 12, centerLeft));
        tt.style.top  = top  + 'px';
        tt.style.left = left + 'px';
      }
      // 사장님 결정 2026-05-17 (재재재정정): cutout 이 항상 target element 를 cover +
      // 끊김/흔들림 없이 부드럽게. scroll event listener 는 main thread 에 비동기로 도착해
      // cutout update 가 1-2 frame 늦음 → 사장님 눈에 lag/jitter. 대신 rAF loop 로 매 frame
      // 마다 element 위치 read + cutout update → element 와 cutout 이 같은 frame 에 paint
      // → desync 차단. 위치 변화 없으면 setAttribute skip (CPU 절약).
      // var 사용 — closeTour() 가 goTo(1) → IIFE 초기화 단계에서 호출되어 tourRafId/lastRectKey
      // 접근 시 let TDZ 위반으로 IIFE 전체 throw → + 버튼 listener 등록 누락 버그 (a7ffa4d 와 동일 패턴).
      var tourRafId = 0;
      var lastRectKey = '';
      function tourTick() {
        if (currentTourIdx == null) { tourRafId = 0; lastRectKey = ''; return; }
        const rect = calcCurrentRect();
        if (rect) {
          const key = rect.left + '|' + rect.top + '|' + rect.width + '|' + rect.height;
          if (key !== lastRectKey) {
            lastRectKey = key;
            placeSpotlight(rect);
            repositionTooltip(rect);
          }
        }
        tourRafId = requestAnimationFrame(tourTick);
      }
      function startTourTicker() {
        if (!tourRafId) tourRafId = requestAnimationFrame(tourTick);
      }
      function stopTourTicker() {
        if (tourRafId) { cancelAnimationFrame(tourRafId); tourRafId = 0; }
        lastRectKey = '';
      }

      function showTourStep(idx) {
        if (idx >= TOUR_STEPS.length) { closeTour(); return; }
        currentTourIdx = idx;
        // 매 frame rAF loop — scroll event 의 main thread async lag 없이 element 동기 추적
        lastRectKey = '';
        startTourTicker();
        const cur = TOUR_STEPS[idx];
        const els = cur.multi
          ? Array.from(document.querySelectorAll(cur.target))
          : [document.querySelector(cur.target)].filter(Boolean);
        if (!els.length) { showTourStep(idx + 1); return; }
        // 단계 진입 시 target 을 viewport 안에 자동 정렬 (사장님 굳이 스크롤 안 해도 보임).
        // multi 면 묶음 전체 center, single 이면 element center.
        if (cur.multi) {
          const rects0 = els.map(e => e.getBoundingClientRect());
          const groupTop = Math.min(...rects0.map(r => r.top));
          const groupBot = Math.max(...rects0.map(r => r.bottom));
          const groupCenterDoc = (groupTop + groupBot) / 2 + window.scrollY;
          window.scrollTo({ top: Math.max(0, groupCenterDoc - window.innerHeight / 2), behavior: 'instant' });
        } else {
          els[0].scrollIntoView({ behavior: 'instant', block: 'center' });
        }
        requestAnimationFrame(() => {
          const rect = calcCurrentRect();
          if (!rect) return;
          placeSpotlight(rect);
          placeTooltip(rect, cur, idx);
        });
      }
      function closeTour() {
        currentTourIdx = null;
        stopTourTicker();
        ['.tour-backdrop', '.tour-tooltip'].forEach(sel => {
          const el = document.querySelector(sel);
          if (!el) return;
          el.classList.add('is-closing');
          setTimeout(() => { try { el.remove(); } catch (_) {} }, 300);
        });
      }
      function startUploadTour() { showTourStep(0); }
      // 다른 step 진입 시 tour 자동 종료 처리는 goTo() 안에서 직접 closeTour() 호출.

      // Step 2 → Step 1 (topbar 뒤로)
      const backBtn = document.querySelector('[data-back-to-1]');
      if (backBtn) backBtn.addEventListener('click', () => goTo(1));

      // Step 2 게시 시점 토글 — [지금] / [예약] 중 active
      document.querySelectorAll('[data-schedule]').forEach(card => {
        card.addEventListener('click', () => {
          if (card.disabled) return;
          document.querySelectorAll('[data-schedule]').forEach(c => c.classList.remove('is-active'));
          card.classList.add('is-active');
        });
      });

      // Step 2 옵션 토글 — 스토리/날씨/쓰레드/링크 (실제 register-product 와 같은 마이크로 인터랙션)
      document.querySelectorAll('[data-toggle]').forEach(btn => {
        btn.addEventListener('click', () => {
          if (btn.disabled) return;
          const on = !btn.classList.contains('is-on');
          btn.classList.toggle('is-on', on);
          btn.setAttribute('aria-pressed', String(on));
        });
      });

      // 갤러리 sheet — Step 2 dropzone 클릭 시 슬라이드 업 모달로 표시
      const gallerySheet = document.querySelector('[data-gallery-sheet]');
      function openGallerySheet() {
        if (!gallerySheet) return;
        gallerySheet.classList.add('is-open');
        gallerySheet.setAttribute('aria-hidden', 'false');
      }
      function closeGallerySheet() {
        if (!gallerySheet) return;
        gallerySheet.classList.remove('is-open');
        gallerySheet.setAttribute('aria-hidden', 'true');
      }
      document.querySelectorAll('[data-open-gallery]').forEach(btn => {
        btn.addEventListener('click', openGallerySheet);
      });

      // 갤러리 안 사진 카드 토글 — iOS Photos 패턴 (선택 순서 번호 표시 + 카운터)
      //   selected 가 insertion-ordered Set 이라 size === 순서 + Array.from(selected).indexOf(id) 로 순번 추출.
      //   해제 시 뒤 번호들이 1씩 당겨지므로 매번 renderOrderBadges 로 전체 갱신.
      const counterEl = document.querySelector('[data-gallery-counter]');
      const coachBubble = document.querySelector('[data-coach-bubble]');
      const galleryDoneBtn = document.querySelector('[data-gallery-done]');
      function updateGalleryUI() {
        if (counterEl) {
          counterEl.textContent = `9장 중 ${selected.size}장 선택`;
        }
        if (galleryDoneBtn) galleryDoneBtn.disabled = selected.size === 0;
        if (coachBubble) coachBubble.hidden = selected.size > 0;
        const order = Array.from(selected);
        document.querySelectorAll('.gallery__card').forEach(card => {
          const id = card.dataset.photo;
          const idx = order.indexOf(id);
          const badge = card.querySelector('[data-order]');
          if (badge) badge.textContent = idx >= 0 ? String(idx + 1) : '';
        });
      }
      document.querySelectorAll('.gallery__card').forEach(card => {
        card.addEventListener('click', () => {
          const id = card.dataset.photo;
          if (selected.has(id)) {
            selected.delete(id);
            card.classList.remove('is-selected');
            card.setAttribute('aria-pressed', 'false');
          } else {
            if (selected.size >= MAX_PHOTOS) return;
            selected.add(id);
            card.classList.add('is-selected');
            card.setAttribute('aria-pressed', 'true');
          }
          updateGalleryUI();
        });
      });

      // 갤러리 "취소" — sheet 만 닫고 선택 초기화 (Step 2 화면 유지)
      const galleryCancel = document.querySelector('[data-gallery-cancel]');
      if (galleryCancel) {
        galleryCancel.addEventListener('click', () => {
          selected.forEach(id => {
            const card = document.querySelector(`.gallery__card[data-photo="${id}"]`);
            if (card) {
              card.classList.remove('is-selected');
              card.setAttribute('aria-pressed', 'false');
            }
          });
          selected.clear();
          updateGalleryUI();
          if (coachBubble) coachBubble.hidden = false;
          closeGallerySheet();
        });
      }

      // 갤러리 "완료" — sheet 닫고 dropzone 자리에 thumbs grid 표시 + CTA 활성
      const uploadDropzone = document.querySelector('.upload-dropzone[data-open-gallery]');
      const uploadThumbs = document.querySelector('[data-upload-thumbs]');
      const uploadThumbsEdit = document.querySelector('[data-thumbs-edit]');
      const submitUploadBtn = document.querySelector('[data-submit-upload]');
      function renderUploadThumbs() {
        if (!uploadThumbs) return;
        const photos = Array.from(selected);
        uploadThumbs.innerHTML = photos.map((id, i) =>
          `<div class="photo-thumbs__item" style="--idx:${i}">`
          + `<span class="photo-thumbs__bg gallery__bg gallery__bg--${id}"></span>`
          + `</div>`
        ).join('');
      }
      if (galleryDoneBtn) {
        galleryDoneBtn.addEventListener('click', () => {
          if (selected.size === 0) return;
          renderUploadThumbs();
          if (uploadDropzone) uploadDropzone.hidden = true;
          if (uploadThumbs) uploadThumbs.hidden = false;
          if (uploadThumbsEdit) uploadThumbsEdit.hidden = false;
          if (submitUploadBtn) submitUploadBtn.disabled = false;
          closeGallerySheet();
        });
      }

      // === Step 3: 9종 사진별 분석 데이터 ===
      // gallery aria-label / HANDOFF.md "분석 결과 9종 (Phase B 데이터셋)" 과 동기화.
      // 선택한 첫 번째 사진의 데이터를 분석 카드에 채움.
      const PHOTO_DATA = {
        'cafe-1': { subject: '라떼아트 · 우드 테이블',  mood: '따뜻함 · 평온함',    time: '오전 · 자연광',  color: '베이지 · 브라운', tone: '친근·서정 톤으로 갈게요' },
        'cafe-2': { subject: '케이크 · 디저트',         mood: '달콤함 · 휴식',       time: '오후 · 실내조명', color: '크림 · 연갈색',  tone: '달콤·여유 톤으로 갈게요' },
        'cafe-3': { subject: '마카롱 · 디저트 트레이',  mood: '달콤함 · 화사함',     time: '오후 · 자연광',  color: '파스텔 · 핑크',  tone: '화사·달콤 톤으로 갈게요' },
        'cafe-4': { subject: '크로플 · 황금색',         mood: '바삭함 · 달콤함',     time: '오전 · 자연광',  color: '황금 · 갈색',    tone: '활기·따뜻 톤으로 갈게요' },
        'cafe-5': { subject: '파스타 · 식사',           mood: '든든함 · 진한 맛',    time: '점심 · 실내조명', color: '빨강 · 노랑',    tone: '든든·정성 톤으로 갈게요' },
        'cafe-6': { subject: '샐러드 · 신선함',         mood: '깔끔함 · 건강함',     time: '점심 · 자연광',  color: '연두 · 노랑',    tone: '신선·깔끔 톤으로 갈게요' },
        'cafe-7': { subject: '빵 · 베이커리',           mood: '정성 · 따뜻함',       time: '오전 · 자연광',  color: '갈색 · 노랑',    tone: '담백·따뜻 톤으로 갈게요' },
        'cafe-8': { subject: '스무디 · 컬러풀',         mood: '산뜻함 · 에너지',     time: '오후 · 자연광',  color: '보라 · 핑크',    tone: '산뜻·발랄 톤으로 갈게요' },
        'cafe-9': { subject: '디저트 플레이팅 · 정성',  mood: '정성 · 솜씨',         time: '오후 · 실내조명', color: '파스텔 · 흰색',  tone: '정성·고요 톤으로 갈게요' },
      };

      // 사장님 결정 2026-05-17 (재정정): 9장 중 어떤 조합을 선택하든 그에 맞는 정성 캡션.
      // 단일 사진 → 9개 hand-crafted / 같은 카테고리 다중 → 묶음 캡션 / 혼합 → 종합 캡션 /
      // 메모 입력 시 첫 줄로 결합 / 해시태그 union (12개 cap).
      const PHOTO_CAPTIONS = {
        'cafe-1': { category: 'drink',
          text: '오늘 첫 잔, 결을 따라 천천히 그려봤어요.\n한 모금에 마음까지 따뜻해지는 시간.\n오전의 자리, 늘 비워두고 기다릴게요.',
          tags: ['#카페', '#라떼아트', '#오늘의한잔', '#카페일상', '#원두향', '#스페셜티커피'] },
        'cafe-2': { category: 'dessert',
          text: '한 조각에 잠깐 멈춰가는 오후.\n달콤한 한입이 오늘을 위로해 드릴 거예요.\n사진보다 더 폭신한 결, 직접 와서 잘라보세요.',
          tags: ['#카페', '#케이크', '#디저트카페', '#달콤한오후', '#케이크맛집'] },
        'cafe-3': { category: 'dessert',
          text: '오늘의 마카롱, 색이 더 곱게 나왔어요.\n한 알씩 골라 담는 재미가 작은 행복이에요.\n티 한 잔이랑 같이 즐기시면 더 좋아요.',
          tags: ['#카페', '#마카롱', '#디저트맛집', '#파스텔', '#마카롱맛집'] },
        'cafe-4': { category: 'dessert',
          text: '갓 구운 크로플, 결 사이로 바삭한 소리가 들려요.\n달콤한 한 조각에 오늘 아침이 환해져요.\n크림 듬뿍 올려서 따뜻할 때 드세요.',
          tags: ['#카페', '#크로플', '#브런치카페', '#모닝카페', '#크로플맛집'] },
        'cafe-5': { category: 'meal',
          text: '점심에는 한 그릇으로 든든하게.\n면 한 가닥마다 정성껏 비빈 우리 집 파스타예요.\n오늘의 한 끼, 천천히 즐기다 가세요.',
          tags: ['#카페', '#파스타', '#점심맛집', '#브런치', '#파스타맛집', '#식사카페'] },
        'cafe-6': { category: 'meal',
          text: '오늘 아침에 받은 채소, 그대로 담아냈어요.\n가벼운 한 그릇이 몸을 깨워줘요.\n건강 챙기는 분들께 추천드려요.',
          tags: ['#카페', '#샐러드', '#건강한식사', '#브런치카페', '#샐러드맛집', '#신선한채소'] },
        'cafe-7': { category: 'bakery',
          text: '이른 아침부터 구워낸 오늘의 빵이에요.\n한 입 베어 물면 정성이 느껴지실 거예요.\n따끈할 때 만나러 들러주세요.',
          tags: ['#카페', '#빵', '#베이커리', '#수제빵', '#빵맛집'] },
        'cafe-8': { category: 'drink',
          text: '한 잔에 과일 한가득, 오늘의 산뜻한 한 모금.\n색만 봐도 기분이 살아나죠.\n오후의 텁텁함은 이걸로 깨워보세요.',
          tags: ['#카페', '#스무디', '#건강음료', '#스무디맛집', '#여름음료'] },
        'cafe-9': { category: 'dessert',
          text: '한 접시에 담은 오늘의 작은 순간들.\n보기에도 예쁘고 맛도 정성이에요.\n사진 한 장으로 남겨가셔도 좋아요.',
          tags: ['#카페', '#디저트', '#플레이팅', '#감성카페', '#디저트맛집', '#카페추천'] },
      };
      const CATEGORY_MULTI = {
        drink: {
          text: '오늘의 한 잔, 골라 드시는 재미.\n따끈한 라떼부터 산뜻한 스무디까지\n원하시는 잔으로 채워드릴게요.',
          tags: ['#카페', '#카페음료', '#오늘의한잔', '#커피', '#스무디', '#카페추천'] },
        dessert: {
          text: '오늘은 디저트 한 트레이로.\n조각마다 다른 단맛, 골라 드시는 즐거움이에요.\n티 한 잔이랑 함께 천천히 즐기세요.',
          tags: ['#카페', '#디저트', '#디저트맛집', '#디저트카페', '#디저트모음', '#감성카페'] },
        meal: {
          text: '오늘 한 끼, 가볍게도 든든하게도.\n파스타로 속을 채우고 샐러드로 마무리.\n점심부터 저녁까지 편하게 들러주세요.',
          tags: ['#카페', '#점심맛집', '#브런치', '#한끼', '#파스타', '#샐러드'] },
        bakery: {
          text: '오늘 구운 빵을 한 자리에 모았어요.\n결마다 다른 향이 가게에 가득해요.\n따끈할 때 골라가시면 더 좋아요.',
          tags: ['#카페', '#빵', '#베이커리', '#수제빵', '#빵맛집', '#베이커리카페'] },
        mixed: {
          text: '오늘은 한 자리에서 다양하게.\n음료부터 디저트, 한 끼까지 골고루 준비했어요.\n천천히 둘러보시고 마음에 드는 메뉴 찾아보세요.',
          tags: ['#카페', '#카페추천', '#카페일상', '#감성카페', '#카페투어', '#오늘의카페'] },
      };
      function buildTutorialCaption(photoIds, memo) {
        const memoLine = (memo && memo.trim()) ? memo.trim() + '\n\n' : '';
        if (photoIds.length === 1) {
          const c = PHOTO_CAPTIONS[photoIds[0]] || PHOTO_CAPTIONS['cafe-1'];
          return memoLine + c.text + '\n\n' + c.tags.join(' ');
        }
        const cats = new Set(photoIds.map(id => PHOTO_CAPTIONS[id]?.category).filter(Boolean));
        let groupText, baseTags;
        if (cats.size === 1) {
          const grp = CATEGORY_MULTI[[...cats][0]] || CATEGORY_MULTI.mixed;
          groupText = grp.text; baseTags = grp.tags;
        } else {
          groupText = CATEGORY_MULTI.mixed.text; baseTags = CATEGORY_MULTI.mixed.tags;
        }
        const tagSet = new Set(baseTags);
        // 혼합이면 사진별 첫 3개 tag만, 같은 카테고리면 전부 union (12 cap)
        const perPhotoSlice = cats.size === 1 ? 99 : 3;
        photoIds.forEach(id => PHOTO_CAPTIONS[id]?.tags?.slice(0, perPhotoSlice).forEach(t => tagSet.add(t)));
        const tags = Array.from(tagSet).slice(0, 12);
        return memoLine + groupText + '\n\n' + tags.join(' ');
      }
      let typewriterTimer;

      function typewrite(text, target) {
        if (typewriterTimer) clearInterval(typewriterTimer);
        target.textContent = '';
        target.classList.remove('is-done');
        let i = 0;
        typewriterTimer = setInterval(() => {
          target.textContent += text[i];
          i++;
          if (i >= text.length) {
            clearInterval(typewriterTimer);
            typewriterTimer = null;
            target.classList.add('is-done');
            const next3 = document.querySelector('[data-next-3]');
            if (next3) next3.disabled = false;
          }
        }, 35);
      }

      // progress-overlay 시퀀스 — register-product 의 실제 흐름과 동일
      // upload (활성) → 1.0s → done · analyze (활성) → 1.1s → done · caption (활성) → 1.2s → done · 0.4s fade-out
      function runProgressSequence(overlay, onDone) {
        if (!overlay) { onDone && onDone(); return; }
        const steps = overlay.querySelectorAll('[data-tprog-step]');
        steps.forEach(s => s.classList.remove('is-active', 'is-done'));
        overlay.classList.add('is-open');
        overlay.setAttribute('aria-hidden', 'false');

        const order = ['upload', 'analyze', 'caption'];
        const durations = [1000, 1100, 1200];
        let idx = 0;
        const lit = (key, cls) => {
          const el = overlay.querySelector('[data-tprog-step="' + key + '"]');
          if (el) el.classList.add(cls);
        };
        lit(order[0], 'is-active');
        const tick = () => {
          const cur = order[idx];
          overlay.querySelector('[data-tprog-step="' + cur + '"]').classList.remove('is-active');
          lit(cur, 'is-done');
          idx++;
          if (idx >= order.length) {
            setTimeout(() => {
              overlay.classList.remove('is-open');
              overlay.setAttribute('aria-hidden', 'true');
              onDone && onDone();
            }, 400);
            return;
          }
          lit(order[idx], 'is-active');
          setTimeout(tick, durations[idx]);
        };
        setTimeout(tick, durations[0]);
      }

      // 카루셀 셋업 (사진 N장 자동 슬라이드 + 점 인디케이터 + 사용자 스와이프)
      function setupCarousel(carouselEl, dotsEl, photoIds, autoMs) {
        autoMs = autoMs || 1800;
        if (!carouselEl) return;
        carouselEl.innerHTML = photoIds
          .map(id => '<div class="analyze-slide gallery__bg--' + id + '"></div>')
          .join('');
        if (dotsEl) {
          dotsEl.innerHTML = photoIds.length > 1
            ? photoIds.map((_, i) => '<span class="analyze-dot' + (i === 0 ? ' is-active' : '') + '"></span>').join('')
            : '';
        }
        let timer;
        if (photoIds.length > 1) {
          let idx = 0;
          timer = setInterval(() => {
            idx = (idx + 1) % photoIds.length;
            carouselEl.scrollTo({ left: idx * carouselEl.clientWidth, behavior: 'smooth' });
          }, autoMs);
        }
        carouselEl.addEventListener('touchstart', () => {
          if (timer) { clearInterval(timer); timer = null; }
        }, { passive: true });
        carouselEl.addEventListener('scroll', () => {
          if (!dotsEl) return;
          const i = Math.round(carouselEl.scrollLeft / carouselEl.clientWidth);
          dotsEl.querySelectorAll('.analyze-dot').forEach((d, di) => {
            d.classList.toggle('is-active', di === i);
          });
        }, { passive: true });
      }

      // Step 2 → Step 3 — CTA "캡션 만들고 게시" 클릭 (사진 선택 완료 후 활성)
      if (submitUploadBtn) {
        submitUploadBtn.addEventListener('click', () => {
          if (selected.size === 0) return;
          goTo(3);

          const photos = Array.from(selected);
          setupCarousel(
            document.querySelector('[data-analyze-carousel]'),
            document.querySelector('[data-analyze-dots]'),
            photos,
          );

          // 첫 번째 선택 사진의 분석 데이터로 카드 채움 (PHOTO_DATA — HANDOFF Phase B 데이터셋)
          const firstId = photos[0];
          const data = PHOTO_DATA[firstId] || PHOTO_DATA['cafe-1'];
          const setText = (sel, val) => {
            const el = document.querySelector(sel);
            if (el && val != null) el.textContent = val;
          };
          setText('[data-analyze-subject]', data.subject);
          setText('[data-analyze-mood]',    data.mood);
          setText('[data-analyze-time]',    data.time);
          setText('[data-analyze-color]',   data.color);
          setText('[data-analyze-tone]',    data.tone);

          const label = document.querySelector('[data-analyze-label]');
          if (label) {
            label.textContent = photos.length > 1
              ? `루미가 사진 ${photos.length}장을 보고 있어요`
              : '루미가 보고 있어요';
          }

          const captionEl = document.querySelector('[data-caption]');
          const next3 = document.querySelector('[data-next-3]');
          if (next3) next3.disabled = true;
          if (captionEl) captionEl.textContent = '';

          // 사장님 결정 2026-05-17: 선택 사진 + 메모 기반 정성 캡션 (튜토리얼이라도 production-grade).
          const memoText = (document.querySelector('#tutorial-memo')?.value || '').trim();
          const tutorialCaption = buildTutorialCaption(photos, memoText);

          // progress-overlay 시퀀스 (~3.7s) 끝나면 typewriter 시작.
          // 사장님 디바이스에서 마스코트 + 단계별 체크가 실제 register-product 와 동일하게 보이도록.
          const overlay = document.querySelector('[data-tutorial-progress]');
          runProgressSequence(overlay, () => {
            if (captionEl) typewrite(tutorialCaption, captionEl);
          });
          // step 4 (결과 카드) 의 res__caption 도 같은 캡션. step 4 진입 시 다시 set 안 하면
          // 옛 hard-coded 라떼 카피 그대로. step 3 시점에 미리 prepare → step 4 진입 시 적용.
          window.__lumiTutorialCaption = tutorialCaption;
        });
      }

      // Step 3 → Step 4 (결과)
      const next3Btn = document.querySelector('[data-next-3]');
      if (next3Btn) {
        next3Btn.addEventListener('click', () => {
          goTo(4);

          // 결과 카드에도 같은 사진들 캐러셀
          const photos = Array.from(selected);
          setupCarousel(
            document.querySelector('[data-result-carousel]'),
            document.querySelector('[data-result-dots]'),
            photos,
          );

          // 결과 카드의 res__caption — step 3 에서 생성한 동일 캡션으로 교체
          // (옛 hard-coded "오늘도 천천히 흘러가는 시간을 한 잔에..." 라떼 카피 차단).
          const resCaption = document.querySelector('.result-step .res__caption');
          if (resCaption && window.__lumiTutorialCaption) {
            resCaption.textContent = window.__lumiTutorialCaption;
          }

          // 카운트 업 (진입 후 잠시 뒤)
          setTimeout(() => {
            document.querySelectorAll('[data-count]').forEach(el => {
              const target = parseInt(el.dataset.count, 10);
              countUp(el, target);
            });
          }, 400);
        });
      }

      // Step 4 → Step 5 (가입)
      const next4Btn = document.querySelector('[data-next-4]');
      if (next4Btn) {
        next4Btn.addEventListener('click', () => goTo(5));
      }

      // 카운트 업 애니메이션 (ease-out cubic)
      function countUp(el, target, duration) {
        duration = duration || 1200;
        const start = 0;
        const startTime = performance.now();
        function tick(now) {
          const elapsed = now - startTime;
          const progress = Math.min(elapsed / duration, 1);
          const eased = 1 - Math.pow(1 - progress, 3);
          el.textContent = Math.floor(start + (target - start) * eased).toLocaleString();
          if (progress < 1) requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      }

      // 건너뛰기 → 가입 페이지로 점프
      document.querySelectorAll('.skip, .home-skip').forEach(btn => {
        btn.addEventListener('click', () => goTo(TOTAL));
      });
    })();
