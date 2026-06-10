    (function () {
      // /r/{slug} 또는 ?slug=X 둘 다 지원
      function getSlugFromUrl() {
        const m = window.location.pathname.match(/^\/r\/([a-z0-9-]+)\/?$/i);
        if (m) return m[1].toLowerCase();
        const qs = new URLSearchParams(window.location.search);
        return (qs.get('slug') || '').toLowerCase();
      }

      const ICONS = {
        menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18"/><path d="M3 6h18"/><path d="M3 18h18"/></svg>',
        reservation: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
        delivery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/><path d="M2 9h11l3 5h5v4M2 9v9h3"/></svg>',
        map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>',
        phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.13.94.37 1.85.72 2.71a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.37-1.37a2 2 0 012.11-.45c.86.35 1.77.59 2.71.72A2 2 0 0122 16.92z"/></svg>',
        kakao: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3C6.477 3 2 6.477 2 10.8c0 2.78 1.788 5.222 4.5 6.616-.197.71-.71 2.555-.812 2.95-.127.49.18.484.379.353.156-.103 2.485-1.69 3.486-2.37.8.115 1.621.176 2.447.176 5.523 0 10-3.477 10-7.8S17.523 3 12 3z"/></svg>',
        website: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>',
        custom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>',
        instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1112.63 8 4 4 0 0116 11.37z"/><line x1="17.5" y1="6.5" x2="17.5" y2="6.5"/></svg>',
        threads: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.45 11.13c-.082-.04-.166-.077-.252-.114-.15-2.756-1.656-4.335-4.182-4.351h-.034c-1.51 0-2.766.645-3.54 1.815l1.39.953c.578-.876 1.486-1.063 2.15-1.063h.023c.827.005 1.451.246 1.854.715.295.343.491.816.587 1.412-.726-.124-1.51-.162-2.349-.114-2.365.136-3.886 1.515-3.784 3.43.052.972.534 1.806 1.356 2.35.694.46 1.59.683 2.524.633 1.232-.067 2.198-.537 2.873-1.396.512-.652.836-1.498.978-2.564.582.351 1.014.815 1.252 1.371.405.943.428 2.494-.838 3.758-1.109 1.107-2.442 1.586-4.456 1.6-2.235-.016-3.926-.733-5.026-2.13C7.42 16.165 6.89 14.4 6.87 12c.02-2.4.55-4.166 1.578-5.46 1.1-1.398 2.792-2.114 5.026-2.13 2.252.017 3.974.736 5.118 2.137.561.687.984 1.55 1.262 2.557l1.482-.394c-.337-1.236-.866-2.302-1.586-3.183C18.351 2.79 16.07 1.853 13.484 1.834h-.011C10.892 1.853 8.636 2.797 7.16 4.624 5.85 6.25 5.176 8.514 5.153 11.99v.02c.023 3.475.696 5.74 2.007 7.366 1.477 1.828 3.732 2.77 6.313 2.79h.011c2.292-.016 3.911-.616 5.245-1.946 1.745-1.741 1.693-3.924 1.118-5.265-.413-.96-1.2-1.74-2.397-2.825z"/></svg>',
      };

      const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';

      function iconFor(type) {
        return ICONS[type] || ICONS.custom;
      }

      function esc(s) {
        return String(s || '').replace(/[&<>"']/g, (c) => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
      }

      function renderState(html, contentEl) {
        contentEl.className = 'lt-state';
        contentEl.innerHTML = html;
      }

      function renderProfile(profile, links, contentEl) {
        // 자동 카드: Instagram·Threads
        const autoCards = [];
        if (profile.igUsername) {
          autoCards.push({
            url: `https://instagram.com/${encodeURIComponent(profile.igUsername)}`,
            label: '인스타그램',
            type: 'instagram',
            external: true,
          });
        }
        if (profile.threadsUsername) {
          autoCards.push({
            url: `https://threads.net/@${encodeURIComponent(profile.threadsUsername)}`,
            label: '스레드',
            type: 'threads',
            external: true,
          });
        }

        const allCards = [...links, ...autoCards];

        const avatar = profile.avatarUrl
          ? `<img class="lt-avatar" src="${esc(profile.avatarUrl)}" alt="${esc(profile.storeName)}" loading="lazy" decoding="async">`
          : `<div class="lt-avatar lt-avatar--placeholder">${esc((profile.storeName || '?').slice(0, 1))}</div>`;

        const metaParts = [];
        if (profile.region) metaParts.push(esc(profile.region));
        if (profile.industry) metaParts.push(esc(profile.industry));
        const meta = metaParts.length
          ? `<p class="lt-meta">${metaParts.join('<span class="lt-meta__sep">·</span>')}</p>`
          : '';

        const desc = profile.storeDesc ? `<p class="lt-desc">${esc(profile.storeDesc)}</p>` : '';

        // S5 (2026-05-15): 렌더 단계 protocol 화이트리스트 — defense-in-depth.
        // save-linktree.js 가 protocol 검증하지만 DB 직접 수정·관리자 실수 등으로
        // javascript:/data: 가 들어와도 stored XSS 차단.
        const SAFE_URL_RE = /^(https?:|mailto:|tel:|kakaotalk:)/i;
        const safeHref = (u) => (u && SAFE_URL_RE.test(String(u).trim())) ? String(u).trim() : '#';
        const cardsHtml = allCards.length
          ? allCards.map((l, i) => {
              const iconCls = l.type === 'instagram' ? ' lt-card__icon--ig'
                            : l.type === 'threads'    ? ' lt-card__icon--threads'
                            : '';
              const href = safeHref(l.url);
              const target = href !== '#' && /^https?:/i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
              return `
                <a class="lt-card" href="${esc(href)}"${target}>
                  <span class="lt-card__icon${iconCls}">${iconFor(l.type)}</span>
                  <span class="lt-card__label">${esc(l.label)}</span>
                  <span class="lt-card__arrow">${ARROW}</span>
                </a>
              `;
            }).join('')
          : '<div class="lt-state">아직 등록된 링크가 없어요</div>';

        contentEl.className = '';
        contentEl.innerHTML = `
          <header class="lt-profile">
            ${avatar}
            <h1 class="lt-store-name">${esc(profile.storeName || '루미')}</h1>
            ${meta}
            ${desc}
          </header>
          <nav class="lt-links" aria-label="링크 목록">
            ${cardsHtml}
          </nav>
        `;
        // CSP: style-src 에 unsafe-inline 없음 → innerHTML 의 style 속성은 무시됨.
        // 카드 스태거 딜레이는 CSSOM 으로 지정.
        contentEl.querySelectorAll('.lt-card').forEach((el, i) => {
          el.style.animationDelay = (i * 40) + 'ms';
        });

        if (profile.storeName) {
          document.title = `${profile.storeName} · 루미(lumi)`;
        }
      }

      async function load() {
        const contentEl = document.getElementById('lt-content');
        const slug = getSlugFromUrl();
        if (!slug) {
          renderState('잘못된 주소입니다', contentEl);
          return;
        }

        try {
          // cache-bust — 매 페이지 로드마다 최신 데이터 보장 (사장님이 settings
          // 에서 링크 수정 후 즉시 반영되도록)
          const r = await fetch(`/api/linktree?slug=${encodeURIComponent(slug)}&t=${Date.now()}`, {
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
          });
          if (r.status === 404) {
            renderState('페이지를 찾을 수 없어요', contentEl);
            return;
          }
          if (!r.ok) {
            renderState('잠시 후 다시 시도해주세요', contentEl);
            return;
          }
          const data = await r.json();
          if (!data || !data.success || !data.profile) {
            renderState('잠시 후 다시 시도해주세요', contentEl);
            return;
          }
          renderProfile(data.profile, data.links || [], contentEl);
        } catch (e) {
          console.error('[linktree] load 실패:', e);
          renderState('잠시 후 다시 시도해주세요', contentEl);
        }
      }

      load();
    })();
