    (function () {
      const qs = new URLSearchParams(location.search);
      const code = qs.get('code') || '';
      const stateEl = document.getElementById('state');
      const detailEl = document.getElementById('detail');

      if (!code) {
        stateEl.textContent = '처리 코드가 없습니다.';
        return;
      }
      document.getElementById('code-val').textContent = code;

      function fmtTs(iso) {
        if (!iso) return '-';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '-';
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      }
      const STATUS_KR = {
        pending:   '처리 중',
        completed: '삭제 완료',
        not_found: '계정 매칭 실패',
        failed:    '처리 실패',
      };
      const CHANNEL_KR = { ig: '인스타그램', threads: '쓰레드', unknown: '확인 불가' };

      (async () => {
        try {
          const r = await fetch('/api/data-deletion-lookup?code=' + encodeURIComponent(code));
          if (r.status === 404) {
            stateEl.textContent = '이 처리 코드에 해당하는 요청이 없습니다.';
            return;
          }
          if (!r.ok) {
            stateEl.textContent = '조회에 실패했습니다. 잠시 후 다시 시도해주세요.';
            return;
          }
          const j = await r.json();
          stateEl.hidden = true;
          detailEl.hidden = false;

          const badge = document.getElementById('status-badge');
          badge.textContent = STATUS_KR[j.status] || j.status;
          badge.classList.add(`status--${j.status}`);

          document.getElementById('channel-val').textContent = CHANNEL_KR[j.channel] || j.channel || '-';
          document.getElementById('created-val').textContent = fmtTs(j.createdAt);
          document.getElementById('completed-val').textContent = fmtTs(j.completedAt);
          if (j.errorMessage) {
            document.getElementById('error-row').hidden = false;
            document.getElementById('error-val').textContent = j.errorMessage;
          }
        } catch (e) {
          stateEl.textContent = '조회 중 오류가 발생했습니다.';
        }
      })();
    })();
