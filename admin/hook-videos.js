// /admin/hook-videos.js — Hook 영상 풀 관리 admin UI.
// 흐름:
//   1. 토큰 체크 → GET /api/admin-hook-videos 로 권한 + list 확인
//   2. 카테고리별 요약 + 영상 목록 렌더
//   3. 업로드 폼:
//      a. 영상 metadata 추출 (duration·width·height)
//      b. POST { action: 'request_upload_url' } → signed URL
//      c. PUT signed URL → Storage 업로드
//      d. POST { action: 'insert', ... } → DB row + 새 영상 list 에 표시
//   4. 영상 카드: active 토글, 삭제 버튼

(function () {
  const token = localStorage.getItem('lumi-auth') || localStorage.getItem('lumi_auth') || localStorage.getItem('seller_jwt');
  if (!token) { location.replace('/'); return; }
  const authHeaders = { Authorization: 'Bearer ' + token };

  const authErr = document.querySelector('[data-auth-err]');
  const summarySec = document.querySelector('[data-summary]');
  const summaryGrid = document.querySelector('[data-summary-grid]');
  const uploadSec = document.querySelector('[data-upload-section]');
  const listSec = document.querySelector('[data-list-section]');
  const listGrid = document.querySelector('[data-list-grid]');
  const listCount = document.querySelector('[data-list-count]');
  const listEmpty = document.querySelector('[data-list-empty]');
  const form = document.querySelector('[data-upload-form]');
  const fileEl = document.querySelector('#up-file');
  const fileInfoEl = document.querySelector('[data-file-info]');
  const submitBtn = document.querySelector('[data-submit]');
  const errEl = document.querySelector('[data-err]');
  const progress = document.querySelector('[data-progress]');
  const progressBar = document.querySelector('[data-progress-bar]');
  const progressText = document.querySelector('[data-progress-text]');

  const CATEGORY_LABELS = {
    cafe: '☕ 카페', food: '🍽️ 식당', beauty: '💄 뷰티', hair: '✂️ 헤어',
    nail: '💅 네일', flower: '🌹 꽃', fashion: '👕 패션', fitness: '🏋️ 운동',
    general: '✨ 일반',
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('ko-KR') + ' ' + d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  }

  function showProgress(pct, text) {
    progress.hidden = false;
    progressBar.style.width = pct + '%';
    progressText.textContent = text || '';
  }
  function hideProgress() { progress.hidden = true; }
  function showErr(msg) { errEl.textContent = msg; errEl.hidden = false; }
  function clearErr() { errEl.hidden = true; }

  // ─────────── 권한 + list 로드 ───────────
  async function loadList() {
    try {
      const r = await fetch('/api/admin-hook-videos', { headers: authHeaders });
      if (r.status === 401) {
        authErr.hidden = false;
        return null;
      }
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        showErr((j && j.error) || '목록 로드 실패');
        return null;
      }
      const j = await r.json();
      summarySec.hidden = false;
      uploadSec.hidden = false;
      listSec.hidden = false;
      renderSummary(j.summary || {});
      renderList(j.videos || []);
      return j;
    } catch (e) {
      showErr('네트워크 오류 — ' + e.message);
      return null;
    }
  }

  function renderSummary(summary) {
    const cats = Object.keys(CATEGORY_LABELS);
    summaryGrid.innerHTML = cats.map((cat) => {
      const s = summary[cat] || { total: 0, active: 0 };
      const lowAlert = s.active < 3;
      return `
        <div class="admin__summary-card ${lowAlert ? 'is-low' : ''}">
          <div class="admin__summary-cat">${CATEGORY_LABELS[cat] || cat}</div>
          <div class="admin__summary-stat"><strong>${s.active}</strong> / ${s.total}</div>
          <div class="admin__summary-sub">${lowAlert ? '⚠️ 추가 필요' : '활성/전체'}</div>
        </div>
      `;
    }).join('');
  }

  function renderList(videos) {
    listCount.textContent = videos.length;
    if (!videos.length) {
      listGrid.innerHTML = '';
      listGrid.appendChild(listEmpty);
      listEmpty.hidden = false;
      return;
    }
    listEmpty.hidden = true;
    listGrid.innerHTML = videos.map((v) => `
      <article class="admin__video ${v.active ? '' : 'is-inactive'}" data-vid="${esc(v.id)}">
        <div class="admin__video-preview">
          <video src="${esc(v.video_url)}" muted preload="metadata" playsinline></video>
          <span class="admin__video-cat">${CATEGORY_LABELS[v.category] || v.category}</span>
          <span class="admin__video-dur">${Number(v.duration_sec || 0).toFixed(1)}s</span>
        </div>
        <div class="admin__video-body">
          <div class="admin__video-title">${esc(v.title)}</div>
          <div class="admin__video-meta">
            ${v.source_model ? esc(v.source_model) + ' · ' : ''}${v.width || '?'}×${v.height || '?'} · ${fmtSize(v.file_size)} · ${esc(fmtDate(v.created_at))}
            <br>사용 ${v.usage_count}회${v.last_used_at ? ' · 최근 ' + esc(fmtDate(v.last_used_at)) : ''}
          </div>
          ${v.notes ? `<div class="admin__video-notes">${esc(v.notes)}</div>` : ''}
        </div>
        <div class="admin__video-actions">
          <button class="admin__btn admin__btn--toggle" data-action="toggle">${v.active ? '✓ 활성' : '○ 비활성'}</button>
          <a class="admin__btn" href="${esc(v.video_url)}" target="_blank" rel="noopener">보기</a>
          <button class="admin__btn admin__btn--danger" data-action="delete">삭제</button>
        </div>
      </article>
    `).join('');

    // 동적 이벤트 바인딩
    listGrid.querySelectorAll('.admin__video').forEach((card) => {
      const id = card.dataset.vid;
      card.querySelector('[data-action="toggle"]').addEventListener('click', () => toggleActive(id, card));
      card.querySelector('[data-action="delete"]').addEventListener('click', () => deleteVideo(id, card));
    });
  }

  async function toggleActive(id, card) {
    const isActive = !card.classList.contains('is-inactive');
    const newState = !isActive;
    const btn = card.querySelector('[data-action="toggle"]');
    btn.disabled = true;
    try {
      const r = await fetch('/api/admin-hook-videos?id=' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: newState }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(j.error || '실패');
      } else {
        card.classList.toggle('is-inactive', !newState);
        btn.textContent = newState ? '✓ 활성' : '○ 비활성';
        loadList();  // 요약 갱신
      }
    } catch (e) {
      alert('네트워크 오류: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  }

  async function deleteVideo(id, card) {
    if (!confirm('이 영상을 영구 삭제하시겠어요? (Storage 파일 + DB row)')) return;
    try {
      const r = await fetch('/api/admin-hook-videos?id=' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: authHeaders,
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(j.error || '삭제 실패');
      } else {
        card.remove();
        loadList();
      }
    } catch (e) {
      alert('네트워크 오류: ' + e.message);
    }
  }

  // ─────────── 영상 metadata 추출 (브라우저 native) ───────────
  function extractVideoMetadata(file) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      const url = URL.createObjectURL(file);
      const cleanup = () => { URL.revokeObjectURL(url); };
      const timeout = setTimeout(() => {
        cleanup();
        resolve({ duration: 0, width: 0, height: 0 });
      }, 10_000);
      video.addEventListener('loadedmetadata', () => {
        clearTimeout(timeout);
        const out = {
          duration: Number(video.duration) || 0,
          width: video.videoWidth || 0,
          height: video.videoHeight || 0,
        };
        cleanup();
        resolve(out);
      });
      video.addEventListener('error', () => {
        clearTimeout(timeout);
        cleanup();
        resolve({ duration: 0, width: 0, height: 0 });
      });
      video.src = url;
    });
  }

  // ─────────── 파일 선택 시 미리보기 ───────────
  fileEl.addEventListener('change', async () => {
    const file = fileEl.files && fileEl.files[0];
    if (!file) { fileInfoEl.textContent = ''; return; }
    if (file.size > 50 * 1024 * 1024) {
      showErr('50MB 초과 파일. Sora/Veo 영상은 보통 1~7MB 이라 다시 확인해주세요.');
      fileEl.value = '';
      fileInfoEl.textContent = '';
      return;
    }
    clearErr();
    fileInfoEl.textContent = `${file.name} · ${fmtSize(file.size)} · 메타 분석 중…`;
    const meta = await extractVideoMetadata(file);
    fileInfoEl.textContent = `${file.name} · ${fmtSize(file.size)} · ${meta.duration.toFixed(1)}s · ${meta.width}×${meta.height}`;
    // 결과를 form 에 보관
    fileEl.dataset.duration = String(meta.duration);
    fileEl.dataset.width = String(meta.width);
    fileEl.dataset.height = String(meta.height);
  });

  // ─────────── 업로드 ───────────
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    clearErr();

    const file = fileEl.files && fileEl.files[0];
    if (!file) { showErr('영상 파일을 선택해주세요.'); return; }

    const fd = new FormData(form);
    const category = String(fd.get('category') || 'general');
    const title = String(fd.get('title') || '').trim();
    const sourceModel = String(fd.get('source_model') || '');
    const prompt = String(fd.get('prompt') || '').trim();
    const notes = String(fd.get('notes') || '').trim();
    if (!title) { showErr('제목을 입력해주세요.'); return; }

    const duration = Number(fileEl.dataset.duration || 0);
    const width = Number(fileEl.dataset.width || 0);
    const height = Number(fileEl.dataset.height || 0);
    if (duration <= 0) { showErr('영상 길이를 추출하지 못했어요. 다른 mp4 로 시도해주세요.'); return; }

    submitBtn.disabled = true;
    try {
      // 1) signed upload URL 발급
      showProgress(5, 'signed URL 발급 중…');
      const urlRes = await fetch('/api/admin-hook-videos', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'request_upload_url',
          filename: file.name,
          contentType: file.type || 'video/mp4',
          category,
        }),
      });
      const urlData = await urlRes.json().catch(() => ({}));
      if (!urlRes.ok || !urlData.uploadUrl) {
        throw new Error(urlData.error || 'signed URL 발급 실패');
      }

      // 2) 직접 PUT 업로드 (Storage)
      showProgress(15, 'Supabase Storage 업로드 중…');
      const putRes = await uploadWithProgress(urlData.uploadUrl, file);
      if (!putRes.ok) throw new Error('Storage 업로드 실패 (status ' + putRes.status + ')');

      // 3) metadata insert
      showProgress(90, 'DB row 등록 중…');
      const insRes = await fetch('/api/admin-hook-videos', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'insert',
          category,
          title,
          source_model: sourceModel,
          prompt: prompt || null,
          notes: notes || null,
          video_url: urlData.publicUrl,
          duration_sec: duration,
          width,
          height,
          file_size: file.size,
        }),
      });
      const insData = await insRes.json().catch(() => ({}));
      if (!insRes.ok || !insData.ok) throw new Error(insData.error || 'DB 등록 실패');

      showProgress(100, '✓ 업로드 완료!');
      form.reset();
      fileInfoEl.textContent = '';
      delete fileEl.dataset.duration;
      delete fileEl.dataset.width;
      delete fileEl.dataset.height;
      setTimeout(() => { hideProgress(); }, 1500);
      loadList();  // 새 row 포함해서 다시 그리기
    } catch (e) {
      hideProgress();
      showErr(e.message || '업로드 실패');
    } finally {
      submitBtn.disabled = false;
    }
  });

  // PUT 업로드 (진행률 표시)
  function uploadWithProgress(url, file) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');
      xhr.upload.addEventListener('progress', (ev) => {
        if (ev.lengthComputable) {
          const pct = 15 + (ev.loaded / ev.total) * 70;  // 15~85%
          showProgress(pct, `업로드 중… ${(ev.loaded / 1024 / 1024).toFixed(1)} / ${(ev.total / 1024 / 1024).toFixed(1)} MB`);
        }
      });
      xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status });
      xhr.onerror = () => reject(new Error('네트워크 오류'));
      xhr.send(file);
    });
  }

  // ─────────── 시작 ───────────
  loadList();
})();
