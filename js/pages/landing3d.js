// landing3d.js — 3D 리빌드 프로토타입 씬.
// 컨셉: "잘되는 가게" 게시물 카드를 루미가 스캔 → 비결 칩이 튀어나와 →
//        "내 가게" 카드로 날아가 조립 → 내 카드가 완성된다. (주기능 루프의 물성화)
// 원칙: 밝은 무대(다크 금지), MeshBasic + 캔버스 텍스처만 — 모바일에서 가볍게.
// 디버그: window.__l3dSetProgress(0~1) 로 스크롤 없이 장면 확인 가능.

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.module.js';

const canvas = document.querySelector('[data-l3d-canvas]');
const fallbackEl = document.querySelector('[data-l3d-fallback]');
const beats = [...document.querySelectorAll('.l3d-beat')];

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function showFallback() {
  if (fallbackEl) fallbackEl.hidden = false;
  if (canvas) canvas.style.display = 'none';
  const track = document.querySelector('[data-l3d-track]');
  if (track) track.style.display = 'none';
}

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
} catch (e) {
  showFallback();
  throw e;
}
if (reduced) { showFallback(); throw new Error('reduced-motion'); }

renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 10);

const world = new THREE.Group(); // 포인터 패럴럭스용 루트
scene.add(world);

// ───────────────────────── 텍스처 공방 (캔버스 드로잉) ─────────────────────────
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeCardTexture({ photo, handle, mode }) {
  // mode: 'theirs' | 'empty' | 'done'
  const W = 768, H = 960, R = 44;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');

  // 카드 본체
  roundRectPath(x, 6, 6, W - 12, H - 12, R);
  x.fillStyle = '#ffffff';
  x.fill();
  x.lineWidth = 2.5;
  x.strokeStyle = mode === 'done' ? '#ffb3c6' : '#f1e4e9';
  x.stroke();

  // 헤더: 아바타 + 핸들
  const headY = 44;
  x.beginPath();
  x.arc(64, headY + 22, 22, 0, Math.PI * 2);
  const av = x.createLinearGradient(40, headY, 90, headY + 44);
  av.addColorStop(0, mode === 'theirs' ? '#ffd166' : '#ff8ba7');
  av.addColorStop(1, mode === 'theirs' ? '#ff8ba7' : '#ffb86b');
  x.fillStyle = av;
  x.fill();
  x.fillStyle = '#3c3137';
  x.font = '700 30px "Pretendard Variable", Pretendard, -apple-system, sans-serif';
  x.fillText(handle, 102, headY + 32);

  // 사진 영역
  const pY = 104, pH = 520;
  roundRectPath(x, 36, pY, W - 72, pH, 28);
  if (mode === 'empty') {
    x.save();
    x.clip();
    x.fillStyle = '#faf4f6';
    x.fillRect(36, pY, W - 72, pH);
    x.restore();
    x.setLineDash([14, 12]);
    x.lineWidth = 3;
    x.strokeStyle = '#e8d3da';
    roundRectPath(x, 36, pY, W - 72, pH, 28);
    x.stroke();
    x.setLineDash([]);
    x.fillStyle = '#cbb6bf';
    x.font = '600 30px "Pretendard Variable", Pretendard, -apple-system, sans-serif';
    x.textAlign = 'center';
    x.fillText('아직 비어 있어요', W / 2, pY + pH / 2 + 10);
    x.textAlign = 'left';
  } else {
    x.save();
    x.clip();
    const iw = photo.naturalWidth, ih = photo.naturalHeight;
    const s = Math.max((W - 72) / iw, pH / ih);
    x.drawImage(photo, 36 + ((W - 72) - iw * s) / 2, pY + (pH - ih * s) / 2, iw * s, ih * s);
    x.restore();
  }

  // 캡션 줄 (회색 바)
  const capY = pY + pH + 40;
  x.fillStyle = mode === 'empty' ? '#f3e9ed' : '#efe3e8';
  roundRectPath(x, 40, capY, W - 240, 22, 11); x.fill();
  roundRectPath(x, 40, capY + 40, W - 130, 22, 11); x.fill();
  roundRectPath(x, 40, capY + 80, W - 320, 22, 11); x.fill();

  // 해시태그 칩 (theirs/done 만)
  if (mode !== 'empty') {
    const tags = mode === 'theirs' ? ['#소금빵', '#성수카페'] : ['#소금빵', '#우리가게'];
    let tx = 40;
    const ty = capY + 134;
    x.font = '700 24px "Pretendard Variable", Pretendard, -apple-system, sans-serif';
    for (const t of tags) {
      const tw = x.measureText(t).width + 44;
      roundRectPath(x, tx, ty, tw, 46, 23);
      x.fillStyle = '#ffe9f0';
      x.fill();
      x.fillStyle = '#ff5c8a';
      x.fillText(t, tx + 22, ty + 32);
      tx += tw + 14;
    }
  }

  // 상태 배지
  if (mode === 'theirs') {
    x.font = '700 24px "Pretendard Variable", Pretendard, -apple-system, sans-serif';
    const label = '잘되는 가게';
    const bw = x.measureText(label).width + 48;
    roundRectPath(x, W - 36 - bw, 38, bw, 48, 24);
    x.fillStyle = '#fff3d6';
    x.fill();
    x.fillStyle = '#b07b1f';
    x.fillText(label, W - 36 - bw + 24, 71);
  }
  if (mode === 'done') {
    x.font = '700 24px "Pretendard Variable", Pretendard, -apple-system, sans-serif';
    const label = '✓ 게시 완료';
    const bw = x.measureText(label).width + 48;
    roundRectPath(x, W - 36 - bw, 38, bw, 48, 24);
    x.fillStyle = '#e8f5ee';
    x.fill();
    x.fillStyle = '#00713c';
    x.fillText(label, W - 36 - bw + 24, 71);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeChipTexture(label) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 160;
  const x = c.getContext('2d');
  x.font = '800 56px "Pretendard Variable", Pretendard, -apple-system, sans-serif';
  const tw = x.measureText(label).width;
  const w = Math.min(500, tw + 96);
  const ox = (512 - w) / 2;
  roundRectPath(x, ox + 4, 24, w - 8, 112, 56);
  x.fillStyle = '#ffffff';
  x.fill();
  x.lineWidth = 5;
  x.strokeStyle = '#ffc2d2';
  x.stroke();
  x.fillStyle = '#ff4d80';
  x.font = '800 56px "Pretendard Variable", Pretendard, -apple-system, sans-serif';
  x.textAlign = 'center';
  x.fillText(label, 256, 100);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeSoftShadowTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(128, 128, 10, 128, 128, 120);
  g.addColorStop(0, 'rgba(180, 110, 135, 0.34)');
  g.addColorStop(1, 'rgba(180, 110, 135, 0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(256, 256, 60, 256, 256, 250);
  g.addColorStop(0, 'rgba(255, 140, 170, 0.55)');
  g.addColorStop(0.55, 'rgba(255, 180, 150, 0.22)');
  g.addColorStop(1, 'rgba(255, 180, 150, 0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 512, 512);
  return new THREE.CanvasTexture(c);
}

function makeScanTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, 'rgba(255, 92, 138, 0)');
  g.addColorStop(0.5, 'rgba(255, 92, 138, 0.85)');
  g.addColorStop(1, 'rgba(255, 92, 138, 0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 256, 64);
  return new THREE.CanvasTexture(c);
}

// ───────────────────────── 사진 로드 → 씬 구성 ─────────────────────────
function loadImg(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = src;
  });
}

const CARD_W = 3.0, CARD_H = 3.75;
const isMobile = window.innerWidth < 760;

function cardMesh(tex) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(CARD_W, CARD_H),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true })
  );
  return m;
}

let theirs, mineEmpty, mineDone, scan, glow, chips = [], shadows = [];
const clock = new THREE.Clock();
let progress = 0, manualProgress = null;

Promise.all([
  loadImg('/assets/3d/salt-bread.jpg'), // Higgsfield 생성 — 칩(#소금빵)과 스토리 일치
  loadImg('/assets/tutorial/cafe-2.jpg'),
  document.fonts ? document.fonts.ready : Promise.resolve(),
]).then(([ph1, ph2]) => {
  const shadowTex = makeSoftShadowTexture();

  // 잘되는 가게 카드
  theirs = cardMesh(makeCardTexture({ photo: ph1, handle: '@jaldweneun.gage', mode: 'theirs' }));
  world.add(theirs);

  // 내 가게 카드 (빈 상태 + 완성 상태 겹침 — 크로스페이드)
  mineEmpty = cardMesh(makeCardTexture({ photo: null, handle: '@my.gage', mode: 'empty' }));
  mineDone = cardMesh(makeCardTexture({ photo: ph2, handle: '@my.gage', mode: 'done' }));
  mineDone.material.opacity = 0;
  mineDone.position.z = 0.012; // z-fighting 방지
  const mine = new THREE.Group();
  mine.add(mineEmpty); mine.add(mineDone);
  world.add(mine);
  world.userData.mine = mine;

  // 부드러운 그림자
  for (const target of [theirs, mine]) {
    const sh = new THREE.Mesh(
      new THREE.PlaneGeometry(CARD_W * 1.5, CARD_W * 1.5),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })
    );
    sh.userData.follow = target;
    shadows.push(sh);
    world.add(sh);
  }

  // 스캔 바
  scan = new THREE.Mesh(
    new THREE.PlaneGeometry(CARD_W * 1.06, 0.5),
    new THREE.MeshBasicMaterial({ map: makeScanTexture(), transparent: true, depthWrite: false })
  );
  scan.material.opacity = 0;
  world.add(scan);

  // 완성 글로우
  glow = new THREE.Mesh(
    new THREE.PlaneGeometry(7, 7),
    new THREE.MeshBasicMaterial({ map: makeGlowTexture(), transparent: true, depthWrite: false })
  );
  glow.material.opacity = 0;
  world.add(glow);

  // 비결 칩 4종
  const labels = ['화 12시', '여러 장 77%', '#소금빵', '참여율 13.8%'];
  chips = labels.map((label) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 0.5),
      new THREE.MeshBasicMaterial({ map: makeChipTexture(label), transparent: true, depthWrite: false })
    );
    m.material.opacity = 0;
    world.add(m);
    return m;
  });

  tick();
}).catch((e) => {
  console.warn('[l3d] 텍스처 로드 실패:', e);
  showFallback();
});

// ───────────────────────── 타임라인 유틸 ─────────────────────────
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (t) => t * t * (3 - 2 * t);
const seg = (p, a, b) => smooth(clamp01((p - a) / (b - a)));

// 포인터 패럴럭스
let px = 0, py = 0;
window.addEventListener('pointermove', (e) => {
  px = (e.clientX / window.innerWidth - 0.5) * 2;
  py = (e.clientY / window.innerHeight - 0.5) * 2;
}, { passive: true });

function getScrollProgress() {
  const doc = document.documentElement;
  const max = doc.scrollHeight - window.innerHeight;
  return max > 0 ? clamp01(window.scrollY / max) : 0;
}

// 비트 텍스트 토글
const BEAT_RANGES = [[0, 0.15], [0.21, 0.45], [0.51, 0.72], [0.79, 1.01]];
function updateBeats(p) {
  beats.forEach((el, i) => {
    const [a, b] = BEAT_RANGES[i];
    el.classList.toggle('is-on', p >= a && p < b);
  });
}

// ───────────────────────── 메인 타임라인 ─────────────────────────
function layout(p, t) {
  const mine = world.userData.mine;
  const mob = isMobile;

  // 인트로 배치 → 분석 → 이식 → 피날레
  const s1 = seg(p, 0.18, 0.44);  // 스캔
  const s2 = seg(p, 0.48, 0.72);  // 이식
  const s3 = seg(p, 0.76, 0.96);  // 피날레

  const float = (1 - s3 * 0.85);  // 끝으로 갈수록 차분히

  // 잘되는 가게 카드: 중앙 → (피날레) 왼쪽 뒤로
  const thX = mob ? lerp(-0.32, -1.7, s3) : lerp(-1.45, -3.1, s3);
  const thY = Math.sin(t * 0.8) * 0.06 * float + lerp(mob ? 0.95 : 0.1, mob ? 1.25 : 0.4, s3);
  const thZ = lerp(0, -1.6, s3);
  theirs.position.set(thX, thY, thZ);
  theirs.rotation.y = lerp(0.16, 0.05, s1) + lerp(0, 0.5, s3) + px * 0.04;
  theirs.rotation.z = lerp(-0.02, 0, s1);
  theirs.material.opacity = lerp(1, 0.55, s3);

  // 내 가게 카드: 옆에 작게 → 중앙 크게
  const miX = mob ? lerp(0.42, 0, s2) : lerp(1.85, 0.15, s2);
  const miY = Math.sin(t * 0.8 + 1.7) * 0.06 * float + lerp(mob ? -2.9 : -0.25, mob ? 1.2 : 0.3, s2) + lerp(0, mob ? 0.05 : 0.4, s3);
  const miZ = lerp(-1.4, 0.6, s2) + lerp(0, 0.7, s3);
  mine.position.set(miX, miY, miZ);
  mine.rotation.y = lerp(-0.22, -0.04, s2) + px * 0.05;
  const miS = lerp(0.84, 0.94, s2) * lerp(1, 1.02, s3);
  mine.scale.setScalar(miS);
  mineDone.material.opacity = s2;
  mineEmpty.material.opacity = 1 - s2 * 0.92;

  // 그림자 따라가기
  for (const sh of shadows) {
    const tg = sh.userData.follow;
    const pos = tg === theirs ? theirs.position : mine.position;
    sh.position.set(pos.x, pos.y - CARD_H * 0.62, pos.z - 0.4);
    sh.material.opacity = tg === theirs ? lerp(0.9, 0.35, s3) : lerp(0.5, 1, s2);
  }

  // 스캔 바: s1 동안 카드 위→아래 스윕
  if (s1 > 0 && s1 < 1) {
    scan.material.opacity = Math.sin(s1 * Math.PI);
    scan.position.set(thX, thY + CARD_H / 2 - s1 * CARD_H, thZ + 0.05);
    scan.rotation.y = theirs.rotation.y;
  } else {
    scan.material.opacity = 0;
  }

  // 칩: 스캔 후 등장 → 호버 → 내 카드로 비행 → 흡수
  chips.forEach((chip, i) => {
    const born = seg(p, 0.24 + i * 0.045, 0.30 + i * 0.045); // 등장
    const fly = seg(p, 0.50 + i * 0.04, 0.62 + i * 0.04);     // 비행
    const sink = seg(p, 0.62 + i * 0.04, 0.68 + i * 0.04);    // 흡수

    if (born <= 0) { chip.material.opacity = 0; return; }

    // 출발지: theirs 카드 오른쪽 가장자리 주변 (지그재그)
    const homeX = thX + (mob ? 0.95 : 1.95) + (i % 2) * 0.35;
    const homeY = thY + 1.05 - i * 0.62 + Math.sin(t * 1.3 + i) * 0.05 * (1 - fly);
    const homeZ = thZ + 0.7;
    // 도착지: mine 카드 표면
    const dstX = miX + (i % 2 ? 0.34 : -0.3);
    const dstY = miY + 0.85 - i * 0.5;
    const dstZ = miZ + 0.35;
    // 베지어 비행 (위로 봉긋한 아치)
    const arc = Math.sin(fly * Math.PI) * 0.85;
    chip.position.set(
      lerp(homeX, dstX, fly),
      lerp(homeY, dstY, fly) + arc,
      lerp(homeZ, dstZ, fly)
    );
    const pop = 0.7 + born * 0.3;
    chip.scale.setScalar(pop * (1 - sink * 0.85));
    chip.material.opacity = born * (1 - sink);
    chip.rotation.y = px * 0.06;
  });

  // 피날레 글로우
  glow.position.set(mine.position.x, mine.position.y, mine.position.z - 0.8);
  glow.material.opacity = s3 * (0.75 + Math.sin(t * 2.2) * 0.1);
  glow.scale.setScalar(0.8 + s3 * 0.5);

  // 카메라: 살짝 다가가며 시점 이동 + 패럴럭스
  camera.position.x = lerp(0, mob ? 0 : 0.4, s2) + px * 0.18;
  camera.position.y = -py * 0.14;
  camera.position.z = lerp(10, 9.1, s1) - s3 * 0.5 + (mob ? 1.8 : 0);
  camera.lookAt(lerp(0, mine ? mine.position.x * 0.5 : 0, s2), 0, 0);
}

function tick() {
  const t = clock.getElapsedTime();
  progress = manualProgress != null ? manualProgress : getScrollProgress();
  updateBeats(progress);
  layout(progress, t);
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// 디버그 훅 (프리뷰 검증·시연용)
window.__l3dSetProgress = (p) => {
  manualProgress = (typeof p === 'number') ? clamp01(p) : null;
  if (theirs) { updateBeats(progress = manualProgress ?? getScrollProgress()); layout(progress, clock.getElapsedTime()); renderer.render(scene, camera); }
  return progress;
};
