    (function () {
      const token =
        localStorage.getItem('lumi-auth') ||
        localStorage.getItem('lumi_auth') ||
        localStorage.getItem('seller_jwt') || '';
      if (!token) { location.replace('/'); return; }
      const authHeaders = { Authorization: 'Bearer ' + token };

      // S1 (2026-05-15): OAuth 시작 시 token 을 URL query 가 아닌 POST body 로.
      // 응답 JSON 의 url 로 location.href → Facebook/Threads OAuth URL 만 노출, JWT 보호.
      async function startSocialOAuth(endpoint, returnTo) {
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
            toast('OAuth 시작 실패. 다시 시도해주세요.');
          }
        } catch (e) {
          toast('네트워크 오류. 다시 시도해주세요.');
        }
      }
      const C = window.LumiCategories;

      const toastEl = document.querySelector('[data-toast]');
      function toast(msg, ms = 1800) {
        toastEl.textContent = msg;
        toastEl.classList.add('is-open');
        setTimeout(() => toastEl.classList.remove('is-open'), ms);
      }

      // HTML escape — store_name 등 사용자 입력을 innerHTML 에 삽입 전 항상 통과.
      // attribute (value="..." 안 포함) 까지 안전하도록 &/<>/"/' 모두 처리.
      function esc(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      const seller = {};

      function setRow(name, value) {
        const row = document.querySelector(`[data-row="${name}"]`);
        if (!row) return;
        row.querySelector('[data-display]').textContent = value || '—';
      }
      function categoryLabel(sub) {
        if (!sub) return '—';
        return (C.SUB_LABEL && C.SUB_LABEL[sub]) || sub;
      }

      // ── 매장 정보 인라인 편집 ──
      function openEdit(rowName) {
        const row = document.querySelector(`[data-row="${rowName}"]`);
        if (!row) return;
        const current = (seller[rowName === 'storeName' ? 'store_name' : rowName] || '').toString();
        row.innerHTML = `
          <span class="row__label">${rowName === 'storeName' ? '매장 이름' : '휴대폰'}</span>
          <input class="row__input" type="${rowName === 'phone' ? 'tel' : 'text'}" maxlength="${rowName === 'phone' ? 13 : 50}" value="${esc(current)}" data-input>
          <button class="row__save" type="button" data-save>저장</button>
          <button class="row__cancel" type="button" data-cancel>취소</button>
        `;
        const input = row.querySelector('[data-input]');
        input.focus();
        if (rowName === 'phone') {
          input.addEventListener('input', () => {
            const d = input.value.replace(/\D/g, '').slice(0, 11);
            input.value = d.length < 4 ? d : d.length < 8 ? d.slice(0,3)+'-'+d.slice(3) : d.slice(0,3)+'-'+d.slice(3,7)+'-'+d.slice(7);
          });
        }
        row.querySelector('[data-cancel]').addEventListener('click', () => renderInfo());
        row.querySelector('[data-save]').addEventListener('click', async () => {
          const val = input.value.trim();
          const camelKey = rowName;
          const payload = {};
          payload[camelKey] = rowName === 'phone' ? val.replace(/\D/g, '') : val;
          try {
            const res = await fetch('/api/update-profile', {
              method: 'POST',
              headers: { ...authHeaders, 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json.error || '저장 실패');
            seller[rowName === 'storeName' ? 'store_name' : rowName] = payload[camelKey];
            renderInfo();
            toast('저장되었어요');
          } catch (e) {
            toast(e.message || '저장 실패');
          }
        });
      }

      function renderInfo() {
        const card = document.querySelector('[data-info-card]');
        card.innerHTML = `
          <div class="row" data-row="storeName">
            <span class="row__label">매장 이름</span>
            <span class="row__value" data-display>${esc(seller.store_name || '—')}</span>
            <button class="row__edit" type="button" data-edit-name>수정</button>
          </div>
          <div class="row" data-row="industry">
            <span class="row__label">업종</span>
            <span class="row__value" data-display>${esc(categoryLabel(seller.industry))}</span>
            <button class="row__edit" type="button" data-edit-industry>수정</button>
          </div>
          <div class="row" data-row="region">
            <span class="row__label">지역</span>
            <span class="row__value${seller.region ? '' : ' row__value--missing'}" data-display>${esc(seller.region || '미설정 — 트렌드·날씨를 위해 설정해주세요')}</span>
            <button class="row__edit" type="button" data-edit-region>수정</button>
          </div>
          <div class="row" data-row="phone">
            <span class="row__label">휴대폰</span>
            <span class="row__value" data-display>${esc(seller.phone || seller.phoneMasked || '—')}</span>
            <button class="row__edit" type="button" data-edit-phone>수정</button>
          </div>
        `;
        card.querySelector('[data-edit-name]').addEventListener('click', () => openEdit('storeName'));
        card.querySelector('[data-edit-phone]').addEventListener('click', () => openEdit('phone'));
        card.querySelector('[data-edit-industry]').addEventListener('click', openIndustryModal);
        card.querySelector('[data-edit-region]').addEventListener('click', openRegionModal);
      }

      // ── 업종 변경 모달 ──
      const modal = document.querySelector('[data-modal]');
      const modalBackdrop = document.querySelector('[data-modal-backdrop]');
      const modalClose = document.querySelector('[data-modal-close]');
      const majorGrid = document.querySelector('[data-major-grid]');
      const subChipsEl = document.querySelector('[data-sub-chips]');
      const industrySaveBtn = document.querySelector('[data-industry-save]');
      let modalState = { major: '', sub: '' };

      function openIndustryModal() {
        const cur = seller.industry;
        modalState.major = cur ? (C.SUB_TO_MAJOR[cur] || '') : '';
        modalState.sub = cur || '';
        renderMajor();
        renderSubs();
        refreshSaveBtn();
        modal.classList.add('is-open');
        modalBackdrop.classList.add('is-open');
        document.body.style.overflow = 'hidden';
      }
      function closeIndustryModal() {
        modal.classList.remove('is-open');
        modalBackdrop.classList.remove('is-open');
        document.body.style.overflow = '';
      }
      modalClose.addEventListener('click', closeIndustryModal);
      modalBackdrop.addEventListener('click', closeIndustryModal);

      function renderMajor() {
        majorGrid.innerHTML = C.MAJOR_GROUPS.map(g =>
          `<button class="major-card${g.id === modalState.major ? ' is-active' : ''}" type="button" data-major="${g.id}">${g.label}</button>`
        ).join('');
        majorGrid.querySelectorAll('.major-card').forEach(b => {
          b.addEventListener('click', () => {
            modalState.major = b.dataset.major;
            const group = C.findGroup(modalState.major);
            modalState.sub = group.subs.length === 1 ? group.subs[0].id : '';
            renderMajor();
            renderSubs();
            refreshSaveBtn();
          });
        });
      }
      function renderSubs() {
        const group = C.findGroup(modalState.major);
        if (!group || group.subs.length <= 1) {
          subChipsEl.classList.add('is-hidden');
          return;
        }
        subChipsEl.classList.remove('is-hidden');
        subChipsEl.innerHTML = group.subs.map(s =>
          `<button class="sub-chip${s.id === modalState.sub ? ' is-active' : ''}" type="button" data-sub="${s.id}">${s.label}</button>`
        ).join('');
        subChipsEl.querySelectorAll('.sub-chip').forEach(c => {
          c.addEventListener('click', () => {
            modalState.sub = c.dataset.sub;
            renderSubs();
            refreshSaveBtn();
          });
        });
      }
      function refreshSaveBtn() {
        industrySaveBtn.disabled = !modalState.sub;
      }
      industrySaveBtn.addEventListener('click', async () => {
        if (!modalState.sub) return;
        industrySaveBtn.disabled = true;
        industrySaveBtn.textContent = '저장 중…';
        try {
          const res = await fetch('/api/update-profile', {
            method: 'POST',
            headers: { ...authHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ industry: modalState.sub }),
          });
          if (!res.ok) throw new Error('저장 실패');
          seller.industry = modalState.sub;
          renderInfo();
          closeIndustryModal();
          toast('업종이 변경됐어요');
        } catch (e) {
          toast(e.message || '저장 실패');
        } finally {
          industrySaveBtn.disabled = false;
          industrySaveBtn.textContent = '저장';
        }
      });

      // ── 지역 변경 모달 ──
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
      const regionModal = document.querySelector('[data-region-modal]');
      const regionBackdrop = document.querySelector('[data-region-backdrop]');
      const regionSido = document.querySelector('[data-region-sido]');
      const regionGugun = document.querySelector('[data-region-gugun]');
      const regionSaveBtn = document.querySelector('[data-region-save]');
      const regionCloseBtn = document.querySelector('[data-region-close]');
      // 시·도 옵션 한 번만 채움
      Object.keys(REGIONS).forEach(s => {
        const opt = document.createElement('option');
        opt.value = s; opt.textContent = s;
        regionSido.appendChild(opt);
      });
      function fillGugun(sido, selectedGugun) {
        regionGugun.innerHTML = '<option value="">구·군 선택</option>';
        if (sido && REGIONS[sido]) {
          REGIONS[sido].forEach(g => {
            const opt = document.createElement('option');
            opt.value = g; opt.textContent = g;
            if (g === selectedGugun) opt.selected = true;
            regionGugun.appendChild(opt);
          });
          regionGugun.disabled = false;
        } else {
          regionGugun.disabled = true;
        }
      }
      function updateRegionSaveBtn() {
        regionSaveBtn.disabled = !(regionSido.value && regionGugun.value);
      }
      regionSido.addEventListener('change', () => {
        fillGugun(regionSido.value, '');
        updateRegionSaveBtn();
      });
      regionGugun.addEventListener('change', updateRegionSaveBtn);

      function openRegionModal() {
        // 현재 region 값 기반 초기화 ("시·도 구·군" 형태로 저장됨)
        const cur = (seller.region || '').trim();
        let curSido = '', curGugun = '';
        if (cur) {
          for (const s of Object.keys(REGIONS)) {
            if (cur.startsWith(s + ' ')) {
              curSido = s;
              curGugun = cur.slice(s.length + 1);
              break;
            }
          }
        }
        regionSido.value = curSido;
        fillGugun(curSido, curGugun);
        updateRegionSaveBtn();
        regionModal.classList.add('is-open');
        regionBackdrop.classList.add('is-open');
      }
      function closeRegionModal() {
        regionModal.classList.remove('is-open');
        regionBackdrop.classList.remove('is-open');
      }
      regionCloseBtn.addEventListener('click', closeRegionModal);
      regionBackdrop.addEventListener('click', closeRegionModal);

      // Escape 키로 열려 있는 모달 닫기 — insights.html / trends.html 와 일관성.
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (regionModal.classList.contains('is-open')) closeRegionModal();
        else if (modal.classList.contains('is-open')) closeIndustryModal();
      });

      regionSaveBtn.addEventListener('click', async () => {
        if (!regionSido.value || !regionGugun.value) return;
        const newRegion = `${regionSido.value} ${regionGugun.value}`;
        regionSaveBtn.disabled = true;
        regionSaveBtn.textContent = '저장 중…';
        try {
          const res = await fetch('/api/update-profile', {
            method: 'POST',
            headers: { ...authHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ region: newRegion }),
          });
          if (!res.ok) throw new Error('저장 실패');
          seller.region = newRegion;
          renderInfo();
          closeRegionModal();
          toast('지역이 변경됐어요');
        } catch (e) {
          toast(e.message || '저장 실패');
        } finally {
          regionSaveBtn.disabled = false;
          regionSaveBtn.textContent = '저장';
        }
      });

      // ── 인스타 연동 카드 ──
      async function loadIg() {
        const titleEl = document.querySelector('[data-ig-title]');
        const subEl = document.querySelector('[data-ig-sub]');
        const actionBtn = document.querySelector('[data-ig-action]');
        const card = document.querySelector('[data-ig-card]');
        try {
          const res = await fetch('/api/comments?limit=1', { headers: authHeaders });
          const json = await res.json();
          const connected = json && json.igConnected;
          const tokenExpired = !!(json && json.tokenExpired);
          card.classList.toggle('is-connected', !!connected && !tokenExpired);
          card.classList.toggle('is-expired', !!connected && tokenExpired);

          if (connected && tokenExpired) {
            // 토큰 만료/무효 — 즉시 재연동 유도
            titleEl.textContent = '인스타 재연동 필요';
            subEl.textContent = '토큰이 만료됐어요. 게시·댓글·트렌드 갱신이 멈춤';
            actionBtn.textContent = '재연동';
            actionBtn.className = 'ig-card__action ig-card__action--connect';
            actionBtn.hidden = false;
            actionBtn.onclick = () => openIgCheckModal();  // 2026-05-20 #3: 체크리스트 먼저
          } else if (connected) {
            // 2026-05-20 #1: 어느 인스타 계정에 연결됐는지 명시 (다중 페이지 보유 사장님 오연결 방지)
            titleEl.textContent = connectedIgUsername ? `@${connectedIgUsername} 연동됨` : '인스타 연동됨';
            subEl.textContent = '게시·댓글 알림 작동 중';
            actionBtn.textContent = '연결 해제';
            actionBtn.className = 'ig-card__action ig-card__action--disconnect';
            actionBtn.hidden = false;
            actionBtn.onclick = async () => {
              if (!confirm('인스타 연결을 해제할까요? 게시가 멈춥니다.')) return;
              actionBtn.disabled = true; actionBtn.textContent = '해제 중…';
              try {
                const r = await fetch('/api/disconnect-ig', { method: 'POST', headers: authHeaders });
                if (!r.ok) throw new Error('해제 실패');
                toast('인스타 연결을 해제했어요');
                loadIg();
              } catch (e) {
                toast(e.message || '해제 실패');
                actionBtn.disabled = false;
              }
            };
          } else {
            titleEl.textContent = '인스타 미연동';
            subEl.textContent = '비즈니스/크리에이터 계정 필요';
            actionBtn.textContent = '연결하기';
            actionBtn.className = 'ig-card__action ig-card__action--connect';
            actionBtn.hidden = false;
            actionBtn.onclick = () => openIgCheckModal();  // 2026-05-20 #3: 체크리스트 먼저
          }
        } catch (e) {
          titleEl.textContent = '연동 상태 확인 실패';
          subEl.textContent = '잠시 후 다시 시도해주세요';
        }
      }

      // ── 쓰레드 연동 카드 ──
      async function loadThreads() {
        const titleEl = document.querySelector('[data-threads-title]');
        const subEl = document.querySelector('[data-threads-sub]');
        const actionBtn = document.querySelector('[data-threads-action]');
        const card = document.querySelector('[data-threads-card]');
        try {
          const res = await fetch('/api/threads-status', { headers: authHeaders });
          const json = await res.json();
          const connected = !!(json && json.threadsConnected);
          const tokenExpired = !!(json && json.tokenExpired);
          card.classList.toggle('is-connected', connected && !tokenExpired);
          card.classList.toggle('is-expired', connected && tokenExpired);

          if (connected && tokenExpired) {
            titleEl.textContent = '쓰레드 재연동 필요';
            subEl.textContent = '토큰이 만료됐어요. 쓰레드 게시가 멈춤';
            actionBtn.textContent = '재연동';
            actionBtn.className = 'ig-card__action ig-card__action--connect';
            actionBtn.hidden = false;
            actionBtn.onclick = () => startSocialOAuth('/api/threads-oauth', '/settings');
          } else if (connected) {
            // 2026-05-20 #1: 어느 쓰레드 계정에 연결됐는지 명시
            titleEl.textContent = connectedThreadsUsername ? `@${connectedThreadsUsername} 쓰레드 연동됨` : '쓰레드 연동됨';
            subEl.textContent = '쓰레드에도 함께 올라가요';
            actionBtn.textContent = '연결 해제';
            actionBtn.className = 'ig-card__action ig-card__action--disconnect';
            actionBtn.hidden = false;
            actionBtn.onclick = async () => {
              if (!confirm('쓰레드 연결을 해제할까요? 쓰레드 게시가 멈춥니다. (인스타는 그대로)')) return;
              actionBtn.disabled = true; actionBtn.textContent = '해제 중…';
              try {
                const r = await fetch('/api/disconnect-threads', { method: 'POST', headers: authHeaders });
                if (!r.ok) throw new Error('해제 실패');
                toast('쓰레드 연결을 해제했어요');
                loadThreads();
              } catch (e) {
                toast(e.message || '해제 실패');
                actionBtn.disabled = false;
              }
            };
          } else {
            titleEl.textContent = '쓰레드 미연동';
            subEl.textContent = '인스타 연동 후 쓰레드도 추가할 수 있어요';
            actionBtn.textContent = '연결하기';
            actionBtn.className = 'ig-card__action ig-card__action--connect';
            actionBtn.hidden = false;
            actionBtn.onclick = () => startSocialOAuth('/api/threads-oauth', '/settings');
          }
        } catch (e) {
          titleEl.textContent = '연동 상태 확인 실패';
          subEl.textContent = '잠시 후 다시 시도해주세요';
        }
      }

      // ── 로그아웃·탈퇴 ──
      // 모든 [data-logout] (topbar + action-btn) 에 동일 핸들러 — 2026-05-16 사장님 결정 "모든 탭".
      document.querySelectorAll('[data-logout]').forEach(btn => {
        btn.addEventListener('click', () => {
          if (!confirm('로그아웃 하시겠어요?')) return;
          ['lumi-auth','lumi_auth','seller_jwt'].forEach(k => {
            try { localStorage.removeItem(k); } catch {}
          });
          try { sessionStorage.clear(); } catch {}
          location.href = '/';
        });
      });
      // ── 회원 탈퇴 / 신청 취소 ──
      // 흐름:
      //   1) 신청 전: [회원 탈퇴] 버튼 → 모달 열림 → "회원 탈퇴" 입력 일치 시 활성 →
      //      POST /api/account-delete → 버튼 라벨 "탈퇴 신청 취소" 로 변경 + 안내 표시
      //   2) 신청 후(유예 기간): 같은 버튼 클릭 → confirm → POST /api/account-restore →
      //      버튼 원래대로
      // 로그아웃 X — 사장님이 같은 페이지에서 취소 동선 확인 가능해야 함.
      let deletionPending = false;
      let deletionScheduledAt = null;

      function fmtKDate(iso) {
        if (!iso) return null;
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return null;
        return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
      }

      function renderDeleteUi() {
        const btn = document.querySelector('[data-delete]');
        const label = btn.querySelector('[data-delete-label]');
        const infoEl = document.querySelector('[data-deletion-info]');
        if (deletionPending) {
          label.textContent = '탈퇴 신청 취소';
          if (infoEl) {
            const dstr = fmtKDate(deletionScheduledAt) || '약 7일 뒤';
            infoEl.innerHTML = `<strong>탈퇴 신청 완료</strong> · <strong>${dstr}</strong>에 영구 삭제 예정.<br>그 전에 같은 버튼을 다시 누르면 신청이 취소돼요.`;
            infoEl.hidden = false;
          }
        } else {
          label.textContent = '회원 탈퇴';
          if (infoEl) infoEl.hidden = true;
        }
      }

      // 모달 열고 닫기
      const delBackdrop = document.querySelector('[data-delete-backdrop]');
      const delModal = document.querySelector('[data-delete-modal]');
      const delConfirmInput = document.querySelector('[data-delete-confirm-input]');
      const delConfirmBtn = document.querySelector('[data-delete-confirm-btn]');
      function openDeleteModal() {
        delConfirmInput.value = '';
        delConfirmBtn.disabled = true;
        delConfirmBtn.textContent = '탈퇴 신청';
        delBackdrop.classList.add('is-open');
        delModal.classList.add('is-open');
        setTimeout(() => delConfirmInput.focus(), 50);
      }
      function closeDeleteModal() {
        delBackdrop.classList.remove('is-open');
        delModal.classList.remove('is-open');
      }
      delBackdrop.addEventListener('click', closeDeleteModal);
      document.querySelectorAll('[data-delete-close]').forEach(el => el.addEventListener('click', closeDeleteModal));

      // "회원 탈퇴" 정확 입력 시 활성화 (앞뒤 공백 허용)
      delConfirmInput.addEventListener('input', () => {
        delConfirmBtn.disabled = delConfirmInput.value.trim() !== '회원 탈퇴';
      });

      delConfirmBtn.addEventListener('click', async () => {
        delConfirmBtn.disabled = true;
        delConfirmBtn.textContent = '신청 중…';
        try {
          const r = await fetch('/api/account-delete', { method: 'POST', headers: authHeaders });
          const json = await r.json();
          if (!r.ok) throw new Error(json.error || '신청 실패');
          deletionPending = true;
          deletionScheduledAt = json.deletionScheduledAt || null;
          renderDeleteUi();
          closeDeleteModal();
          toast('탈퇴 신청 완료. 7일 후 영구 삭제 예정', 2400);
        } catch (e) {
          toast(e.message || '신청 실패');
          delConfirmBtn.disabled = false;
          delConfirmBtn.textContent = '탈퇴 신청';
        }
      });

      // 메인 [data-delete] 버튼 — 상태에 따라 분기
      document.querySelector('[data-delete]').addEventListener('click', async () => {
        if (deletionPending) {
          if (!confirm('탈퇴 신청을 취소할까요?\n취소하면 영구 삭제 일정이 사라지고 계정이 다시 활성화돼요.')) return;
          try {
            const r = await fetch('/api/account-restore', { method: 'POST', headers: authHeaders });
            const json = await r.json();
            if (!r.ok) throw new Error(json.error || '취소 실패');
            deletionPending = false;
            deletionScheduledAt = null;
            renderDeleteUi();
            toast('탈퇴 신청을 취소했어요');
          } catch (e) {
            toast(e.message || '취소 실패');
          }
        } else {
          openDeleteModal();
        }
      });

      // ── 캡션 말투 카드 ──
      const toneInput = document.querySelector('[data-tone-input]');
      const toneCount = document.querySelector('[data-tone-count]');
      const toneSaveBtn = document.querySelector('[data-tone-save]');
      let toneOriginal = '';
      function refreshToneState() {
        const v = toneInput.value;
        toneCount.textContent = `${v.length} / 500`;
        toneSaveBtn.disabled = v.trim() === toneOriginal.trim();
      }
      toneInput.addEventListener('input', refreshToneState);
      document.querySelectorAll('[data-tone-example]').forEach(btn => {
        btn.addEventListener('click', () => {
          toneInput.value = btn.textContent.trim();
          toneInput.focus();
          refreshToneState();
        });
      });
      toneSaveBtn.addEventListener('click', async () => {
        const value = toneInput.value.trim();
        toneSaveBtn.disabled = true;
        toneSaveBtn.textContent = '저장 중…';
        try {
          const r = await fetch('/api/update-profile', {
            method: 'POST',
            headers: { ...authHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ toneRequest: value }),
          });
          if (!r.ok) throw new Error('저장 실패');
          toneOriginal = value;
          toast(value ? '말투를 저장했어요' : '말투 지시를 비웠어요');
        } catch (e) {
          toast(e.message || '저장 실패');
        } finally {
          toneSaveBtn.textContent = '저장';
          refreshToneState();
        }
      });

      // 2026-05-20 #1: me.js 응답의 igStatus.username 보관 — loadIg 에서 활용.
      let connectedIgUsername = null;
      let connectedThreadsUsername = null;

      // ── 초기 로드 ──
      (async () => {
        try {
          const res = await fetch('/api/me', { headers: authHeaders });
          const json = await res.json();
          const s = json.seller || json;
          seller.store_name = s.storeName || s.store_name || '';
          seller.industry = s.industry || '';
          seller.region = s.region || '';
          seller.phone = s.phone || '';
          seller.phoneMasked = s.phoneMasked || '';
          // IG / Threads username 추출 (2026-05-20 #1)
          connectedIgUsername = (json.igStatus && json.igStatus.username) || null;
          connectedThreadsUsername = (json.threadsStatus && json.threadsStatus.username) || null;
          renderInfo();
          loadIg();
          loadThreads();
          // 탈퇴 신청 상태 동기화 — me.js 응답의 deletionPending / deletionScheduledAt
          deletionPending = !!s.deletionPending;
          deletionScheduledAt = s.deletionScheduledAt || null;
          renderDeleteUi();
          // 캡션 말투 prefill
          toneOriginal = (s.toneRequest || '').trim();
          toneInput.value = toneOriginal;
          refreshToneState();
        } catch (e) {
          toast('정보를 불러오지 못했어요');
        }
      })();

      // IG OAuth 콜백 결과 표시 (?ig=connected / ?oauth_error=N)
      // 2026-05-20 #2: oauth_error=3 (비즈니스 계정 없음) 일 때는 진단 모달 띄움.
      (function handleIgReturn() {
        const qs = new URLSearchParams(location.search);
        if (qs.get('ig') === 'connected') {
          toast('인스타 연동 완료');
        } else if (qs.has('oauth_error')) {
          const code = qs.get('oauth_error');
          if (code === '3') {
            openIgDiagModal('oauth_error_3');
          } else {
            const msg = ({
              '1': '로그인 토큰이 만료됐어요. 다시 시도해주세요.',
              '2': 'Facebook 인증이 끊겼어요.',
              '4': '세션이 만료됐어요. 다시 시도해주세요.',
              '5': '저장에 실패했어요.',
              '6': '저장에 실패했어요.',
            })[code] || '연동에 실패했어요.';
            toast(msg, 3000);
          }
        }
        if (qs.has('ig') || qs.has('oauth_error')) {
          history.replaceState(null, '', location.pathname);
        }
      })();

      // ── IG 연결 진단 모달 (2026-05-20 #2) ──────────────────────
      // oauth_error=3 발생 시 또는 사장님이 settings IG 카드에서 직접 열 때 사용.
      // 라디오 4종: 개인계정 / 페이지없음 / 연결안됨 / 다됐는데안됨.
      // 각각의 액션: 외부 가이드 링크 또는 카톡 1:1 도움 요청.
      const igDiagBackdrop = document.querySelector('[data-ig-diag-backdrop]');
      const igDiagModal = document.querySelector('[data-ig-diag-modal]');
      const igDiagGuide = document.querySelector('[data-ig-diag-guide]');
      const igDiagMsgRow = document.querySelector('[data-ig-diag-msg-row]');
      const igDiagMsg = document.querySelector('[data-ig-diag-msg]');
      const igDiagAction = document.querySelector('[data-ig-diag-action]');
      const igDiagCancel = document.querySelector('[data-ig-diag-cancel]');
      const igDiagClose = document.querySelector('[data-ig-diag-close]');
      const igDiagReasonRadios = document.querySelectorAll('input[name="ig-diag-reason"]');
      let igDiagStage = 'settings_reconnect';

      function openIgDiagModal(stage) {
        igDiagStage = stage || 'settings_reconnect';
        // reset state
        igDiagReasonRadios.forEach(r => { r.checked = false; });
        if (igDiagGuide) { igDiagGuide.hidden = true; igDiagGuide.innerHTML = ''; }
        if (igDiagMsgRow) igDiagMsgRow.hidden = true;
        if (igDiagMsg) igDiagMsg.value = '';
        if (igDiagAction) { igDiagAction.disabled = true; igDiagAction.textContent = '다음'; }
        if (igDiagBackdrop) igDiagBackdrop.classList.add('is-open');
        if (igDiagModal) igDiagModal.classList.add('is-open');
      }
      function closeIgDiagModal() {
        if (igDiagBackdrop) igDiagBackdrop.classList.remove('is-open');
        if (igDiagModal) igDiagModal.classList.remove('is-open');
      }
      // 노출 — 모듈 내 다른 핸들러도 호출 가능하게
      window.openIgDiagModal = openIgDiagModal;

      // 라디오 선택 시 가이드 영역 채움
      const IG_DIAG_GUIDES = {
        'personal-account': {
          title: '인스타 비즈니스 계정으로 전환',
          html: `인스타 앱에서 다음 순서로:<br>
            하단의 <b>내 프로필</b> (= 설정 및 활동) → <b>계정 유형</b> → 그 안에서 <b>프로페셔널 계정으로 변경</b> →
            <b>비즈니스</b> 또는 <b>크리에이터</b> 선택 → 카테고리·연락처 입력.<br><br>
            전환 마지막에 <b>Facebook 페이지 연결</b> 화면이 나와요. 페이지 없으면 다음 단계로.`,
          link: '/guide-ig#step-3',
          linkText: '📖 자세한 가이드 보기',
          actionText: '🔄 다 했어요, 다시 시도',
        },
        'no-fb-page': {
          title: 'Facebook 페이지 만들기',
          html: `매장 이름의 Facebook 페이지가 필요해요. 사진·소개는 비워도 OK, 2-3분이면 끝나요.`,
          link: '/guide-ig#step-2',
          linkText: '📖 자세한 가이드 보기',
          actionText: '🔄 페이지 만들었어요, 다시 시도',
        },
        'page-not-linked': {
          title: '인스타 ↔ 페이지 연결',
          html: `인스타 앱 → 하단 <b>내 프로필</b> (= 설정 및 활동) → <b>계정 유형</b> →
            <b>Facebook 페이지 연결</b> 선택 → 위에서 만든 페이지 선택.<br><br>
            연결 완료되면 페이지 이름이 인스타 프로필에 표시돼요.`,
          link: '/guide-ig#step-4',
          linkText: '📖 자세한 가이드 보기',
          actionText: '🔄 연결했어요, 다시 시도',
        },
        'all-done-still-fails': {
          title: '루미 팀이 도와드려요',
          html: `위 3단계 다 마치셨는데 안 되시면 사장님 본인 환경의 특수한 이슈일 가능성이 커요.
            아래 버튼 누르면 루미 팀에 사장님 정보가 전달되고, <b>1시간 안에 카톡으로 답장</b>드려요.`,
          link: null,
          linkText: null,
          actionText: '📨 루미 팀에 도움 요청',
        },
      };

      igDiagReasonRadios.forEach(radio => {
        radio.addEventListener('change', () => {
          if (!radio.checked) return;
          const reason = radio.value;
          const g = IG_DIAG_GUIDES[reason];
          if (!g) return;
          if (igDiagGuide) {
            igDiagGuide.hidden = false;
            const linkHtml = g.link ? `<a class="ig-diag__guide-link" href="${g.link}" target="_blank" rel="noopener noreferrer">${esc(g.linkText)}</a>` : '';
            igDiagGuide.innerHTML = `
              <div class="ig-diag__guide-title">${esc(g.title)}</div>
              <div class="ig-diag__guide-body">${g.html}</div>
              ${linkHtml}
            `;
          }
          // "all-done" 만 추가 메시지 입력 노출
          if (igDiagMsgRow) igDiagMsgRow.hidden = (reason !== 'all-done-still-fails');
          if (igDiagAction) {
            igDiagAction.disabled = false;
            igDiagAction.textContent = g.actionText;
          }
        });
      });

      // ── IG 체크리스트 모달 (2026-05-20 #3) ─────────────────────
      // settings 의 "연결하기" / "재연동" 클릭 시 OAuth 직전에 사전 체크.
      const igCheckBackdrop = document.querySelector('[data-ig-check-backdrop]');
      const igCheckModal = document.querySelector('[data-ig-check-modal]');
      const igCheckBoxes = document.querySelectorAll('[data-ig-check-box]');
      const igCheckProceed = document.querySelector('[data-ig-check-proceed]');
      const igCheckCancel = document.querySelector('[data-ig-check-cancel]');
      const igCheckClose = document.querySelector('[data-ig-check-close]');
      const igCheckHelp = document.querySelector('[data-ig-check-help]');

      function openIgCheckModal() {
        igCheckBoxes.forEach(cb => { cb.checked = false; });
        if (igCheckProceed) igCheckProceed.disabled = true;
        if (igCheckBackdrop) igCheckBackdrop.classList.add('is-open');
        if (igCheckModal) igCheckModal.classList.add('is-open');
      }
      function closeIgCheckModal() {
        if (igCheckBackdrop) igCheckBackdrop.classList.remove('is-open');
        if (igCheckModal) igCheckModal.classList.remove('is-open');
      }
      window.openIgCheckModal = openIgCheckModal;

      function refreshIgCheckProceed() {
        const allChecked = Array.from(igCheckBoxes).every(cb => cb.checked);
        if (igCheckProceed) igCheckProceed.disabled = !allChecked;
      }
      igCheckBoxes.forEach(cb => cb.addEventListener('change', refreshIgCheckProceed));

      if (igCheckProceed) igCheckProceed.addEventListener('click', () => {
        closeIgCheckModal();
        setTimeout(() => startSocialOAuth('/api/ig-oauth', '/settings'), 250);
      });
      if (igCheckCancel) igCheckCancel.addEventListener('click', closeIgCheckModal);
      if (igCheckClose) igCheckClose.addEventListener('click', closeIgCheckModal);
      if (igCheckBackdrop) igCheckBackdrop.addEventListener('click', closeIgCheckModal);
      if (igCheckHelp) igCheckHelp.addEventListener('click', (e) => {
        e.preventDefault();
        closeIgCheckModal();
        setTimeout(() => openIgDiagModal('settings_reconnect'), 250);
      });

      if (igDiagAction) {
        igDiagAction.addEventListener('click', async () => {
          const selected = document.querySelector('input[name="ig-diag-reason"]:checked');
          if (!selected) return;
          const reason = selected.value;
          if (reason === 'all-done-still-fails') {
            // 카톡/이메일 도움 요청
            igDiagAction.disabled = true;
            igDiagAction.textContent = '보내는 중…';
            try {
              const r = await fetch('/api/request-ig-help', {
                method: 'POST',
                headers: { ...authHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  stage: igDiagStage,
                  userSelectedReason: reason,
                  message: igDiagMsg ? igDiagMsg.value.trim() : '',
                  contextUrl: location.href,
                }),
              });
              if (r.ok) {
                toast('루미 팀에 알렸어요. 1시간 안에 카톡으로 연락드릴게요.', 4000);
                closeIgDiagModal();
              } else {
                toast('요청 실패. 다시 시도해주세요.', 3000);
                igDiagAction.disabled = false;
                igDiagAction.textContent = '📨 루미 팀에 도움 요청';
              }
            } catch (e) {
              toast('네트워크 오류 — 다시 시도해주세요.', 3000);
              igDiagAction.disabled = false;
              igDiagAction.textContent = '📨 루미 팀에 도움 요청';
            }
            return;
          }
          // 그 외 — 다시 OAuth 시도
          closeIgDiagModal();
          // 약간 지연 후 OAuth (모달 닫힘 애니메이션 끝난 뒤)
          setTimeout(() => startSocialOAuth('/api/ig-oauth', '/settings'), 250);
        });
      }
      if (igDiagCancel) igDiagCancel.addEventListener('click', closeIgDiagModal);
      if (igDiagClose) igDiagClose.addEventListener('click', closeIgDiagModal);
      if (igDiagBackdrop) igDiagBackdrop.addEventListener('click', closeIgDiagModal);

      // Threads OAuth 콜백 결과 표시 (?threads=connected / ?threads_oauth_error=N)
      (function handleThreadsReturn() {
        const qs = new URLSearchParams(location.search);
        if (qs.get('threads') === 'connected') {
          toast('쓰레드 연동 완료');
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
          toast(msg, 3000);
        }
        if (qs.has('threads') || qs.has('threads_oauth_error')) {
          history.replaceState(null, '', location.pathname);
        }
      })();

      // 프로필 링크 (링크트리) 섹션 — slug 자동 부여 + 링크 추가/편집/삭제 + 저장.
      (async function initLinktree() {
        const editEl = document.querySelector('[data-lt-edit]');
        if (!editEl) return;

        const urlEl = editEl.querySelector('[data-lt-url]');
        const copyBtn = editEl.querySelector('[data-lt-copy]');
        const listEl = editEl.querySelector('[data-lt-list]');
        const emptyEl = editEl.querySelector('[data-lt-empty]');
        const addBtn = editEl.querySelector('[data-lt-add]');
        const saveBtn = editEl.querySelector('[data-lt-save]');
        const openBtn = editEl.querySelector('[data-lt-open]');

        const URL_PLACEHOLDERS = {
          menu: 'https://order.naver.com/... (네이버 스마트오더·메뉴판 URL)',
          reservation: 'https://booking.naver.com/... (네이버 예약·캐치테이블 등)',
          delivery: 'https://baemin.me/... (배민·요기요·쿠팡이츠 등)',
          map: 'https://naver.me/... (네이버지도·카카오맵 공유 URL)',
          phone: 'tel:01012345678',
          kakao: 'https://pf.kakao.com/_xxxxx (카카오톡 채널 URL)',
          website: 'https://...',
          custom: 'https://...',
        };
        const TYPE_DEFAULT_LABELS = {
          menu: '메뉴 보기',
          reservation: '예약하기',
          delivery: '배달 주문',
          map: '지도에서 보기',
          phone: '전화하기',
          kakao: '카카오톡 문의',
          website: '홈페이지',
          custom: '',
        };

        const TYPES = [
          { value: 'custom', label: '🔗 기타' },
          { value: 'menu', label: '🍽️ 메뉴' },
          { value: 'reservation', label: '📅 예약' },
          { value: 'delivery', label: '🛵 배달' },
          { value: 'map', label: '📍 지도' },
          { value: 'phone', label: '☎️ 전화' },
          { value: 'kakao', label: '💬 카카오톡' },
          { value: 'website', label: '🌐 웹사이트' },
        ];

        let currentSlug = null;
        let state = { links: [] };

        function escapeHtml(s) {
          return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
          }[c]));
        }

        function markDirty() { saveBtn.disabled = false; }

        function fullUrl(slug) {
          return slug ? `${location.origin}/r/${slug}` : '';
        }

        function renderSlug(slug) {
          currentSlug = slug;
          if (slug) {
            urlEl.textContent = fullUrl(slug);
            urlEl.classList.remove('lt-url-card__text--loading');
            copyBtn.disabled = false;
            openBtn.disabled = false;
          } else {
            urlEl.textContent = '주소를 가져오지 못했어요';
            urlEl.classList.add('lt-url-card__text--loading');
            copyBtn.disabled = true;
            openBtn.disabled = true;
          }
        }

        function renderRow(link, idx) {
          const row = document.createElement('div');
          row.className = 'lt-edit__row';
          const urlPlaceholder = URL_PLACEHOLDERS[link.type] || URL_PLACEHOLDERS.custom;
          row.innerHTML = `
            <div class="lt-edit__row-fields">
              <div class="lt-edit__row-top">
                <select data-lt-type>
                  ${TYPES.map((t) => `<option value="${t.value}"${link.type === t.value ? ' selected' : ''}>${t.label}</option>`).join('')}
                </select>
                <input type="text" data-lt-label maxlength="60" placeholder="이름 (예: 오늘의 메뉴)" value="${escapeHtml(link.label)}">
              </div>
              <input type="url" data-lt-url maxlength="2000" placeholder="${escapeHtml(urlPlaceholder)}" value="${escapeHtml(link.url)}">
            </div>
            <button class="lt-edit__row-delete" type="button" data-lt-delete aria-label="삭제">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          `;
          const urlInput = row.querySelector('[data-lt-url]');
          row.querySelector('[data-lt-type]').addEventListener('change', (e) => {
            state.links[idx].type = e.target.value;
            urlInput.placeholder = URL_PLACEHOLDERS[e.target.value] || URL_PLACEHOLDERS.custom;
            markDirty();
          });
          row.querySelector('[data-lt-label]').addEventListener('input', (e) => {
            state.links[idx].label = e.target.value;
            markDirty();
          });
          urlInput.addEventListener('input', (e) => {
            state.links[idx].url = e.target.value.trim();
            markDirty();
          });
          row.querySelector('[data-lt-delete]').addEventListener('click', () => {
            state.links.splice(idx, 1);
            renderList();
            markDirty();
          });
          return row;
        }

        function renderList() {
          listEl.innerHTML = '';
          state.links.forEach((link, i) => {
            listEl.appendChild(renderRow(link, i));
          });
          // 빈 상태 안내 toggle
          if (emptyEl) emptyEl.hidden = state.links.length > 0;
        }

        copyBtn.addEventListener('click', async () => {
          if (!currentSlug) return;
          const text = fullUrl(currentSlug);
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(text);
            } else {
              const range = document.createRange();
              range.selectNodeContents(urlEl);
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
              document.execCommand('copy');
              sel.removeAllRanges();
            }
            copyBtn.textContent = '복사됨';
            copyBtn.classList.add('is-copied');
            setTimeout(() => {
              copyBtn.textContent = '복사';
              copyBtn.classList.remove('is-copied');
            }, 1500);
            toast('주소가 복사됐어요');
          } catch (e) {
            console.error('[linktree] copy 실패:', e);
            toast('복사에 실패했어요. 주소를 길게 눌러 직접 복사해주세요.', 2500);
          }
        });

        openBtn.addEventListener('click', () => {
          if (!currentSlug) return;
          window.open(`/r/${currentSlug}`, '_blank', 'noopener');
        });

        addBtn.addEventListener('click', () => {
          if (state.links.length >= 20) {
            toast('링크는 최대 20개까지 추가할 수 있어요', 2500);
            return;
          }
          state.links.push({ label: '', url: '', type: 'custom' });
          renderList();
          markDirty();
        });

        // 빈 상태의 추천 chip — 클릭 시 해당 type 으로 prefilled 카드 생성
        if (emptyEl) {
          emptyEl.querySelectorAll('[data-lt-quick]').forEach((chip) => {
            chip.addEventListener('click', () => {
              if (state.links.length >= 20) {
                toast('링크는 최대 20개까지 추가할 수 있어요', 2500);
                return;
              }
              const type = chip.dataset.ltQuick;
              state.links.push({
                label: TYPE_DEFAULT_LABELS[type] || '',
                url: '',
                type,
              });
              renderList();
              markDirty();
              // 새 카드의 label input 에 자동 포커스 (사장님이 매장명·메뉴명 등 바꿀 수 있게)
              const rows = listEl.querySelectorAll('.lt-edit__row');
              const lastRow = rows[rows.length - 1];
              if (lastRow) {
                const labelInput = lastRow.querySelector('[data-lt-label]');
                if (labelInput) labelInput.focus();
              }
            });
          });
        }

        saveBtn.addEventListener('click', async () => {
          saveBtn.disabled = true;
          try {
            const body = {
              links: state.links.map((l, i) => ({
                label: (l.label || '').trim(),
                url: (l.url || '').trim(),
                type: l.type || 'custom',
                sortOrder: i,
              })),
            };
            // 빈 행 정리 + URL prefix 자동 보정 + 빈 label 자동 채움.
            // URL 만 있으면 type 기본 라벨로 자동 라벨링 (사장님이 라벨 안 채워도 저장 가능).
            const PREFIX_RE = /^(https?:\/\/|tel:|mailto:|kakaotalk:)/i;
            const TYPE_LABEL_FALLBACK = {
              menu: '메뉴 보기', reservation: '예약하기', delivery: '배달 주문',
              map: '지도에서 보기', phone: '전화하기', kakao: '카카오톡 문의',
              website: '홈페이지', custom: '링크',
            };
            const hadCards = state.links.length > 0;
            body.links = body.links
              .filter((l) => l.url)
              .map((l) => ({
                ...l,
                label: l.label || TYPE_LABEL_FALLBACK[l.type] || '링크',
                url: PREFIX_RE.test(l.url) ? l.url : 'https://' + l.url,
              }));
            // 카드는 있는데 모든 URL 이 비어있는 경우만 경고 (입력 실수).
            // 카드 자체가 0 개면 의도적 비우기 → 저장 허용 (전부 삭제 케이스).
            if (body.links.length === 0 && hadCards) {
              toast('URL 을 입력해주세요', 2500);
              saveBtn.disabled = false;
              return;
            }
            const res = await fetch('/api/save-linktree', {
              method: 'POST',
              headers: { ...authHeaders, 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) {
              toast(data.error || '저장에 실패했어요', 3000);
              saveBtn.disabled = false;
              return;
            }
            if (data.slug && data.slug !== currentSlug) renderSlug(data.slug);
            state.links = (data.links || []).map((l) => ({
              id: l.id, label: l.label, url: l.url, type: l.type,
            }));
            renderList();
            toast('저장됐어요');
          } catch (e) {
            console.error('[linktree] save 실패:', e);
            toast('저장에 실패했어요', 3000);
            saveBtn.disabled = false;
          }
        });

        try {
          const r = await fetch('/api/my-linktree', { headers: authHeaders });
          if (!r.ok) {
            renderSlug(null);
            return;
          }
          const data = await r.json();
          if (!data || !data.success) {
            renderSlug(null);
            return;
          }
          renderSlug(data.slug || null);
          state.links = (data.links || []).map((l) => ({
            id: l.id, label: l.label, url: l.url, type: l.type,
          }));
          renderList();
        } catch (e) {
          console.error('[linktree] load 실패:', e);
          renderSlug(null);
        }
      })();
    })();
