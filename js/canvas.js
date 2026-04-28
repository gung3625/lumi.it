/* canvas.js — Linear/Canvas UI 도그마 4축 공통 동작 (2026-04-28)
 * 메모리 project_linear_canvas_ui_doctrine_0428.md
 * - Command Palette (⌘K / Ctrl+K)
 * - Slide-over (Progressive Detail)
 * - View toggle helper
 *
 * 페이지마다 window.LumiCanvas.init({ commands: [...] }) 호출.
 */
(function () {
  'use strict';

  const Canvas = {
    _state: { open: false, query: '', items: [], activeIdx: 0, allCommands: [] },

    init(config) {
      this._state.allCommands = config?.commands || [];
      this._injectChrome();
      this._bindGlobalShortcut();
    },

    /** 명령창 호출 */
    openPalette() {
      const overlay = document.getElementById('cmdkOverlay');
      if (!overlay) return;
      overlay.dataset.open = 'true';
      const input = overlay.querySelector('.cmdk-search__input');
      this._state.open = true;
      this._state.query = '';
      this._state.activeIdx = 0;
      if (input) {
        input.value = '';
        setTimeout(() => input.focus(), 30);
      }
      this._renderResults('');
    },

    closePalette() {
      const overlay = document.getElementById('cmdkOverlay');
      if (!overlay) return;
      overlay.dataset.open = 'false';
      this._state.open = false;
    },

    /** Slide-over (Progressive Detail) */
    openSlideOver(opts) {
      // opts: { title, body, footer, onClose }
      let el = document.getElementById('slideOver');
      if (!el) {
        el = document.createElement('aside');
        el.id = 'slideOver';
        el.className = 'slide-over';
        el.innerHTML = `
          <div class="slide-over__backdrop" data-slide-close></div>
          <section class="slide-over__panel" role="dialog" aria-modal="true">
            <header class="slide-over__head">
              <h2 class="slide-over__title" data-slide-title></h2>
              <button class="slide-over__close" data-slide-close aria-label="닫기">×</button>
            </header>
            <div class="slide-over__body" data-slide-body></div>
            <footer class="slide-over__foot" data-slide-foot></footer>
          </section>
        `;
        document.body.appendChild(el);
        el.addEventListener('click', (ev) => {
          if (ev.target.matches('[data-slide-close]')) this.closeSlideOver();
        });
      }
      el.querySelector('[data-slide-title]').textContent = opts.title || '';
      const body = el.querySelector('[data-slide-body]');
      body.innerHTML = '';
      if (typeof opts.body === 'string') body.innerHTML = opts.body;
      else if (opts.body instanceof Node) body.appendChild(opts.body);
      const foot = el.querySelector('[data-slide-foot]');
      foot.innerHTML = '';
      if (opts.footer) {
        if (typeof opts.footer === 'string') foot.innerHTML = opts.footer;
        else if (opts.footer instanceof Node) foot.appendChild(opts.footer);
      } else {
        foot.style.display = 'none';
      }
      el.dataset.open = 'true';
      this._currentClose = opts.onClose || null;
    },

    closeSlideOver() {
      const el = document.getElementById('slideOver');
      if (!el) return;
      el.dataset.open = 'false';
      if (typeof this._currentClose === 'function') {
        try { this._currentClose(); } catch {}
        this._currentClose = null;
      }
    },

    /** ---------- 내부 ---------- */
    _injectChrome() {
      if (document.getElementById('cmdkOverlay')) return;
      const overlay = document.createElement('div');
      overlay.id = 'cmdkOverlay';
      overlay.className = 'cmdk-overlay';
      overlay.dataset.open = 'false';
      overlay.innerHTML = `
        <div class="cmdk-panel" role="dialog" aria-modal="true" aria-label="명령창">
          <div class="cmdk-search">
            <span class="cmdk-search__icon" aria-hidden="true">⌘</span>
            <input class="cmdk-search__input" type="text" placeholder="무엇을 도와드릴까요? (예: 오늘 주문, 송장 입력)" autocomplete="off" />
            <span class="cmdk-search__hint">ESC</span>
          </div>
          <div class="cmdk-list" data-cmdk-list></div>
        </div>
      `;
      document.body.appendChild(overlay);

      overlay.addEventListener('click', (ev) => {
        if (ev.target === overlay) this.closePalette();
      });
      const input = overlay.querySelector('.cmdk-search__input');
      input.addEventListener('input', (ev) => {
        this._state.query = ev.target.value;
        this._state.activeIdx = 0;
        this._renderResults(ev.target.value);
      });
      input.addEventListener('keydown', (ev) => this._onKey(ev));
    },

    _renderResults(query) {
      const list = document.querySelector('[data-cmdk-list]');
      if (!list) return;
      const q = (query || '').trim().toLowerCase();
      const all = this._state.allCommands;
      let items = all;
      if (q) {
        items = all.filter((c) => {
          const hay = (c.title + ' ' + (c.keywords || '') + ' ' + (c.section || '')).toLowerCase();
          return hay.includes(q);
        });
      }
      this._state.items = items;
      if (items.length === 0) {
        list.innerHTML = `<div class="cmdk-empty">검색 결과 없음. 자연어로 입력해보세요.</div>`;
        return;
      }
      // 섹션별 그룹
      const bySection = {};
      items.forEach((it) => {
        const k = it.section || '추천';
        bySection[k] = bySection[k] || [];
        bySection[k].push(it);
      });
      let html = '';
      let flatIdx = 0;
      Object.keys(bySection).forEach((sec) => {
        html += `<div class="cmdk-section">${escapeHtml(sec)}</div>`;
        bySection[sec].forEach((it) => {
          const active = flatIdx === this._state.activeIdx;
          html += `
            <div class="cmdk-item" data-idx="${flatIdx}" data-active="${active}">
              <span class="cmdk-item__icon">${it.icon || '·'}</span>
              <div class="cmdk-item__text">
                <div class="cmdk-item__title">${escapeHtml(it.title)}</div>
                ${it.sub ? `<div class="cmdk-item__sub">${escapeHtml(it.sub)}</div>` : ''}
              </div>
              ${it.shortcut ? `<span class="cmdk-item__shortcut">${escapeHtml(it.shortcut)}</span>` : ''}
            </div>
          `;
          flatIdx += 1;
        });
      });
      list.innerHTML = html;
      list.querySelectorAll('.cmdk-item').forEach((el) => {
        el.addEventListener('click', () => this._invoke(parseInt(el.dataset.idx, 10)));
        el.addEventListener('mousemove', () => {
          const idx = parseInt(el.dataset.idx, 10);
          if (idx !== this._state.activeIdx) {
            this._state.activeIdx = idx;
            list.querySelectorAll('.cmdk-item').forEach((x) => {
              x.dataset.active = (parseInt(x.dataset.idx, 10) === idx) ? 'true' : 'false';
            });
          }
        });
      });
    },

    _onKey(ev) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        this.closePalette();
        return;
      }
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        this._move(1);
        return;
      }
      if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        this._move(-1);
        return;
      }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this._invoke(this._state.activeIdx);
      }
    },

    _move(delta) {
      const max = this._state.items.length;
      if (max === 0) return;
      this._state.activeIdx = (this._state.activeIdx + delta + max) % max;
      const list = document.querySelector('[data-cmdk-list]');
      if (!list) return;
      list.querySelectorAll('.cmdk-item').forEach((x) => {
        x.dataset.active = (parseInt(x.dataset.idx, 10) === this._state.activeIdx) ? 'true' : 'false';
      });
      const active = list.querySelector(`.cmdk-item[data-active="true"]`);
      if (active && active.scrollIntoView) {
        active.scrollIntoView({ block: 'nearest' });
      }
    },

    _invoke(idx) {
      const item = this._state.items[idx];
      if (!item) return;
      this.closePalette();
      try {
        if (typeof item.action === 'function') item.action();
        else if (item.href) window.location.href = item.href;
      } catch (e) {
        console.warn('[cmdk] invoke failed', e);
      }
    },

    _bindGlobalShortcut() {
      document.addEventListener('keydown', (ev) => {
        const isCmdK = (ev.metaKey || ev.ctrlKey) && (ev.key === 'k' || ev.key === 'K');
        if (isCmdK) {
          ev.preventDefault();
          if (this._state.open) this.closePalette();
          else this.openPalette();
        }
      });
      // ⌘K 트리거 버튼 클릭
      document.addEventListener('click', (ev) => {
        const trigger = ev.target.closest('[data-cmdk-open]');
        if (trigger) {
          ev.preventDefault();
          this.openPalette();
        }
      });
    },
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  window.LumiCanvas = Canvas;
})();
