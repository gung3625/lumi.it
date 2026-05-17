    (function () {
      const C = window.LumiCategories;

      // 0) URL hash 의 lumi_token + lumi_refresh (카카오 callback 직후) → localStorage 저장.
      //    audit #2: refresh token 도 받아서 자동 갱신 가능하게.
      try {
        if (location.hash && location.hash.indexOf('lumi_token=') !== -1) {
          const params = new URLSearchParams(location.hash.replace(/^#/, ''));
          const t = params.get('lumi_token');
          const rt = params.get('lumi_refresh');
          if (t) localStorage.setItem('lumi-auth', t);
          if (rt) localStorage.setItem('lumi_refresh', rt);
          history.replaceState(null, '', location.pathname);
        }
      } catch (_) {}

      const token = localStorage.getItem('lumi-auth') || localStorage.getItem('lumi_auth') || localStorage.getItem('seller_jwt') || '';
      const authHeaders = token ? { Authorization: 'Bearer ' + token } : {};

      // 토큰 없으면 홈으로
      if (!token) {
        location.replace('/');
        return;
      }

      const state = {
        step: 1,
        storeName: '',
        majorId: '',
        sub: '',
        region: '',
        phone: '',
        skipPhoneStep: false,
        igChecks: { 1: false, 2: false, 3: false },
      };

      const stepsEl = document.querySelectorAll('.step');
      const dotsEl = document.querySelectorAll('.steps-dot');

      function showStep(n) {
        state.step = n;
        stepsEl.forEach(el => el.classList.toggle('is-active', Number(el.dataset.step) === n));
        dotsEl.forEach(d => {
          const num = Number(d.dataset.dot);
          d.classList.toggle('is-active', num === n);
          d.classList.toggle('is-done', num < n);
        });
        window.scrollTo({ top: 0, behavior: 'instant' });
      }

      // ── 지역 (시도 + 구군) ──
      const REGIONS = {
        '서울특별시': ['강남구','강동구','강북구','강서구','관악구','광진구','구로구','금천구','노원구','도봉구','동대문구','동작구','마포구','서대문구','서초구','성동구','성북구','송파구','양천구','영등포구','용산구','은평구','종로구','중구','중랑구'],
        '부산광역시': ['강서구','금정구','기장군','남구','동구','동래구','부산진구','북구','사상구','사하구','서구','수영구','연제구','영도구','중구','해운대구'],
        '인천광역시': ['강화군','계양구','남동구','동구','미추홀구','부평구','서구','연수구','옹진군','중구'],
        '대구광역시': ['군위군','남구','달서구','달성군','동구','북구','서구','수성구','중구'],
        '광주광역시': ['광산구','남구','동구','북구','서구'],
        '대전광역시': ['대덕구','동구','서구','유성구','중구'],
        '울산광역시': ['남구','동구','북구','울주군','중구'],
        '세종특별자치시': ['세종시'],
        '경기도': ['가평군','고양시','과천시','광명시','광주시','구리시','군포시','김포시','남양주시','동두천시','부천시','성남시','수원시','시흥시','안산시','안성시','안양시','양주시','양평군','여주시','연천군','오산시','용인시','의왕시','의정부시','이천시','파주시','평택시','포천시','하남시','화성시'],
        '강원특별자치도': ['강릉시','고성군','동해시','삼척시','속초시','양구군','양양군','영월군','원주시','인제군','정선군','철원군','춘천시','태백시','평창군','홍천군','화천군','횡성군'],
        '충청북도': ['괴산군','단양군','보은군','영동군','옥천군','음성군','제천시','증평군','진천군','청주시','충주시'],
        '충청남도': ['계룡시','공주시','금산군','논산시','당진시','보령시','부여군','서산시','서천군','아산시','예산군','천안시','청양군','태안군','홍성군'],
        '전북특별자치도': ['고창군','군산시','김제시','남원시','무주군','부안군','순창군','완주군','익산시','임실군','장수군','전주시','정읍시','진안군'],
        '전라남도': ['강진군','고흥군','곡성군','광양시','구례군','나주시','담양군','목포시','무안군','보성군','순천시','신안군','여수시','영광군','영암군','완도군','장성군','장흥군','진도군','함평군','해남군','화순군'],
        '경상북도': ['경산시','경주시','고령군','구미시','김천시','문경시','봉화군','상주시','성주군','안동시','영덕군','영양군','영주시','영천시','예천군','울릉군','울진군','의성군','청도군','청송군','칠곡군','포항시'],
        '경상남도': ['거제시','거창군','고성군','김해시','남해군','밀양시','사천시','산청군','양산시','의령군','진주시','창녕군','창원시','통영시','하동군','함안군','함양군','합천군'],
        '제주특별자치도': ['서귀포시','제주시'],
      };
      const sidoEl = document.querySelector('[data-region-sido]');
      const gugunEl = document.querySelector('[data-region-gugun]');
      // 시도 옵션 채움
      Object.keys(REGIONS).forEach(sido => {
        const opt = document.createElement('option');
        opt.value = sido;
        opt.textContent = sido;
        sidoEl.appendChild(opt);
      });
      function updateRegionState() {
        const sido = sidoEl.value;
        const gugun = gugunEl.value;
        state.region = (sido && gugun) ? `${sido} ${gugun}` : '';
      }
      sidoEl.addEventListener('change', () => {
        const sido = sidoEl.value;
        gugunEl.innerHTML = '<option value="">구·군 선택</option>';
        if (sido && REGIONS[sido]) {
          REGIONS[sido].forEach(g => {
            const opt = document.createElement('option');
            opt.value = g;
            opt.textContent = g;
            gugunEl.appendChild(opt);
          });
          gugunEl.disabled = false;
        } else {
          gugunEl.disabled = true;
        }
        updateRegionState();
      });
      gugunEl.addEventListener('change', updateRegionState);

      // 대분류 그리드 렌더
      const majorGrid = document.querySelector('[data-major-grid]');
      majorGrid.innerHTML = C.MAJOR_GROUPS.map(g =>
        `<button class="major-card" type="button" data-major="${g.id}">${g.label}</button>`
      ).join('');
      const subChipsEl = document.querySelector('[data-sub-chips]');
      const subHintEl = document.querySelector('[data-sub-hint]');

      majorGrid.querySelectorAll('.major-card').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.major;
          state.majorId = id;
          state.sub = '';
          majorGrid.querySelectorAll('.major-card').forEach(b => b.classList.toggle('is-active', b.dataset.major === id));
          renderSubChips();
        });
      });

      function renderSubChips() {
        const group = C.findGroup(state.majorId);
        if (!group || !group.subs.length) {
          subChipsEl.classList.add('is-hidden');
          subHintEl.style.display = '';
          return;
        }
        subHintEl.style.display = 'none';
        subChipsEl.classList.remove('is-hidden');
        // sub 1개면 자동 선택 (운동·레저)
        if (group.subs.length === 1) state.sub = group.subs[0].id;
        subChipsEl.innerHTML = group.subs.map(s =>
          `<button class="sub-chip${s.id === state.sub ? ' is-active' : ''}" type="button" data-sub="${s.id}">${s.label}</button>`
        ).join('');
        subChipsEl.querySelectorAll('.sub-chip').forEach(chip => {
          chip.addEventListener('click', () => {
            state.sub = chip.dataset.sub;
            subChipsEl.querySelectorAll('.sub-chip').forEach(c => c.classList.toggle('is-active', c.dataset.sub === state.sub));
          });
        });
      }

      // phone 입력 자동 하이픈
      const phoneInput = document.getElementById('phone');
      function formatPhone(raw) {
        const d = String(raw || '').replace(/\D/g, '').slice(0, 11);
        if (d.length < 4) return d;
        if (d.length < 8) return d.slice(0, 3) + '-' + d.slice(3);
        return d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7);
      }
      phoneInput.addEventListener('input', () => {
        phoneInput.value = formatPhone(phoneInput.value);
        state.phone = phoneInput.value.replace(/\D/g, '');
      });

      // step 1 검증
      function validateStep1() {
        const name = document.getElementById('store-name').value.trim();
        const errEl = document.querySelector('[data-step1-err]');
        if (name.length < 1 || name.length > 50) {
          errEl.textContent = '매장 이름을 1~50자로 입력해주세요.';
          return false;
        }
        if (!state.region) {
          errEl.textContent = '매장 지역을 선택해주세요.';
          return false;
        }
        if (!state.majorId || !state.sub) {
          errEl.textContent = '업종을 선택해주세요.';
          return false;
        }
        state.storeName = name;
        errEl.textContent = '';
        return true;
      }

      // step 2 검증
      function validateStep2() {
        const errEl = document.querySelector('[data-step2-err]');
        if (!/^010\d{7,8}$/.test(state.phone)) {
          errEl.textContent = '010으로 시작하는 11자리 숫자로 입력해주세요.';
          return false;
        }
        errEl.textContent = '';
        return true;
      }

      // signup-complete 호출 — phone 은 카카오에서 받은 게 있으면 생략(서버가 DB 값 유지)
      async function submitSignupComplete() {
        const payload = {
          store_name: state.storeName,
          industry: state.sub,
          // 약관·개인정보 동의 (필수). 마케팅은 선택. 서버가 시각으로 저장.
          consents: state.consents || {},
        };
        if (state.phone) payload.phone = state.phone;
        if (state.region) payload.region = state.region;
        const res = await fetch('/api/signup-complete', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(json.error || '저장에 실패했습니다.');
        }
        return json;
      }

      // ── 동의 체크박스 ──
      const consentAllEl = document.querySelector('[data-consent-all]');
      const consentTermsEl = document.querySelector('[data-consent="terms"]');
      const consentPrivacyEl = document.querySelector('[data-consent="privacy"]');
      const consentMarketingEl = document.querySelector('[data-consent="marketing"]');
      const step1NextBtn = document.querySelector('[data-step="1"] [data-next]');

      function refreshConsentState() {
        // 필수 두 개 모두 체크돼야 다음 버튼 활성
        const allRequired = consentTermsEl.checked && consentPrivacyEl.checked;
        if (step1NextBtn) {
          step1NextBtn.disabled = !allRequired;
          step1NextBtn.classList.toggle('is-ready', allRequired);
        }
        // 전체동의 상태 동기화
        if (consentAllEl) {
          consentAllEl.checked = consentTermsEl.checked && consentPrivacyEl.checked && consentMarketingEl.checked;
        }
        state.consents = {
          terms: consentTermsEl.checked,
          privacy: consentPrivacyEl.checked,
          marketing: consentMarketingEl.checked,
        };
      }
      [consentTermsEl, consentPrivacyEl, consentMarketingEl].forEach(el => {
        if (el) el.addEventListener('change', refreshConsentState);
      });
      if (consentAllEl) {
        consentAllEl.addEventListener('change', () => {
          consentTermsEl.checked = consentAllEl.checked;
          consentPrivacyEl.checked = consentAllEl.checked;
          consentMarketingEl.checked = consentAllEl.checked;
          refreshConsentState();
        });
      }
      refreshConsentState();

      // 다음/이전 버튼
      document.querySelectorAll('[data-next]').forEach(btn => {
        btn.addEventListener('click', async () => {
          let target = Number(btn.dataset.next);
          if (state.step === 1) {
            if (!validateStep1()) return;
            // 카카오에서 이미 폰 받았으면 step 2 스킵 → step 1 에서 바로 signup-complete + step 3
            if (state.skipPhoneStep) {
              btn.disabled = true;
              btn.textContent = '저장 중…';
              try {
                await submitSignupComplete();
              } catch (e) {
                document.querySelector('[data-step1-err]').textContent = e.message;
                btn.disabled = false;
                btn.textContent = '다음';
                return;
              }
              btn.disabled = false;
              btn.textContent = '다음';
              target = 3;
              setDoneTitle();
            }
          }
          if (state.step === 2) {
            if (!validateStep2()) return;
            // step 2 → 3 이동 시점에 signup-complete 저장 (필수 정보 다 모임)
            btn.disabled = true;
            btn.textContent = '저장 중…';
            try {
              await submitSignupComplete();
            } catch (e) {
              document.querySelector('[data-step2-err]').textContent = e.message;
              btn.disabled = false;
              btn.textContent = '다음';
              return;
            }
            btn.disabled = false;
            btn.textContent = '다음';
          }
          showStep(target);
        });
      });
      document.querySelectorAll('[data-prev]').forEach(btn => {
        btn.addEventListener('click', () => showStep(Number(btn.dataset.prev)));
      });

      // IG 마법사 체크박스
      const igConnectBtn = document.querySelector('[data-ig-connect]');
      function refreshIgConnect() {
        const allDone = state.igChecks[1] && state.igChecks[2] && state.igChecks[3];
        igConnectBtn.disabled = !allDone;
        igConnectBtn.classList.toggle('is-ready', allDone);
      }
      document.querySelectorAll('[data-ig-check]').forEach(btn => {
        btn.addEventListener('click', () => {
          const n = Number(btn.dataset.igCheck);
          state.igChecks[n] = !state.igChecks[n];
          btn.classList.toggle('is-checked', state.igChecks[n]);
          btn.textContent = state.igChecks[n] ? '✓ 완료' : (n === 1 ? '✓ 됐어요' : (n === 2 ? '✓ 만들었어요' : '✓ 다 됐어요'));
          document.querySelector(`[data-ig-step="${n}"]`).classList.toggle('is-done', state.igChecks[n]);
          refreshIgConnect();
        });
      });

      // S1 (2026-05-15): OAuth 시작 시 token 을 URL query 가 아닌 POST body 로 전송.
      // 응답 JSON 의 url 로 location.href → Facebook/Threads OAuth URL 만 노출, JWT 보호.
      async function startOAuth(endpoint, returnTo) {
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ token, return_to: returnTo }),
          });
          const j = await res.json().catch(() => ({}));
          if (res.ok && j.url) {
            location.href = j.url;
          } else {
            location.href = '/dashboard?oauth_error=1';
          }
        } catch (e) {
          location.href = '/dashboard?oauth_error=1';
        }
      }
      igConnectBtn.addEventListener('click', () => startOAuth('/api/ig-oauth', '/signup'));
      document.querySelector('[data-threads-connect]').addEventListener('click', () =>
        startOAuth('/api/threads-oauth', '/signup'));

      // 나중에 — sellers.onboarded=true 박은 후 step 4 (다음 로그인 시 dashboard 직행)
      document.querySelector('[data-ig-skip]').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const orig = btn.textContent;
        btn.disabled = true;
        btn.textContent = '저장 중…';
        try {
          await fetch('/api/signup-skip-ig', { method: 'POST', headers: authHeaders });
        } catch (_) { /* 실패해도 UI 는 진행 — 다음 로그인에서 다시 step 3 으로 옴 */ }
        btn.disabled = false;
        btn.textContent = orig;
        setDoneTitle();
        showStep(4);
      });

      // 완료 화면 → dashboard
      document.querySelector('[data-go-dashboard]').addEventListener('click', () => {
        location.href = '/dashboard';
      });

      // 완료 메시지 채우기
      function setDoneTitle() {
        const t = document.querySelector('[data-done-title]');
        if (t && state.storeName) t.textContent = state.storeName + '님, 환영해요';
      }
      document.querySelectorAll('[data-next="3"]').forEach(b => b.addEventListener('click', setDoneTitle));

      // /api/me 호출 — 카카오에서 자동 채워진 store_name / phone 감지
      (async function detectPrefill() {
        try {
          const r = await fetch('/api/me', { headers: authHeaders });
          if (!r.ok) return;
          const data = await r.json();
          const seller = data.seller || data;
          // store_name 미리 채움 (있으면)
          if (seller.storeName || seller.store_name) {
            document.getElementById('store-name').value = seller.storeName || seller.store_name;
            state.storeName = document.getElementById('store-name').value;
            const nameInput = document.getElementById('store-name');
            nameInput.classList.add('is-prefilled');
            setTimeout(() => nameInput.classList.remove('is-prefilled'), 1200);
          }
          // phone 이 카카오에서 이미 채워졌으면 step 2 자체 스킵
          if (seller.hasPhone) {
            state.skipPhoneStep = true;
            const dot2 = document.querySelector('[data-dot="2"]');
            if (dot2) dot2.style.display = 'none';
          }
          // 이전에 step 1-2 끝내고 IG 단계에서 이탈했던 경우 → step 3 으로 점프
          if (seller.signupCompleted && !seller.onboarded) {
            // industry/sub 도 state 에 복원 (signup-complete 호출은 이미 됐지만 방어적으로)
            if (seller.industry) state.sub = seller.industry;
            setDoneTitle();
            showStep(3);
          }
        } catch (_) {}
      })();

      // Threads OAuth 콜백 결과 — 성공/에러 모두 처리.
      // 코드 리뷰 #5 — threads-oauth.js 가 nonce 의 returnTo 기반으로 에러도
      // 같은 페이지로 돌려줌 (signup 에서 시작했으면 signup 으로).
      (function handleThreadsReturn() {
        const qs = new URLSearchParams(location.search);
        if (qs.get('threads') === 'connected') {
          alert('쓰레드 연동이 완료됐어요.');
          history.replaceState(null, '', location.pathname);
        } else if (qs.has('threads_oauth_error')) {
          const code = qs.get('threads_oauth_error');
          const msg = ({
            '1':  '로그인 토큰이 만료됐어요. 다시 시도해주세요.',
            '2':  '쓰레드 인증이 끊겼어요.',
            '3':  '쓰레드 계정 정보를 가져오지 못했어요.',
            '4':  '세션이 만료됐어요. 다시 시도해주세요.',
            '5':  '저장에 실패했어요.',
            '6':  '저장에 실패했어요.',
            '10': '쓰레드 연동은 인스타 연동 후에 가능해요.',
          })[code] || '쓰레드 연동에 실패했어요.';
          alert(msg);
          history.replaceState(null, '', location.pathname);
        }
      })();
    })();
